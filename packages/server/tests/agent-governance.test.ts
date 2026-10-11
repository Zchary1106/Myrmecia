import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { getDb, closeDb } from '../src/db/database.js';
import { createAgent, getAgent } from '../src/db/models/agent.js';
import { createTask, getTask, updateTask, listTasks } from '../src/db/models/task.js';
import { createExecution, updateExecution } from '../src/db/models/execution.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import { createAgentRoutes } from '../src/routes/agents.js';
import { createTaskRoutes } from '../src/routes/tasks.js';
import { agentBudgetState, saveAgentBudget, prepareTaskBudget, agentBudgetLimitsSchema } from '../src/agents/agent-budget.js';
import { boundedModelOutput, budgetUsage, reserveBudget, settleUsage, markBudgetDispatched, setBudgetPolicy, releaseUndispatchedBudget } from '../src/agents/budget-service.js';
import { taskControlCapabilities } from '../src/agents/task-controls.js';
import { getAgentSetupSnapshot, pinAgentSetup } from '../src/agents/agent-setup-snapshot.js';
import { resolveAgentRuntimeLimits } from '../src/agents/runtime-limits.js';
import { createCustomModel } from '../src/models/model-registry.js';
import { getModelGateway } from '../src/models/gateway.js';
import { TsAgentLoop } from '../src/agents/ts-agent-loop.js';
import { AgentRuntime, agentRuntime } from '../src/agents/agent-runtime.js';
import { llmCache } from '../src/cache/llm-cache.js';
import { defaultRuntimeCapabilities } from '@myrmecia/shared';
import { initialAgentRunState } from '../src/agents/run-state.js';
import { setPauseControl } from '../src/agents/pause-control.js';
import { AgentManager } from '../src/agents/agent-manager.js';
import { fixtureCompletion } from './fixtures/runtime-providers.js';
import { eventBus } from '../src/events/event-bus.js';
import { createRunTrace, createTraceSpan } from '../src/db/models/trace.js';
const limits = { maxTurns: 3, timeoutSeconds: 60, maxConcurrent: 1, period: 'lifetime' as const, maxTokens: 1500, maxToolCalls: 2 };
beforeEach(() => {
  closeDb(); vi.stubEnv('DB_PATH', ':memory:'); vi.stubEnv('REDIS_URL', ''); vi.stubEnv('REDIS_HOST', '');
  vi.stubEnv('MYRMECIA_MODEL_PROVIDER', ''); vi.stubEnv('MODEL_PROVIDER_MAP', '');
  vi.stubEnv('MODEL_PROVIDERS', JSON.stringify({ default: { baseURL: 'http://fixture.invalid', apiKey: 'fixture-only' } }));
  getDb(); createCustomModel({ id: 'governance-fixture', displayName: 'Fixture', provider: 'default' });
  getDb().run("UPDATE model_registry SET cost_profile = ? WHERE id = ?", JSON.stringify({ pricing: { inputPer1k: 0.001, outputPer1k: 0.001 } }), 'governance-fixture');
  llmCache.clear();
});
afterEach(() => { closeDb(); vi.restoreAllMocks(); vi.unstubAllEnvs(); (eventBus as any).emitter.removeAllListeners(); });
const agent = () => createAgent({ name: 'Budget fixture', role: 'analyst', model: 'governance-fixture', config: { systemInstructions: 'Reply with fixture evidence' }, allowedTools: [] });
const task = (id: string) => createTask({ title: 'fixture', description: 'fixture request', input: 'fixture request', mode: 'direct', assigneeId: id });
const reserve = (a: string, t: string, key: string, tokens = 100) => reserveBudget({
  workspaceId: 'default', agentId: a, taskId: t, key, kind: 'model', tokens, toolCalls: 0, runtimeMs: 0, costType: 'unavailable', costUSD: null });
