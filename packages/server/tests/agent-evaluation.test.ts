import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent, getAgent, updateAgent } from '../src/db/models/agent.js';
import { createCustomModel } from '../src/models/model-registry.js';
import { createTask, getTask, updateTask, listTasks } from '../src/db/models/task.js';
import { createExecution, updateExecution, listExecutions } from '../src/db/models/execution.js';
import { persistAgentConfigVersion, configChecksum, activateAgentVersion, agentConfigHistory } from '../src/db/models/agent-config-version.js';
import { getAgentSetupSnapshot } from '../src/agents/agent-setup-snapshot.js';
import { createEvaluationRun, saveEvaluationSuite, getEvaluationSuite, getEvaluationRun, listEvaluationSuites, setEvaluationCaseResult } from '../src/db/models/agent-evaluation.js';
import { dispatchEvaluationCase, refreshEvaluationRun, collectEvaluationTask } from '../src/agents/agent-evaluation.js';
import { completionCriteriaSchema, verifyCompletionCriteria } from '../src/agents/completion-gate.js';
import { evaluationSuiteSchema } from '../src/agents/agent-evaluation-schema.js';
import { initialAgentRunState } from '../src/agents/run-state.js';
import { createAgentRoutes } from '../src/routes/agents.js';
import executionRoutes from '../src/routes/executions.js';
import { AgentRuntime } from '../src/agents/agent-runtime.js';
import { tsAgentLoop } from '../src/agents/ts-agent-loop.js';
import type { AgentEvaluationSuiteInput, CompletionCriterion } from '@myrmecia/shared';
import type { TaskQueue } from '../src/queue/task-queue.js';
import * as sandbox from '../src/skills/tool-sandbox.js';
import { TaskQueue as RuntimeTaskQueue } from '../src/queue/task-queue.js';
import type { AgentManager } from '../src/agents/agent-manager.js';
import { eventBus } from '../src/events/event-bus.js';

