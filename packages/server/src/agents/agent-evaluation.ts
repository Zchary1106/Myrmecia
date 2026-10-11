import { createHash } from 'node:crypto';
import type { AgentEvaluationRun, AgentEvaluationCaseResult } from '../types.js';
import { getDb } from '../db/database.js';
import { getAgent } from '../db/models/agent.js';
import { getTask, createTask } from '../db/models/task.js';
import { listExecutions } from '../db/models/execution.js';
import { getAgentConfigVersion, configChecksum, validateConfigReferences, versionAsAgent } from '../db/models/agent-config-version.js';
import { getEvaluationRun, setEvaluationCaseResult, evaluationTaskEntry, type EvaluationScope } from '../db/models/agent-evaluation.js';
import { pinAgentSetup, getAgentSetupSnapshot } from './agent-setup-snapshot.js';
import { persistExecutionContext } from './execution-context.js';
import { preflightAgent } from './agent-setup.js';
import { HttpError } from '../routes/http.js';
import { MAX_EVALUATION_OUTPUT_BYTES } from './completion-json-schema.js';
import { completionEvidenceIsFresh } from './completion-gate.js';
import { canAcceptAgentOutput } from '@myrmecia/shared';
import type { TaskQueue } from '../queue/task-queue.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const terminal = (result: AgentEvaluationCaseResult) => ['passed', 'failed', 'unavailable'].includes(result.status);

/** Stores server verifier receipts only; never executes a model/tool on a result read. */
export function collectEvaluationTask(taskId: string): void {
  const entry = evaluationTaskEntry(taskId);
  if (!entry || terminal(entry.result)) return;
  const { run, result } = entry;
  const task = getTask(taskId);
  if (!task || task.workspaceId !== run.workspaceId || task.assigneeId !== run.agentId) {
    finish({ ...result, status: 'failed', message: 'Evaluation task missing or scope changed' }); return;
  }
  const execution = listExecutions({ taskId })[0];
  if (!['done', 'failed', 'cancelled'].includes(task.status)) {
    if (task.status !== 'pending' && result.status === 'pending') setEvaluationCaseResult(run.id, { ...result, status: 'running' });
    return;
  }
  const test = run.suiteSnapshot.cases.find(item => item.id === result.caseId)!;
  const verification = execution?.runState?.verification;
  const snapshot = getAgentSetupSnapshot(taskId);
  const output = task.output || '';
  const bounded = Buffer.byteLength(output) <= MAX_EVALUATION_OUTPUT_BYTES;
  const valid = !!verification && execution?.agentDefId === run.agentId && execution.workspaceId === run.workspaceId
    && snapshot?.versionId === run.configVersionId && snapshot.configHash === run.configHash
    && configChecksum(run.suiteSnapshot) === run.suiteHash
    && verification.criteria.length === test.checks.length
    && verification.contractSha256 === sha(JSON.stringify(test.checks))
    && configChecksum(task.completionCriteria) === configChecksum(test.checks)
    && test.checks.every(check => verification.criteria.some(item => item.criterionId === check.id
      && item.required === check.required && item.verifier === check.verifier));
  const missingEvidence = verification && execution && !completionEvidenceIsFresh(task, execution.id, verification);
  const status = !valid || missingEvidence || !output.trim() || !bounded ? 'failed'
    : verification.status === 'failed' ? 'failed'
      : verification.status === 'unavailable' ? 'unavailable'
        : task.status === 'done' && verification.status === 'passed' && execution && canAcceptAgentOutput(execution, task) ? 'passed' : 'failed';
  const provider = execution?.provider;
  finish({ ...result, status, executionId: execution?.id, verification,
    output: bounded ? output : undefined, outputSha256: sha(output),
    requestedModel: task.modelId, actualModel: execution?.actualModelId,
    provider, transport: provider && /fixture|scripted|mock/i.test(provider) ? 'fixture' : provider ? 'real_model' : 'unknown',
    message: !bounded ? 'Output exceeds evaluation limit; open the task for full output'
      : !valid ? 'No matching server verifier receipt; execution success alone is not a pass'
        : missingEvidence ? 'Mandatory verifier evidence missing' : task.error || undefined });
  function finish(value: AgentEvaluationCaseResult): void {
    const checked = { ...value, checkedAt: new Date().toISOString() };
    setEvaluationCaseResult(run.id, { ...checked, resultSha256: configChecksum(checked) });
  }
}
export function refreshEvaluationRun(id: string, scope: EvaluationScope): AgentEvaluationRun {
  const run = getEvaluationRun(id, scope);
  if (!run) throw new HttpError(404, 'EVALUATION_RUN_NOT_FOUND', 'Evaluation run not found');
  for (const result of run.results) if (result.taskId && !terminal(result)) collectEvaluationTask(result.taskId);
  return getEvaluationRun(id, scope)!;
}