async function http(fn: (url: string, queue: TaskQueue) => Promise<void>) {
  const queue = new TaskQueue({ hasCapacity: () => false, executeTask: vi.fn(), cancelTask: vi.fn() } as any);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).tenantContext = { workspaceId: req.header('x-fixture-workspace') || 'default', userId: 'fixture', role: 'admin' }; next(); });
  app.use('/agents', createAgentRoutes(queue)); app.use('/tasks', createTaskRoutes(queue));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, queue); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await queue.shutdown(); }
}
describe('Agent governance budgets and debug controls', () => {
  it('validates positive quotas, optimistic revisions, uncertain save replay and immutable task policies', () => {
    const a = agent();
    expect(agentBudgetState(a.id, 'default')).toMatchObject({ revision: 0, limits: { maxTurns: 50 } });
    for (const change of [{ maxTokens: 0 }, { maxTurns: 201 }, { timeoutSeconds: 9 }, { maxConcurrent: 9 }, { maxCostUSD: -1 }])
      expect(agentBudgetLimitsSchema.safeParse({ ...limits, ...change }).success).toBe(false);
    const saved = saveAgentBudget(a.id, 'default', 0, limits);
    expect(saved.revision).toBe(1); expect(saveAgentBudget(a.id, 'default', 0, limits).revision).toBe(1);
    expect(() => saveAgentBudget(a.id, 'default', 0, { ...limits, maxTokens: 100 })).toThrow('reload');
    const t = task(a.id); pinAgentSetup(t.id, getAgent(a.id)!);
    prepareTaskBudget(getAgent(a.id)!, t, resolveAgentRuntimeLimits(getAgent(a.id)!));
    saveAgentBudget(a.id, 'default', 1, { ...limits, maxTokens: 900, timeoutSeconds: 90 });
    expect(getAgentSetupSnapshot(t.id)?.completeConfig?.config.governanceBudget?.maxTokens).toBe(1500);
    expect(budgetUsage('default', a.id, t.id).find(p => p.scope === 'task')?.limits.tokens).toBe(1500);
    expect(budgetUsage('default', a.id, t.id).find(p => p.scope === 'agent')?.limits.tokens).toBe(900);
  });
  it('separates observed, held and unknown accounting, counts concurrent requests and never resurrects released requests', () => {
    const a = agent(), t = task(a.id);
    saveAgentBudget(a.id, 'default', 0, { ...limits, maxTokens: 150 });
    reserve(a.id, t.id, 'one');
    expect(boundedModelOutput('default', a.id, t.id, 20, 100)).toBe(30);
    expect(() => reserve(a.id, t.id, 'two')).toThrow('EXHAUSTED');
    markBudgetDispatched('default', 'one');
    expect(() => markBudgetDispatched('default', 'one')).toThrow('REPLAY');
    settleUsage({ workspaceId: 'default', key: 'one', eventKey: 'receipt', tokens: 40, costUSD: null, costType: 'subscription' });
    const receipt = budgetUsage('default', a.id, t.id).find(p => p.scope === 'agent')!;
    expect(receipt).toMatchObject({ observed: { tokens: 40 }, reserved: { tokens: 0 }, remaining: { tokens: 110 }, unknownCost: 1 });
    reserve(a.id, t.id, 'held', 10); releaseUndispatchedBudget('default', 'held');
    expect(() => reserve(a.id, t.id, 'held', 10)).toThrow('RELEASED');
    expect(() => markBudgetDispatched('default', 'held')).toThrow('REPLAY');
    reserve(a.id, t.id, 'lost-cas', 10);
    const db = getDb(), runSql = db.run.bind(db);
    const cas = vi.spyOn(db, 'run').mockImplementation((sql, ...parameters) =>
      sql.includes("SET status = 'dispatched'") ? { changes: 0, lastInsertRowid: 0 } : runSql(sql, ...parameters));
    expect(() => markBudgetDispatched('default', 'lost-cas')).toThrow('REPLAY');
    cas.mockRestore();
    setBudgetPolicy({ workspaceId: 'default', scope: 'workspace', scopeId: 'default', period: 'utc_day', maxCostUSD: 1 });
    expect(() => reserve(a.id, t.id, 'unknown', 10)).toThrow('UNCERTAIN');
  });
  it.each(['false', 'true'])('enforces real host-loop dispatch with V2=%s and retains unknown-price denial', async v2 => {
    vi.stubEnv('MYRMECIA_RUNTIME_V2', v2);
    const a = agent(); saveAgentBudget(a.id, 'default', 0, limits); const configured = getAgent(a.id)!;
    const t = task(a.id); pinAgentSetup(t.id, configured); prepareTaskBudget(configured, t, resolveAgentRuntimeLimits(configured));
    const run = createExecution({ taskId: t.id, agentDefId: a.id });
    const trace = createRunTrace({ taskId: t.id, executionId: run.id, agentId: a.id });
    const span = createTraceSpan({ traceId: trace.id, type: 'agent.start', name: 'fixture' });
    const gateway = getModelGateway(); vi.spyOn(gateway, 'runtimeCapabilitiesFor').mockReturnValue(defaultRuntimeCapabilities('host_loop'));
    const complete = vi.spyOn(gateway, 'completeForModel').mockResolvedValue(fixtureCompletion('## Evidence\n\nfixture delivered'));
    await new TsAgentLoop().execute(configured, t, new AbortController(), run.id, trace.id, span.id,
      { toolUseCount: 0, latestInputTokens: 0, cumulativeOutputTokens: 0, recentActivities: [] });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][1].max_tokens).toBeLessThan(1500);
    expect(budgetUsage('default', a.id, t.id).find(p => p.scope === 'task')?.observed.tokens).toBe(20);
    updateExecution(run.id, { status: 'done', completedAt: new Date().toISOString() });
    updateTask(t.id, { status: 'done' });
    saveAgentBudget(a.id, 'default', 1, { ...limits, maxCostUSD: 1 });
    llmCache.clear();
    getDb().run("UPDATE model_registry SET cost_profile = '{}' WHERE id = ?", 'governance-fixture');
    const rejected = task(a.id); pinAgentSetup(rejected.id, getAgent(a.id)!);
    const refused = await new AgentRuntime().execute(getAgent(a.id)!, rejected).catch(error => error);
    expect(refused.message).toContain('BUDGET_UNCERTAIN');
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('keeps a stricter Agent/model limit under task override and enforces configured timeout', () => {
    const a = agent(); a.config.timeout = 60; a.config.modelPolicy = { maxTokens: 1000, maxToolCalls: 3 };
    const resolved = resolveAgentRuntimeLimits(a, { budget: { maxTokens: 9999, maxToolCalls: 9 } } as any);
    expect(resolved.maxExecutionTokens).toBe(1000); expect(resolved.maxToolCallsPerExecution).toBe(3);
    expect(resolved.maxExecutionWallClockMs).toBe(60_000);
  });
  it('rejects configured host hard limits on an ungoverned adapter without executing it', async () => {
    const a = agent(); saveAgentBudget(a.id, 'default', 0, limits);
    const runtime = new AgentRuntime(), execute = vi.fn();
    runtime.registerRuntimeAdapter({ name: 'unknown-worker', canHandle: () => true, execute });
    await expect(runtime.execute(getAgent(a.id)!, task(a.id))).rejects.toThrow('BUDGET_RUNTIME_UNSUPPORTED');
    expect(execute).not.toHaveBeenCalled();
  });
  it('serializes concurrent admissions before workspace creation yields', async () => {
    const a = agent(); let finish!: (value: any) => void;
    const execute = vi.spyOn(agentRuntime, 'execute').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const manager = new AgentManager('/nonexistent');
    const first = manager.executeTask(a.id, task(a.id));
    await expect(manager.executeTask(a.id, task(a.id))).rejects.toThrow('max concurrency');
    expect(execute).toHaveBeenCalledTimes(1); finish({ output: 'fixture' }); await first;
    expect(manager.hasCapacity(a.id)).toBe(true);
  });
  it('exposes truthful pause-requested capabilities and disables unsafe resume/terminal pause', async () => {
    const a = agent(), t = task(a.id);
    await http(async (_url, queue) => {
      const run = createExecution({ taskId: t.id, agentDefId: a.id });
      updateTask(t.id, { status: 'waiting_for_tool' }); setPauseControl('task', t.id, 'requested');
      let caps = taskControlCapabilities(getTask(t.id)!, queue);
      expect(caps.state).toBe('pause_requested'); expect(caps.operations.resume.allowed).toBe(false);
      updateExecution(run.id, { status: 'failed', runState: { ...initialAgentRunState(), phase: 'interrupted', stopReason: 'interrupted' } });
      caps = taskControlCapabilities(getTask(t.id)!, queue);
      expect(caps.operations.resume.allowed).toBe(false);
      expect(caps.operations.resume.reason).toContain('RECONCILIATION');
      updateTask(t.id, { status: 'done' });
      expect(taskControlCapabilities(getTask(t.id)!, queue).operations.pause.allowed).toBe(false);
    });
  });
  it('authorizes HTTP budgets/controls, requires rerun confirmation and reuses task after response loss', async () => {
    const a = agent(), t = task(a.id); updateTask(t.id, { status: 'done' });
    await http(async url => {
      const headers = { 'Content-Type': 'application/json' };
      expect((await fetch(`${url}/agents/${a.id}/budget`, { headers: { 'x-operator-id': 'viewer', 'x-operator-role': 'viewer' } })).status).toBe(403);
      const saved = await fetch(`${url}/agents/${a.id}/budget`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, limits }) });
      expect(saved.status).toBe(200); expect((await saved.json()).revision).toBe(1);
      expect((await fetch(`${url}/agents/${a.id}/budget`, { headers: { 'x-fixture-workspace': 'other' } })).status).toBe(404);
      expect((await fetch(`${url}/tasks/${t.id}/controls`)).status).toBe(200);
      const body = { idempotencyKey: randomUUID(), confirm: true };
      expect((await fetch(`${url}/tasks/${t.id}/rerun`, { method: 'POST', headers, body: JSON.stringify({ idempotencyKey: body.idempotencyKey }) })).status).toBe(409);
      const first = await fetch(`${url}/tasks/${t.id}/rerun`, { method: 'POST', headers, body: JSON.stringify(body) });
      expect(first.status).toBe(201);
      const second = await fetch(`${url}/tasks/${t.id}/rerun`, { method: 'POST', headers, body: JSON.stringify(body) });
      expect(second.status).toBe(200); expect((await second.json()).id).toBe((await first.json()).id);
      expect(listTasks()).toHaveLength(2);
      expect(await (await fetch(`${url}/tasks/${t.id}/debug-history`)).json()).toHaveLength(2);
      const follow = { content: 'Next scoped question', idempotencyKey: randomUUID() };
      const created = await fetch(`${url}/tasks/${t.id}/continue`, { method: 'POST', headers, body: JSON.stringify(follow) });
      expect(created.status).toBe(201);
      const repeated = await fetch(`${url}/tasks/${t.id}/continue`, { method: 'POST', headers, body: JSON.stringify(follow) });
      expect(repeated.status).toBe(200);
      expect((await repeated.json()).id).toBe((await created.json()).id);
      expect(listTasks()).toHaveLength(3);
    });
  });
});