let root: string;
beforeEach(() => {
  closeDb(); root = mkdtempSync(join(tmpdir(), 'myrmecia-evaluation-')); vi.stubEnv('DB_PATH', join(root, 'test.sqlite'));
  vi.stubEnv('MYRMECIA_MODEL_PROVIDER', '');
  vi.stubEnv('MODEL_PROVIDERS', JSON.stringify({ default: { baseURL: 'http://fixture.invalid', apiKey: 'fixture-only' } }));
  getDb(); createCustomModel({ id: 'fixture-model', provider: 'default', displayName: 'Fixture' });
});
afterEach(() => { closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const check = (text = 'Expected'): CompletionCriterion => ({ id: 'contains', label: 'Expected output', required: true, verifier: 'output_contains', text });
const input = (): AgentEvaluationSuiteInput => ({ name: 'Saved regression', cases: [
  { id: 'first', name: 'First case', prompt: 'First prompt', checks: [check()] },
  { id: 'second', name: 'Second case', prompt: 'Second prompt', checks: [check()] },
] });
function fixture(body = input()) {
  const agent = createAgent({ name: 'Fixture', role: 'analyst', model: 'fixture-model', config: { systemInstructions: 'Original', maxTurns: 3 } });
  const scope = { workspaceId: 'default', actorId: 'actor-a', agentId: agent.id };
  const version = persistAgentConfigVersion(agent, 'default', 'actor-a', 'task_snapshot');
  const suite = saveEvaluationSuite(randomUUID(), scope, body, 0);
  const request = { selectedCaseIds: body.cases.map(item => item.id), expectedSuiteRevision: suite.revision, configVersionId: version.id };
  const queue = { dispatchExisting: vi.fn(async (id: string) => getTask(id)!) };
  return { agent, scope, version, suite, request, queue };
}
async function complete(taskId: string, output = 'Expected', provider = 'scripted-fixture') {
  const task = getTask(taskId)!;
  const execution = createExecution({ taskId, agentDefId: task.assigneeId!, workspaceId: task.workspaceId, modelId: task.modelId });
  const verification = await verifyCompletionCriteria(task, execution.id, output);
  updateTask(task.id, { output, status: verification.status === 'passed' ? 'done' : 'failed' });
  updateExecution(execution.id, { status: verification.status === 'passed' ? 'done' : 'failed', provider,
    actualModelId: 'actual-fixture', runState: { ...initialAgentRunState(),
      phase: verification.status === 'passed' ? 'completed' : 'failed', stopReason: verification.status === 'passed' ? 'completed' : 'failed',
      validation: { scope: 'output', status: 'passed', checks: [] }, verification } });
  collectEvaluationTask(taskId);
  return execution;
}

describe('saved bounded Agent evaluations', () => {
  it('validates bounds, required checks, unique IDs and safe structural schemas', () => {
    expect(evaluationSuiteSchema.safeParse(input()).success).toBe(true);
    const cases = input().cases;
    expect(evaluationSuiteSchema.safeParse({ name: 'Many', cases: Array.from({ length: 21 }, (_, i) => ({ ...cases[0], id: `${i}` })) }).success).toBe(false);
    expect(evaluationSuiteSchema.safeParse({ name: 'Long', cases: [{ ...cases[0], prompt: 'x'.repeat(8001) }] }).success).toBe(false);
    for (const checks of [[], [{ ...check(), required: false }], Array.from({ length: 21 }, (_, i) => ({ ...check(), id: `${i}` }))]) {
      expect(evaluationSuiteSchema.safeParse({ name: 'Invalid', cases: [{ ...cases[0], checks }] }).success).toBe(false);
    }
    expect(evaluationSuiteSchema.safeParse({ name: 'Duplicates', cases: [cases[0], cases[0]] }).success).toBe(false);
    const base = { id: 'json', label: 'JSON', required: true, verifier: 'output_json_schema' };
    expect(completionCriteriaSchema.safeParse([{ ...base, schema: { type: 'object', properties: { answer: { type: 'string', maxLength: 100 } }, required: ['answer'], additionalProperties: false } }]).success).toBe(true);
    for (const schema of [{ type: 'string', pattern: '(a+)+$' }, { $ref: 'https://invalid/schema' },
      { type: 'array', items: { type: 'string' }, maxItems: 20000 }, { type: 'object', anyOf: [{ type: 'string' }] }]) {
      expect(completionCriteriaSchema.safeParse([{ ...base, schema }]).success).toBe(false);
    }
  });
  it('persists canonical suite revisions, deduplicates uncertain saves and isolates actors/workspaces', () => {
    const f = fixture();
    expect(saveEvaluationSuite(f.suite.id, f.scope, input(), 0).revision).toBe(1);
    const changed = { ...input(), name: 'Updated' };
    expect(saveEvaluationSuite(f.suite.id, f.scope, changed, 1).revision).toBe(2);
    expect(() => saveEvaluationSuite(f.suite.id, f.scope, input(), 1)).toThrow(/changed/);
    expect(getEvaluationSuite(f.suite.id, { ...f.scope, actorId: 'other' })).toBeUndefined();
    expect(() => saveEvaluationSuite(f.suite.id, { ...f.scope, actorId: 'other' }, input(), 0)).toThrow(/not found/);
    expect(() => listEvaluationSuites({ ...f.scope, workspaceId: 'other' })).toThrow(/not found/);
    const credentials = input(); credentials.cases[0].prompt = 'sk-' + 'x'.repeat(40);
    expect(() => saveEvaluationSuite(randomUUID(), f.scope, credentials, 0)).toThrow(/credentials/);
  });
  it('dispatches selected cases only and rejects empty selection or changed request replay', async () => {
    const f = fixture(), key = randomUUID();
    const selected = { ...f.request, selectedCaseIds: ['second'] };
    const entry = createEvaluationRun(f.scope, f.suite.id, key, selected);
    await dispatchEvaluationCase(entry.run.id, 'second', f.scope, f.queue);
    expect(listTasks()).toHaveLength(1); expect(listTasks()[0].input).toBe('Second prompt');
    expect(createEvaluationRun(f.scope, f.suite.id, key, selected).replayed).toBe(true);
    expect(() => createEvaluationRun(f.scope, f.suite.id, key, f.request)).toThrow(/different/);
    await expect(dispatchEvaluationCase(entry.run.id, 'first', f.scope, f.queue)).rejects.toThrow(/not selected/);
  });
  it('enforces sequential execution, pins one revision, and does not advance on replay/read/restart', async () => {
    const f = fixture(), key = randomUUID(), entry = createEvaluationRun(f.scope, f.suite.id, key, f.request);
    await expect(dispatchEvaluationCase(entry.run.id, 'second', f.scope, f.queue)).rejects.toThrow(/sequentially/);
    const run = await dispatchEvaluationCase(entry.run.id, 'first', f.scope, f.queue), taskId = run.results[0].taskId!;
    await expect(dispatchEvaluationCase(entry.run.id, 'second', f.scope, f.queue)).rejects.toThrow(/current case/);
    expect(getAgentSetupSnapshot(taskId)?.versionId).toBe(f.version.id);
    updateAgent(f.agent.id, { config: { systemInstructions: 'Changed', maxTurns: 8 } });
    const history = agentConfigHistory(getAgent(f.agent.id)!, 'default');
    activateAgentVersion({ agentId: f.agent.id, workspaceId: 'default', actor: { id: 'actor-a', role: 'operator', source: 'proxy' },
      expectedConfigHash: history.workingConfigHash, expectedCurrentVersionId: null });
    saveEvaluationSuite(f.suite.id, f.scope, { ...input(), name: 'Later suite' }, 1);
    await complete(taskId);
    createEvaluationRun(f.scope, f.suite.id, key, f.request);
    await dispatchEvaluationCase(entry.run.id, 'first', f.scope, f.queue);
    closeDb();
    expect(refreshEvaluationRun(run.id, f.scope).results.map(item => item.status)).toEqual(['passed', 'pending']);
    expect(listTasks()).toHaveLength(1);
    const next = await dispatchEvaluationCase(run.id, 'second', f.scope, f.queue);
    expect(getAgentSetupSnapshot(next.results[1].taskId!)?.versionId).toBe(f.version.id);
    expect(getAgentSetupSnapshot(next.results[1].taskId!)?.systemInstructions).toBe('Original');
    expect(getTask(next.results[1].taskId!)?.completionCriteria).toEqual(input().cases[1].checks);
  });
  it('survives lost dispatch responses with one task and prevents cross-run suite concurrency', async () => {
    const f = fixture(), entry = createEvaluationRun(f.scope, f.suite.id, randomUUID(), f.request);
    f.queue.dispatchExisting.mockRejectedValueOnce(new Error('Response lost'));
    await expect(dispatchEvaluationCase(entry.run.id, 'first', f.scope, f.queue)).rejects.toThrow(/lost/);
    const secondRun = createEvaluationRun(f.scope, f.suite.id, randomUUID(), f.request);
    await expect(dispatchEvaluationCase(secondRun.run.id, 'first', f.scope, f.queue)).rejects.toThrow(/current case/);
    const recovered = await dispatchEvaluationCase(entry.run.id, 'first', f.scope, f.queue);
    expect(listTasks()).toHaveLength(1); expect(f.queue.dispatchExisting.mock.calls[0][0]).toBe(recovered.results[0].taskId);
  });
  it('stores verifier hashes and fixture provenance independently of model completion claims', async () => {
    const f = fixture(), entry = createEvaluationRun(f.scope, f.suite.id, randomUUID(), f.request);
    const dispatched = await dispatchEvaluationCase(entry.run.id, 'first', f.scope, f.queue);
    await complete(dispatched.results[0].taskId!);
    const run = refreshEvaluationRun(entry.run.id, f.scope);
    expect(run.counts).toEqual({ passed: 1, pending: 1, failed: 0, unavailable: 0, running: 0 });
    expect(run.results[0]).toMatchObject({ status: 'passed', transport: 'fixture', actualModel: 'actual-fixture',
      outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/), resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(run.results[0].verification?.criteria[0].evidence).toHaveLength(1);
    const copy = { ...run.results[0] }; delete copy.resultSha256;
    expect(configChecksum(copy)).toBe(run.results[0].resultSha256);
    setEvaluationCaseResult(run.id, { ...run.results[0], status: 'failed', output: 'Overwrite' });
    expect(getEvaluationRun(run.id, f.scope)?.results[0].status).toBe('passed');
  });
  it('never passes empty output, missing verification, changed criteria or missing required evidence', async () => {
    for (const mode of ['empty', 'missing', 'criteria', 'evidence']) {
      const f = fixture(), entry = createEvaluationRun(f.scope, f.suite.id, randomUUID(), f.request);
      const dispatched = await dispatchEvaluationCase(entry.run.id, 'first', f.scope, f.queue), taskId = dispatched.results[0].taskId!;
      const execution = createExecution({ taskId, agentDefId: f.agent.id, workspaceId: 'default' });
      const verification = await verifyCompletionCriteria(getTask(taskId)!, execution.id, 'Expected');
      if (mode === 'evidence') verification.criteria[0].evidence = [];
      if (mode === 'criteria') getDb().run('UPDATE tasks SET completion_criteria = ? WHERE id = ?', '[]', taskId);
      updateTask(taskId, { status: 'done', output: mode === 'empty' ? '' : 'Expected' });
      updateExecution(execution.id, { status: 'done', runState: { ...initialAgentRunState(),
        ...(mode === 'missing' ? {} : { verification }) } });
      expect(refreshEvaluationRun(entry.run.id, f.scope).results[0].status).toBe('failed');
    }
  });
  it('checks literal exclusions and strict JSON without Markdown/regex heuristics; human rubrics remain unavailable', async () => {
    const checks: CompletionCriterion[] = [
      { ...check('secret'), id: 'exclude', verifier: 'output_not_contains', text: 'secret' },
      { id: 'json', label: 'JSON', required: true, verifier: 'output_json_schema',
        schema: { type: 'object', properties: { answer: { type: 'string', maxLength: 20 } }, required: ['answer'], additionalProperties: false } },
    ];
    const task = createTask({ title: 'Check', description: '', input: 'Check', mode: 'direct', completionCriteria: checks });
    const execution = createExecution({ taskId: task.id, agentDefId: 'fixture' });
    expect((await verifyCompletionCriteria(task, execution.id, '{"answer":"ok"}')).status).toBe('passed');
    for (const output of ['', '{"answer":42}', '{"answer":"secret"}', '{"answer":"ok","extra":true}', '```json\n{"answer":"ok"}\n```', 'x'.repeat(200001)]) {
      expect((await verifyCompletionCriteria(task, execution.id, output)).status).toBe('failed');
    }
    const body = input(); body.cases[0].checks = [{ id: 'review', label: 'Quality', required: true, verifier: 'human_review', rubric: 'Correct business answer' }];
    const f = fixture(body), entry = createEvaluationRun(f.scope, f.suite.id, randomUUID(), f.request);
    const run = await dispatchEvaluationCase(entry.run.id, 'first', f.scope, f.queue);
    await complete(run.results[0].taskId!, 'This is perfect.');
    expect(refreshEvaluationRun(entry.run.id, f.scope).results[0]).toMatchObject({ status: 'unavailable', humanReviewRequired: true });
  });
  it('runs through the actual runtime with fixture transport, preserving unavailable check provenance', async () => {
    const body = input(); body.cases[0].checks = [{ id: 'artifact', label: 'File', required: true, verifier: 'artifact', relativePath: 'not-created.md' }];
    const f = fixture(body), entry = createEvaluationRun(f.scope, f.suite.id, randomUUID(), f.request);
    const run = await dispatchEvaluationCase(entry.run.id, 'first', f.scope, f.queue), taskId = run.results[0].taskId!;
    updateTask(taskId, { workspacePath: root });
    vi.spyOn(tsAgentLoop, 'execute').mockResolvedValue({ output: 'Everything is completed', costUSD: null, costType: 'unavailable',
      provider: 'scripted-fixture', actualModelId: 'actual-fixture', inputTokens: 0, outputTokens: 0, numTurns: 1, durationMs: 1, executionId: 'fixture' });
    const runtime = new AgentRuntime(); vi.spyOn(runtime as any, 'recordTrajectory').mockImplementation(() => {});
    await expect(runtime.execute(getAgent(f.agent.id)!, getTask(taskId)!)).rejects.toThrow(/COMPLETION_CRITERIA_FAILED/);
    expect(refreshEvaluationRun(entry.run.id, f.scope).results[0]).toMatchObject({ status: 'failed', transport: 'fixture', actualModel: 'actual-fixture',
      verification: { status: 'failed' } });
    expect(listExecutions({ taskId })).toHaveLength(1);
  });
  it('reuses the bounded command verifier and saves command evidence without accepting arbitrary shell', async () => {
    const task = createTask({ title: 'Verifier', description: '', input: 'Verify', mode: 'direct', workdir: root,
      workspacePath: root, completionCriteria: [{ id: 'test', label: 'Tests', required: true, verifier: 'test_command', command: 'pnpm test', timeoutMs: 1000 }] });
    const execution = createExecution({ taskId: task.id, agentDefId: 'fixture' });
    const tool = vi.spyOn(sandbox, 'executeTool').mockResolvedValue({ status: 'done', output: 'Fixture tests passed' });
    const report = await verifyCompletionCriteria(task, execution.id, 'Expected');
    expect(report.status).toBe('passed'); expect(report.criteria[0].evidence[0].ref).toMatch(/^artifact:\/\//);
    expect(tool).toHaveBeenCalledWith('shell_exec', { command: 'pnpm test' }, root,
      expect.objectContaining({ timeoutMs: 1000, maxOutputChars: 8000, allowedTools: ['shell_exec'] }));
  });
  it('collects terminal evidence through the real in-memory queue event path without starting another case', async () => {
    vi.stubEnv('REDIS_URL', ''); vi.stubEnv('REDIS_HOST', '');
    const f = fixture(), entry = createEvaluationRun(f.scope, f.suite.id, randomUUID(), f.request);
    vi.spyOn(tsAgentLoop, 'execute').mockResolvedValue({ output: 'Expected', costUSD: null, costType: 'unavailable',
      provider: 'scripted-fixture', actualModelId: 'actual-fixture', inputTokens: 0, outputTokens: 0, numTurns: 1, durationMs: 1, executionId: 'fixture' });
    const runtime = new AgentRuntime(); vi.spyOn(runtime as any, 'recordTrajectory').mockImplementation(() => {});
    const manager = { executeTask: vi.fn(async (id: string, task: ReturnType<typeof createTask>) => {
      updateTask(task.id, { workspacePath: root });
      return runtime.execute(getAgent(id)!, getTask(task.id)!);
    }) } as unknown as AgentManager;
    const queue = new RuntimeTaskQueue(manager);
    const done = new Promise<void>(resolve => {
      const handler: Parameters<typeof eventBus.on>[1] = event => {
        const taskId = (event.payload as { taskId: string }).taskId;
        if (getTask(taskId)?.assigneeId !== f.agent.id) return;
        eventBus.off('task:done', handler); resolve();
      };
      eventBus.on('task:done', handler);
    });
    await dispatchEvaluationCase(entry.run.id, 'first', f.scope, queue);
    await done;
    expect(getEvaluationRun(entry.run.id, f.scope)?.results[0]).toMatchObject({ status: 'passed', transport: 'fixture' });
    expect(getEvaluationRun(entry.run.id, f.scope)?.results[1].status).toBe('pending');
    expect(listTasks()).toHaveLength(1);
  });
});

describe('evaluation HTTP authorization and acceptance', () => {
  it('enforces scope/role, explicit next, request replay and stale evidence acceptance gates', async () => {
    const f = fixture(), app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).tenantContext = { userId: req.header('x-fixture-actor') || 'actor-a',
      role: 'operator', workspaceId: req.header('x-fixture-workspace') || 'default' }; next(); });
    app.use('/agents', createAgentRoutes(f.queue as unknown as TaskQueue)); app.use('/executions', executionRoutes);
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = `${base}/agents/${f.agent.id}`;
    try {
      const post = (path: string, body: unknown, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      expect((await fetch(url + '/evaluation-suites', { headers: { 'x-fixture-actor': 'other' } })).status).toBe(200);
      expect(await (await fetch(url + '/evaluation-suites', { headers: { 'x-fixture-actor': 'other' } })).json()).toEqual([]);
      expect((await fetch(url + '/evaluation-suites', { headers: { 'x-fixture-workspace': 'other' } })).status).toBe(404);
      expect((await post(`/evaluation-suites/${f.suite.id}/runs`, f.request, { 'x-operator-id': 'viewer', 'x-operator-role': 'viewer' })).status).toBe(403);
      expect((await post(`/evaluation-suites/${f.suite.id}/runs`, f.request)).status).toBe(400);
      expect((await post(`/evaluation-suites/${f.suite.id}/runs`, { ...f.request, selectedCaseIds: [] }, { 'Idempotency-Key': randomUUID() })).status).toBe(400);
      const key = randomUUID();
      const response = await post(`/evaluation-suites/${f.suite.id}/runs`, f.request, { 'Idempotency-Key': key });
      expect(response.status).toBe(200);
      const run = await response.json(), execution = await complete(run.results[0].taskId);
      expect((await post(`/evaluation-runs/${run.id}/next`, { caseId: 'second' }, { 'x-fixture-actor': 'other' })).status).toBe(404);
      expect((await post(`/evaluation-suites/${f.suite.id}/runs`, f.request, { 'Idempotency-Key': key })).status).toBe(200);
      expect(listTasks()).toHaveLength(1);
      const latest = await (await fetch(url + `/evaluation-runs/${run.id}`)).json();
      expect(latest.results[1].status).toBe('pending');
      const summary = await (await fetch(url + '/evaluation-runs')).json();
      expect(summary[0].results[0].output).toBeUndefined();
      expect(summary[0].results[0].verification).toBeUndefined();
      expect(latest.results[0].output).toBe('Expected');
      updateTask(execution.taskId, { output: 'Changed after verification' });
      const accept = await fetch(`${base}/executions/${execution.id}/acceptance`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'accepted' }) });
      expect(accept.status).toBe(409);
      expect((await post(`/evaluation-runs/${run.id}/next`, { caseId: 'second' })).status).toBe(200);
      expect(listTasks()).toHaveLength(2);
      const saved = await fetch(url + `/evaluation-suites/${f.suite.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input(), name: 'Update HTTP', expectedRevision: 1 }) });
      expect(saved.status).toBe(200);
      expect((await fetch(url + '/evaluation-runs')).status).toBe(200);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
