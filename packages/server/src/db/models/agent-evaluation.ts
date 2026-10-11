import { randomUUID } from 'node:crypto';
import type { AgentEvaluationSuite, AgentEvaluationSuiteInput, AgentEvaluationRun, AgentEvaluationCaseResult } from '../../types.js';
import { getDb } from '../database.js';
import { configChecksum, getAgentConfigVersion } from './agent-config-version.js';
import { HttpError } from '../../routes/http.js';
import { evaluationSuiteSchema, evaluationStartSchema } from '../../agents/agent-evaluation-schema.js';
import { scanForPII } from '../../security/dlp.js';

export interface EvaluationScope { workspaceId: string; actorId: string; agentId: string }
function scopedAgent(scope: EvaluationScope): void {
  if (!getDb().get('SELECT id FROM agents WHERE id = ? AND workspace_id = ?', scope.agentId, scope.workspaceId)) {
    throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent not found');
  }
}
export function getEvaluationSuite(id: string, scope: EvaluationScope): AgentEvaluationSuite | undefined {
  const row = getDb().get<{ body: string }>(`SELECT body FROM agent_evaluation_suites
    WHERE id = ? AND workspace_id = ? AND actor_id = ? AND agent_id = ?`, id, scope.workspaceId, scope.actorId, scope.agentId);
  return row ? JSON.parse(row.body) : undefined;
}
export function listEvaluationSuites(scope: EvaluationScope): AgentEvaluationSuite[] {
  scopedAgent(scope);
  return getDb().all<{ body: string }>(`SELECT body FROM agent_evaluation_suites
    WHERE workspace_id = ? AND actor_id = ? AND agent_id = ? ORDER BY rowid DESC LIMIT 100`,
  scope.workspaceId, scope.actorId, scope.agentId).map(row => JSON.parse(row.body));
}
export function saveEvaluationSuite(id: string, scope: EvaluationScope, input: AgentEvaluationSuiteInput, expectedRevision: number): AgentEvaluationSuite {
  scopedAgent(scope);
  const body = evaluationSuiteSchema.parse(input);
  if (scanForPII(JSON.stringify(body)).violations.some(item => ['api_key', 'aws_key', 'private_key'].includes(item.type))) {
    throw new HttpError(400, 'EVALUATION_CONTAINS_CREDENTIALS', 'Use provider references, not credentials in evaluation cases');
  }
  return getDb().transaction(() => {
    const existing = getEvaluationSuite(id, scope);
    // A UUID owned by another actor/workspace must not be overwritten.
    if (!existing && getDb().get('SELECT id FROM agent_evaluation_suites WHERE id = ?', id)) {
      throw new HttpError(404, 'EVALUATION_SUITE_NOT_FOUND', 'Suite not found');
    }
    const hash = configChecksum(body);
    if (existing && existing.hash === hash && [existing.revision, existing.revision - 1].includes(expectedRevision)) return existing;
    if ((existing?.revision || 0) !== expectedRevision) throw new HttpError(409, 'EVALUATION_SUITE_CONFLICT', 'Suite changed; reload before saving');
    const now = new Date().toISOString();
    const suite: AgentEvaluationSuite = { ...body, ...scope, schemaVersion: 1, id,
      revision: (existing?.revision || 0) + 1, hash, createdAt: existing?.createdAt || now, updatedAt: now };
    getDb().run(`INSERT INTO agent_evaluation_suites(id, workspace_id, actor_id, agent_id, revision, body)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, body = excluded.body`,
    id, scope.workspaceId, scope.actorId, scope.agentId, suite.revision, JSON.stringify(suite));
    return suite;
  });
}
export function getEvaluationRun(id: string, scope: EvaluationScope): AgentEvaluationRun | undefined {
  const row = getDb().get<{ body: string }>(`SELECT body FROM agent_evaluation_runs
    WHERE id = ? AND workspace_id = ? AND actor_id = ? AND agent_id = ?`, id, scope.workspaceId, scope.actorId, scope.agentId);
  if (!row) return undefined;
  const run: AgentEvaluationRun = JSON.parse(row.body);
  run.results = getDb().all<{ body: string }>('SELECT body FROM agent_evaluation_case_results WHERE run_id = ? ORDER BY rowid', id)
    .map(row => JSON.parse(row.body));
  run.counts = { pending: 0, running: 0, passed: 0, failed: 0, unavailable: 0 };
  for (const result of run.results) run.counts[result.status]++;
  return run;
}
export function listEvaluationRuns(scope: EvaluationScope, offset = 0): AgentEvaluationRun[] {
  return getDb().all<{ id: string }>(`SELECT id FROM agent_evaluation_runs
    WHERE workspace_id = ? AND actor_id = ? AND agent_id = ? ORDER BY rowid DESC LIMIT 30 OFFSET ?`,
  scope.workspaceId, scope.actorId, scope.agentId, offset).map(row => getEvaluationRun(row.id, scope)!);
}
/** History lists carry attribution/counts, not every model output and receipt.
 * Full evidence is read explicitly for the selected run. */
