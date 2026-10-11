import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask, getTask, updateTask } from '../src/db/models/task.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import { createExecution, updateExecution } from '../src/db/models/execution.js';
import { continuationJobId, RuntimeSliceYield, scheduleContinuation } from '../src/agents/runtime-continuation.js';
import { saveAgentBudget } from '../src/agents/agent-budget.js';
import { reserveBudget, settleUsage } from '../src/agents/budget-service.js';
import { getAgentSetupSnapshot, pinAgentSetup } from '../src/agents/agent-setup-snapshot.js';
import { createEvaluationRun, saveEvaluationSuite, getEvaluationRun, setEvaluationCaseResult } from '../src/db/models/agent-evaluation.js';
import { getAgent } from '../src/db/models/agent.js';
import { claimRun, releaseRunLease } from '../src/db/models/run-ownership.js';

const describeRedis = process.env.REDIS_URL && process.env.MYRMECIA_REDIS_RECOVERY_TEST === 'true' ? describe : describe.skip;

function assertDedicatedRedis(): void {
  const url = new URL(process.env.REDIS_URL!);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Redis recovery test requires a dedicated loopback instance');
  if (process.env.CI === 'true' && url.port === '6379') return;
  const name = process.env.MYRMECIA_REDIS_TEST_CONTAINER;
  if (name !== 'myrmecia-runtime-v2-redis-acceptance-6388' || url.port !== '6388') throw new Error('Dedicated Redis fixture not authorized');
  const info = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0];
  if (info.Config.Labels?.['myrmecia.runtime-v2.fixture'] !== 'redis'
    || info.NetworkSettings.Ports?.['6379/tcp']?.[0]?.HostIp !== '127.0.0.1'
    || info.NetworkSettings.Ports?.['6379/tcp']?.[0]?.HostPort !== '6388') throw new Error('Redis fixture identity mismatch');
}

