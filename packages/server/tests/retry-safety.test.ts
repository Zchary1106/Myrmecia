import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask, getTask, updateTask } from '../src/db/models/task.js';
import { createExecution, getExecution } from '../src/db/models/execution.js';
import { createToolExecution } from '../src/tools/tool-execution.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import { claimQueueRetry, queueOwnsRetry, taskMayHaveSideEffects } from '../src/agents/retry-ownership.js';
import { SelfHealingEngine } from '../src/agents/self-healing.js';
import { createExternalAgent, createExternalAgentRun, updateExternalAgentRun } from '../src/db/models/external-agent.js';

beforeEach(() => {
  process.env.DB_PATH = ':memory:'; delete process.env.REDIS_URL; delete process.env.REDIS_HOST;
  createAgent({ id: 'fixture', name: 'Fixture', role: 'dev' });
  getDb().run("INSERT INTO tools (id, name) VALUES ('unknown_external_write', 'Unknown effect')");
});
afterEach(() => { closeDb(); delete process.env.DB_PATH; vi.restoreAllMocks(); });

describe('retry and recovery safety', () => {
  it('keeps a single retry owner and prevents self-healing from starting another execution', async () => {
    const task = createTask({ title: 'owned', description: '', input: '', mode: 'direct' });
    updateTask(task.id, { status: 'failed' });
    const release = claimQueueRetry(task.id);
    try {
      expect(queueOwnsRetry(task.id)).toBe(true);
      await (new SelfHealingEngine() as any).onTaskFailed(task.id, 'network error');
      expect(getTask(task.id)?.status).toBe('failed');
      expect(getTask(task.id)?.retryCount).toBe(0);
    } finally { release(); }
    expect(queueOwnsRetry(task.id)).toBe(false);
  });

  it('does not auto-retry deterministic failures or resurrect cancelled tasks', async () => {
    for (const cancelled of [false, true]) {
      const task = createTask({ title: 'bounded', description: '', input: '', mode: 'direct', assigneeId: 'fixture', maxRetries: 3 });
      const execute = vi.fn(async () => {
        updateTask(task.id, { status: cancelled ? 'cancelled' : 'failed' });
        throw new Error('AGENT_MAX_TURNS: exhausted');
      });
      const queue = new TaskQueue({ executeTask: execute } as any);
      try {
        await (queue as any).processJob(task.id);
      } catch { /* BullMQ receives an unrecoverable error. */ }
      await queue.shutdown();
      expect(execute).toHaveBeenCalledOnce();
      expect(getTask(task.id)?.status).toBe(cancelled ? 'cancelled' : 'failed');
      expect(getTask(task.id)?.retryCount).toBe(0);
    }
  });

  it('releases retry ownership before scheduling a bounded transient retry', async () => {
    const task = createTask({ title: 'transient', description: '', input: '', mode: 'direct', assigneeId: 'fixture', maxRetries: 1 });
    const execute = vi.fn(async () => {
      if (execute.mock.calls.length === 1) {
        updateTask(task.id, { status: 'failed' });
        throw new Error('temporary transport error');
      }
      updateTask(task.id, { status: 'done' });
    });
    const queue = new TaskQueue({ executeTask: execute } as any);
    await (queue as any).tryExecute(getTask(task.id));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await queue.shutdown();
    expect(getTask(task.id)?.status).toBe('done');
    expect(getTask(task.id)?.retryCount).toBe(1);
    expect(queueOwnsRetry(task.id)).toBe(false);
  });

  it('releases interrupted execution slots without repeating unknown writes', async () => {
    const task = createTask({ title: 'write', description: '', input: '', mode: 'direct', assigneeId: 'fixture' });
    const execution = createExecution({ taskId: task.id, agentDefId: 'fixture' });
    createToolExecution({ taskId: task.id, executionId: execution.id, toolId: 'unknown_external_write', input: {} });
    updateTask(task.id, { status: 'running' });
    expect(taskMayHaveSideEffects(task.id)).toBe(true);
    const execute = vi.fn();
    const queue = new TaskQueue({ executeTask: execute } as any);
    await queue.recoverRunningTasks();
    await queue.shutdown();
    expect(getTask(task.id)?.status).toBe('failed');
    expect(getExecution(execution.id)).toMatchObject({ status: 'failed', runState: { phase: 'interrupted' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps detached callback work waiting after restart without rerunning it locally', async () => {
    const agent = createExternalAgent({ workspaceId: 'default', name: 'Callback fixture', adapter: { kind: 'http', endpoint: 'https://fixture.invalid' } });
    const task = createTask({ title: 'remote', description: '', input: '', mode: 'direct' });
    const execution = createExecution({ taskId: task.id, agentDefId: `external:${agent.id}` });
    const run = createExternalAgentRun({ externalAgentId: agent.id, workspaceId: 'default', taskId: task.id,
      triggerType: 'manual', status: 'waiting_for_callback', invocation: { objective: 'fixture', constraints: [] }, artifactIds: [] });
    updateExternalAgentRun(run.id, 'default', { executionId: execution.id });
    updateTask(task.id, { status: 'waiting_for_tool' });
    const execute = vi.fn(), queue = new TaskQueue({ executeTask: execute } as any);
    await queue.recoverRunningTasks(); await queue.shutdown();
    expect(execute).not.toHaveBeenCalled();
    expect(getTask(task.id)?.status).toBe('waiting_for_tool');
    expect(getExecution(execution.id)?.status).toBe('running');
  });
});