/** Explicitly advances one selected case. Replays return its existing identity,
 * never create the next case or rerun a terminal case. No restart auto-advance. */
export async function dispatchEvaluationCase(runId: string, caseId: string, scope: EvaluationScope, queue: Pick<TaskQueue, 'dispatchExisting'>): Promise<AgentEvaluationRun> {
  refreshEvaluationRun(runId, scope);
  const entity = getDb().transaction(() => {
    const run = getEvaluationRun(runId, scope)!;
    const result = run.results.find(item => item.caseId === caseId);
    if (!result) throw new HttpError(400, 'EVALUATION_CASE_NOT_SELECTED', 'Case was not selected for this run');
    if (result.taskId || terminal(result)) return { result, replayed: true };
    // Serialize cases across every run of this suite, including different actors.
    const active = getDb().all<{ task_id: string }>(`SELECT c.task_id FROM agent_evaluation_case_results c
      JOIN agent_evaluation_runs r ON r.id = c.run_id WHERE r.workspace_id = ? AND r.agent_id = ? AND r.suite_id = ? AND c.task_id IS NOT NULL`,
    scope.workspaceId, scope.agentId, run.suiteId).some(item => {
      const task = getTask(item.task_id); return !!task && !['done', 'failed', 'cancelled'].includes(task.status);
    });
    if (active) throw new HttpError(409, 'EVALUATION_CASE_RUNNING', 'Wait for the current case before starting another');
    const firstPending = run.results.find(item => !terminal(item));
    if (firstPending?.caseId !== caseId) throw new HttpError(409, 'EVALUATION_CASE_ORDER', 'Run selected cases sequentially');
    const version = getAgentConfigVersion(run.configVersionId, scope.agentId, scope.workspaceId);
    const agent = getAgent(scope.agentId);
    if (!version || !agent || version.configHash !== run.configHash || configChecksum(version.snapshot) !== run.configHash
      || configChecksum(run.suiteSnapshot) !== run.suiteHash) throw new HttpError(409, 'CONFIG_INTEGRITY_FAILED', 'Pinned evaluation revision unavailable');
    validateConfigReferences(version.snapshot, scope.workspaceId);
    const effective = versionAsAgent(version, agent);
    const preflight = preflightAgent(effective, version.snapshot.skill?.source === 'file' ? undefined : version.snapshot.skill?.versionId);
    if (!preflight.canTest) throw new HttpError(409, 'AGENT_NOT_READY', 'Resolve blocking checks before evaluation', preflight);
    const test = run.suiteSnapshot.cases.find(item => item.id === caseId)!;
    const task = createTask({ title: `Evaluation: ${test.name}`, description: test.prompt, input: test.prompt,
      mode: 'direct', assigneeId: scope.agentId, workspaceId: scope.workspaceId, createdBy: 'user',
      modelId: effective.model || effective.config.model, maxRetries: 0, completionCriteria: test.checks });
    pinAgentSetup(task.id, agent, true, version.id);
    persistExecutionContext(task);
    const next: AgentEvaluationCaseResult = { ...result, taskId: task.id };
    setEvaluationCaseResult(run.id, next);
    return { result: next, replayed: false };
  });
  // Re-dispatching an uncertain pending submission uses the same task; normal
  // queue state/capacity/ownership guards suppress duplicate execution.
  if (entity.result.taskId && !terminal(entity.result)) await queue.dispatchExisting(entity.result.taskId);
  return refreshEvaluationRun(runId, scope);
}