export function evaluationRunSummary(run: AgentEvaluationRun): AgentEvaluationRun {
  return { ...run, results: run.results.map(({ output: _output, verification: _verification, ...result }) => result) };
}
export function createEvaluationRun(scope: EvaluationScope, suiteId: string, key: string, request: {
  expectedSuiteRevision: number; selectedCaseIds: string[]; configVersionId: string;
}): { run: AgentEvaluationRun; replayed: boolean } {
  scopedAgent(scope);
  request = evaluationStartSchema.parse(request);
  if (!/^[a-zA-Z0-9._:-]{8,120}$/.test(key)) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A stable evaluation request key is required');
  return getDb().transaction(() => {
    const hash = configChecksum(request);
    const prior = getDb().get<{ id: string; request_hash: string }>(`SELECT id, request_hash FROM agent_evaluation_runs
      WHERE workspace_id = ? AND actor_id = ? AND agent_id = ? AND suite_id = ? AND request_key = ?`,
    scope.workspaceId, scope.actorId, scope.agentId, suiteId, key);
    if (prior) {
      if (prior.request_hash !== hash) throw new HttpError(409, 'EVALUATION_REQUEST_CONFLICT', 'Request key was used with different cases or revision');
      return { run: getEvaluationRun(prior.id, scope)!, replayed: true };
    }
    const suite = getEvaluationSuite(suiteId, scope);
    if (!suite) throw new HttpError(404, 'EVALUATION_SUITE_NOT_FOUND', 'Suite not found');
    if (suite.revision !== request.expectedSuiteRevision) throw new HttpError(409, 'EVALUATION_SUITE_CONFLICT', 'Suite changed; reload before running');
    if (request.selectedCaseIds.some(id => !suite.cases.some(item => item.id === id))) throw new HttpError(400, 'EVALUATION_CASE_NOT_FOUND', 'Select saved cases only');
    const version = getAgentConfigVersion(request.configVersionId, scope.agentId, scope.workspaceId);
    if (!version) throw new HttpError(404, 'CONFIG_VERSION_NOT_FOUND', 'Revision not found');
    const id = randomUUID(), now = new Date().toISOString();
    const run: AgentEvaluationRun = { schemaVersion: 1, ...scope, id, suiteId, suiteRevision: suite.revision,
      suiteHash: suite.hash, suiteSnapshot: { name: suite.name, cases: suite.cases }, configVersionId: version.id,
      configSequence: version.sequence, configHash: version.configHash, selectedCaseIds: request.selectedCaseIds,
      createdAt: now, results: [], counts: { pending: request.selectedCaseIds.length, running: 0, passed: 0, failed: 0, unavailable: 0 } };
    getDb().run(`INSERT INTO agent_evaluation_runs(id, workspace_id, actor_id, agent_id, suite_id, request_key, request_hash, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, scope.workspaceId, scope.actorId, scope.agentId, suiteId, key, hash, JSON.stringify(run));
    for (const caseId of request.selectedCaseIds) {
      const test = suite.cases.find(item => item.id === caseId)!;
      setEvaluationCaseResult(id, { caseId, status: 'pending', transport: 'unknown',
        humanReviewRequired: test.checks.some(check => check.verifier === 'human_review') });
    }
    return { run: getEvaluationRun(id, scope)!, replayed: false };
  });
}
export function setEvaluationCaseResult(runId: string, result: AgentEvaluationCaseResult): void {
  const existing = getDb().get<{ body: string }>('SELECT body FROM agent_evaluation_case_results WHERE run_id = ? AND case_id = ?', runId, result.caseId);
  if (existing) {
    const prior: AgentEvaluationCaseResult = JSON.parse(existing.body);
    if (['passed', 'failed', 'unavailable'].includes(prior.status)) return;
    if (prior.taskId && prior.taskId !== result.taskId) throw new HttpError(409, 'EVALUATION_TASK_IDENTITY_CHANGED', 'A case cannot replace its original task');
  }
  getDb().run(`INSERT INTO agent_evaluation_case_results(run_id, case_id, task_id, body) VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id, case_id) DO UPDATE SET task_id = excluded.task_id, body = excluded.body`,
  runId, result.caseId, result.taskId || null, JSON.stringify(result));
}
export function evaluationTaskEntry(taskId: string): { run: AgentEvaluationRun; result: AgentEvaluationCaseResult } | undefined {
  const row = getDb().get<{ run_id: string; body: string }>('SELECT run_id, body FROM agent_evaluation_case_results WHERE task_id = ?', taskId);
  if (!row) return undefined;
  const runRow = getDb().get<{ body: string }>('SELECT body FROM agent_evaluation_runs WHERE id = ?', row.run_id);
  if (!runRow) return undefined;
  const meta: AgentEvaluationRun = JSON.parse(runRow.body);
  return { run: getEvaluationRun(meta.id, meta)!, result: JSON.parse(row.body) };
}