describeRedis('TaskQueue Redis restart recovery', () => {
  let queue: TaskQueue;

  beforeEach(async () => {
    assertDedicatedRedis(); // Must happen before the destructive queue cleanup below.
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-redis-recovery-')), 'test.db');
    getDb();
    queue = new TaskQueue({ executeTask: vi.fn() } as any);
    await (queue as any).queue?.obliterate({ force: true });
  });

  afterEach(async () => {
    await queue?.shutdown();
    closeDb();
    delete process.env.DB_PATH;
  });

  it('requeues an interrupted task from its durable checkpoint on a new queue instance', async () => {
    const agent = createAgent({ id: 'redis-agent', name: 'Redis Agent', role: 'dev' });
    const task = createTask({ title: 'restart', description: 'restart', input: 'run', mode: 'direct', assigneeId: agent.id });
    updateTask(task.id, { status: 'running' });

    // Simulate the original process going away before a new server constructs
    // its queue and invokes recovery.
    await queue.shutdown();
    queue = new TaskQueue({ executeTask: vi.fn() } as any);
    await queue.recoverRunningTasks();

    expect(getTask(task.id)?.status).toBe('pending');
    await expect(queue.getStats()).resolves.toMatchObject({ backend: 'redis', waiting: 1, prioritized: 1 });
  });
  it.skipIf(!process.env.MYRMECIA_REDIS_TEST_CONTAINER)('preserves the durable job through an actual dedicated Redis container restart', async () => {
    const agent = createAgent({ id: 'redis-restart-agent', name: 'Redis Restart Agent', role: 'analyst' });
    const task = await queue.enqueue({ title: 'durable restart', description: '', input: 'fixture', mode: 'direct', assigneeId: agent.id });
    saveAgentBudget(agent.id, 'default', 0, { maxTurns: 8, timeoutSeconds: 300, maxConcurrent: 1,
      period: 'lifetime', maxTokens: 5000 });
    const pinned = pinAgentSetup(task.id, getAgent(agent.id)!);
    const scope = { workspaceId: 'default', actorId: 'redis-fixture', agentId: agent.id };
    const suite = saveEvaluationSuite(scope, crypto.randomUUID(), 0, { name: 'Redis fixture', cases: [
      { id: 'case', name: 'Case', prompt: 'fixture', checks: [{ id: 'check', label: 'Literal only', required: true, verifier: 'output_contains', text: 'fixture' }] },
    ] });
    const evaluation = createEvaluationRun(scope, suite.id, 'redis-fixture-run', {
      expectedSuiteRevision: suite.revision, selectedCaseIds: ['case'], configVersionId: pinned!.versionId!,
    }).run;
    setEvaluationCaseResult(evaluation.id, 'case', { status: 'failed', message: 'Persisted fixture failure; no actual model ran', humanReviewRequired: false, transport: 'fixture' });
    reserveBudget({ workspaceId: 'default', taskId: task.id, agentId: agent.id, key: 'redis-fixture-reservation',
      kind: 'model', tokens: 100, toolCalls: 0, runtimeMs: 0, costUSD: null, costType: 'unavailable' });
    settleUsage({ workspaceId: 'default', key: 'redis-fixture-reservation', eventKey: 'receipt',
      tokens: 40, costUSD: null, costType: 'subscription' });
    const lease = claimRun({ taskId: task.id, workspaceId: 'default', owner: 'redis-fixture-owner' });
    releaseRunLease(lease);
    const snapshot = JSON.stringify(getAgentSetupSnapshot(task.id));
    expect(await (queue as any).queue.getJob(task.id)).toBeTruthy();
    expect(JSON.stringify(getAgentSetupSnapshot(task.id))).toBe(snapshot);
    expect(getEvaluationRun(evaluation.id, scope)?.results[0]).toMatchObject({ status: 'failed', transport: 'fixture' });
    expect(getDb().get<any>("SELECT observed_tokens, cost_type FROM agent_budget_reservations WHERE reservation_key = 'redis-fixture-reservation'"))
      .toMatchObject({ observed_tokens: 40, cost_type: 'subscription' });
    expect(getDb().get<any>("SELECT fence_token FROM agent_run_ownership WHERE task_id = ?", task.id).fence_token).toBe(lease.token);
    await queue.shutdown();
    closeDb();
    assertDedicatedRedis();
    execFileSync('docker', ['restart', process.env.MYRMECIA_REDIS_TEST_CONTAINER!], { timeout: 15_000 });
    queue = new TaskQueue({ executeTask: vi.fn() } as any);
    await (queue as any).queue.waitUntilReady();
    expect(await (queue as any).queue.getJob(task.id)).toBeTruthy();
    expect(JSON.stringify(getAgentSetupSnapshot(task.id))).toBe(snapshot);
    expect(getEvaluationRun(evaluation.id, scope)?.results[0]).toMatchObject({ status: 'failed', transport: 'fixture' });
    expect(getDb().get<any>("SELECT observed_tokens, cost_type FROM agent_budget_reservations WHERE reservation_key = 'redis-fixture-reservation'"))
      .toMatchObject({ observed_tokens: 40, cost_type: 'subscription' });
    expect(getDb().get<any>("SELECT fence_token FROM agent_run_ownership WHERE task_id = ?", task.id).fence_token).toBe(lease.token);
    await queue.recoverRunningTasks();
    expect(getTask(task.id)?.status).toBe('pending');
    await expect(queue.getStats()).resolves.toMatchObject({ backend: 'redis', waiting: 1 });
  }, 30_000);
  it('accepts a stable-slice continuation with an immutable BullMQ-compatible job identity', async () => {
    process.env.MYRMECIA_BOUNDED_CONTINUATION = 'true';
    try {
      const agent = createAgent({ id: 'redis-slice-agent', name: 'Redis Slice Agent', role: 'analyst' });
      const task = await queue.enqueue({ title: 'slice fixture', description: '', input: 'fixture', mode: 'direct', assigneeId: agent.id });
      const manager = (queue as any).agentManager;
      manager.executeTask.mockImplementation(async () => {
        const run = createExecution({ taskId: task.id, agentDefId: agent.id });
        scheduleContinuation(task, run.id, 600_000, 1_200_000);
        updateExecution(run.id, { status: 'failed' });
        updateTask(task.id, { status: 'queued' });
        throw new RuntimeSliceYield();
      });
      await (queue as any).processJob(task.id);
      const id = continuationJobId(task);
      expect(id).not.toContain(':');
      expect(await (queue as any).queue.getJob(id)).toBeTruthy();
      expect(getTask(task.id)?.status).toBe('queued');
    } finally { delete process.env.MYRMECIA_BOUNDED_CONTINUATION; }
  });
});
