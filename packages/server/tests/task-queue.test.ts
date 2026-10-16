import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { AgentManager } from '../src/agents/agent-manager.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import { eventBus } from '../src/events/event-bus.js';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask, getTask, getTaskLogs, updateTask, listDependents, listTasks } from '../src/db/models/task.js';
import { createExecution } from '../src/db/models/execution.js';
import { saveLoopCheckpoint } from '../src/agents/loop-checkpoint.js';
import * as executionContext from '../src/agents/execution-context.js';

describe('TaskQueue failure state handling', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-task-queue-')), 'test.db');
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
  });
  it('requires reconciliation instead of silently restarting an in-flight model request', async () => {
    const agent = createAgent({ id: 'pending-request-agent', name: 'Pending Request Agent', role: 'analyst' });
    const task = createTask({ title: 'pending request', description: '', input: 'fixture', mode: 'direct', assigneeId: agent.id });
    updateTask(task.id, { status: 'running' });
    const run = createExecution({ taskId: task.id, agentDefId: agent.id });
    saveLoopCheckpoint(task, run.id, 'fingerprint', { schemaVersion: 1, boundary: 'request_pending', messages: [],
      turn: 1, inputTokens: 100, outputTokens: 100, toolCallCount: 0, toolRuntimeMs: 0, elapsedMs: 10, finalOutput: '' });
    const manager = { executeTask: vi.fn() } as unknown as AgentManager;
    const queue = new TaskQueue(manager);
    await queue.recoverRunningTasks();
    expect(getTask(task.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('prior model request') });
    expect(manager.executeTask).not.toHaveBeenCalled();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
    vi.restoreAllMocks();
  });

  it('rolls back a new task when preparation request persistence fails', async () => {
    const existing = createTask({ title: 'Keep existing', description: '', input: 'fixture', mode: 'direct' });
    getDb().exec('DROP TABLE workspace_preparation_requests');
    const manager = { executeTask: vi.fn() } as unknown as AgentManager;
    const queue = new TaskQueue(manager);
    const emit = vi.spyOn(eventBus, 'emit');
    await expect(queue.enqueue({ title: 'Broken creation', description: '', input: 'fixture', mode: 'direct' }))
      .rejects.toThrow('workspace_preparation_requests');
    expect(listTasks().map(task => task.id)).toEqual([existing.id]);
    expect(manager.executeTask).not.toHaveBeenCalled();
    expect(emit.mock.calls.some(([type]) => type === 'task:created')).toBe(false);
    await queue.shutdown();
  });

  it('records a terminal failure instead of leaving pending work when context initialization fails', async () => {
    const manager = { executeTask: vi.fn() } as unknown as AgentManager;
    const queue = new TaskQueue(manager);
    vi.spyOn(executionContext, 'persistExecutionContext').mockImplementation(() => {
      throw new Error('Fixture context persistence failed');
    });
    const emit = vi.spyOn(eventBus, 'emit');
    await expect(queue.enqueue({ title: 'Context failure', description: '', input: 'fixture', mode: 'direct',
      workdir: dirname(process.env.DB_PATH!), workspaceAccessMode: 'shared_write', selectedWorkspaceSource: false }))
      .rejects.toThrow('Fixture context persistence failed');
    const task = listTasks()[0];
    expect(task).toMatchObject({ status: 'failed', error: expect.stringContaining('Fixture context persistence failed') });
    expect(task.completedAt).toBeTruthy();
    expect(getTaskLogs(task.id).some(log => log.level === 'error')).toBe(true);
    expect(emit.mock.calls).toEqual(expect.arrayContaining([
      ['task:failed', expect.objectContaining({ taskId: task.id, task: expect.objectContaining({ status: 'failed' }) })],
    ]));
    expect(emit.mock.calls.some(([type]) => type === 'task:created')).toBe(false);
    expect(manager.executeTask).not.toHaveBeenCalled();
    await queue.shutdown();
  });

  it('dispatches a queued continuation after the completed run releases admission', async () => {
    const agent = createAgent({ id: 'handoff-agent', name: 'Handoff Agent', role: 'analyst' });
    const first = createTask({ title: 'first', description: '', input: 'first', mode: 'direct', assigneeId: agent.id });
    const next = createTask({ title: 'continuation', description: '', input: 'next', mode: 'direct', assigneeId: agent.id });
    updateTask(next.id, { status: 'queued' });
    let occupied = false;
    let release!: () => void;
    const completed = new Promise<void>(resolve => { release = resolve; });
    const manager = {
      hasCapacity: vi.fn(() => !occupied),
      executeTask: vi.fn(async (_agentId: string, task: { id: string }) => {
        if (task.id === first.id) {
          occupied = true;
          await completed;
          occupied = false;
        } else updateTask(task.id, { status: 'done' });
        return '';
      }),
    } as unknown as AgentManager;
    const queue = new TaskQueue(manager);
    await (queue as any).tryExecute(first);
    updateTask(first.id, { status: 'done' });
    await (queue as any).processNext();
    expect(getTask(next.id)?.status).toBe('queued');
    expect(manager.executeTask).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(manager.executeTask).toHaveBeenCalledTimes(2));
    expect(getTask(next.id)?.status).toBe('done');
  });

  it('marks pre-runtime BullMQ failures as failed after the final attempt', async () => {
    const agent = createAgent({ id: 'queue-agent', name: 'Queue Agent', role: 'dev' });
    const task = createTask({
      title: 'Queue failure',
      description: 'Queue failure',
      input: 'run',
      mode: 'direct',
      assigneeId: agent.id,
      maxRetries: 0,
    });
    const manager = {
      executeTask: vi.fn(async () => {
        throw new Error('Agent queue-agent at max concurrency (1)');
      }),
    } as unknown as AgentManager;
    const queue = new TaskQueue(manager);

    await expect((queue as any).processJob(task.id, { attemptsMade: 0, opts: { attempts: 1 } }))
      .rejects.toThrow('max concurrency');

    const stored = getTask(task.id)!;
    expect(stored.status).toBe('failed');
    expect(stored.error).toContain('max concurrency');
    expect(getTaskLogs(task.id).some(log => log.message.includes('Execution failed after 1/1 attempts'))).toBe(true);
  });
  it.each(['memory', 'bullmq'])('does not automatically replay a read-only SDK token-budget stop in %s dispatch', async mode => {
    const agent = createAgent({ id: `budget-agent-${mode}`, name: 'Budget Agent', role: 'analyst' });
    const task = createTask({ title: 'Budget terminal', description: '', input: 'Read-only fixture', mode: 'direct',
      assigneeId: agent.id, maxRetries: 2 });
    const error = 'COPILOT_TOKEN_BUDGET: observed SDK usage exceeded execution allowance (211217/200000)';
    const manager = { executeTask: vi.fn(async () => { throw new Error(error); }) } as unknown as AgentManager;
    const queue = new TaskQueue(manager);
    try {
      if (mode === 'bullmq') {
        await expect((queue as any).processJob(task.id, { attemptsMade: 0, opts: { attempts: 3 } })).rejects.toThrow(error);
      } else {
        await queue.dispatchExisting(task.id);
        await vi.waitFor(() => expect(getTask(task.id)?.status).toBe('failed'));
      }
      expect(manager.executeTask).toHaveBeenCalledOnce();
      expect(getTask(task.id)).toMatchObject({ status: 'failed', retryCount: 0, error });
      expect(getTask(task.id)?.completedAt).toBeTruthy();
    } finally { await queue.shutdown(); }
  });

  it('returns pre-runtime BullMQ failures to queued while retries remain', async () => {
    const agent = createAgent({ id: 'retry-agent', name: 'Retry Agent', role: 'dev' });
    const task = createTask({
      title: 'Queue retry',
      description: 'Queue retry',
      input: 'run',
      mode: 'direct',
      assigneeId: agent.id,
      maxRetries: 1,
    });
    const manager = {
      executeTask: vi.fn(async () => {
        throw new Error('temporary capacity');
      }),
    } as unknown as AgentManager;
    const queue = new TaskQueue(manager);

    await expect((queue as any).processJob(task.id, { attemptsMade: 0, opts: { attempts: 2 } }))
      .rejects.toThrow('temporary capacity');

    const stored = getTask(task.id)!;
    expect(stored.status).toBe('queued');
    expect(stored.error).toBe('temporary capacity');
  });

  it('records a terminal timeout as a failed task with an explicit timed_out reason', async () => {
    const agent = createAgent({ id: 'timeout-agent', name: 'Timeout Agent', role: 'dev' });
    const task = createTask({
      title: 'timeout', description: 'timeout', input: 'run', mode: 'direct', assigneeId: agent.id, maxRetries: 0,
    });
    const queue = new TaskQueue({
      executeTask: vi.fn(async () => { throw new Error('TIMED_OUT: wall-clock limit reached after 300s'); }),
    } as unknown as AgentManager);

    await expect((queue as any).processJob(task.id, { attemptsMade: 0, opts: { attempts: 1 } }))
      .rejects.toThrow('TIMED_OUT');

    expect(getTask(task.id)?.status).toBe('failed');
    expect(getTask(task.id)?.error).toContain('TIMED_OUT:');
    expect(getTaskLogs(task.id).some(log => log.message.includes('[timed_out]'))).toBe(true);
  });

  it('skips decomposed parent tasks during recovery, leaving them for the master monitor', async () => {
    const agent = createAgent({ id: 'leaf-agent', name: 'Leaf Agent', role: 'dev' });

    // A decomposed parent (running) whose child already finished. It must NOT be
    // re-queued/executed — the master monitor reconciles it via resumeMonitoring.
    const parent = createTask({ title: 'parent', description: 'p', input: 'p', mode: 'master' });
    updateTask(parent.id, { status: 'running' });
    const child = createTask({ title: 'child', description: 'c', input: 'c', mode: 'master', parentTaskId: parent.id });
    updateTask(child.id, { status: 'done' });

    // A normal interrupted leaf task (no children) that SHOULD be recovered.
    const leaf = createTask({ title: 'leaf', description: 'l', input: 'l', mode: 'direct', assigneeId: agent.id });
    updateTask(leaf.id, { status: 'running' });

    const executedTaskIds: string[] = [];
    const manager = {
      executeTask: vi.fn(async (_agentId: string, t: any) => { executedTaskIds.push(t.id); }),
    } as unknown as AgentManager;
    const queue = new TaskQueue(manager);

    await queue.recoverRunningTasks();

    // Parent stays running (untouched) and is never executed as a leaf task.
    expect(getTask(parent.id)!.status).toBe('running');
    expect(executedTaskIds).not.toContain(parent.id);
    // The genuine leaf task was recovered and dispatched.
    expect(executedTaskIds).toContain(leaf.id);
  });

  it('recovers persisted queued work and documents the memory-queue process boundary', async () => {
    const agent = createAgent({ id: 'queued-agent', name: 'Queued Agent', role: 'dev' });
    const queued = createTask({ title: 'queued', description: 'q', input: 'q', mode: 'direct', assigneeId: agent.id });
    const running = createTask({ title: 'running', description: 'r', input: 'r', mode: 'direct', assigneeId: agent.id });
    updateTask(queued.id, { status: 'queued' });
    updateTask(running.id, { status: 'running' });
    const executed: string[] = [];
    const queue = new TaskQueue({
      executeTask: vi.fn(async (_agentId: string, task: any) => { executed.push(task.id); }),
    } as unknown as AgentManager);

    await queue.recoverRunningTasks();

    expect(executed).toEqual(expect.arrayContaining([queued.id, running.id]));
    expect(getTaskLogs(running.id).some(log => log.message.includes('cannot resume an in-flight process'))).toBe(true);
  });

  it('recovers a task interrupted while waiting for a tool', async () => {
    const agent = createAgent({ id: 'tool-agent', name: 'Tool Agent', role: 'dev' });
    const task = createTask({ title: 'tool wait', description: 't', input: 't', mode: 'direct', assigneeId: agent.id });
    updateTask(task.id, { status: 'waiting_for_tool' });
    const executed: string[] = [];
    const queue = new TaskQueue({
      executeTask: vi.fn(async (_agentId: string, recovered: any) => { executed.push(recovered.id); }),
    } as unknown as AgentManager);

    await queue.recoverRunningTasks();

    expect(executed).toContain(task.id);
    expect(getTaskLogs(task.id).some(log => log.message.includes('cannot resume an in-flight process'))).toBe(true);
  });

  it('does not invalidate a publish task that was only queued at restart', async () => {
    const publisher = createAgent({ id: 'social-publisher', name: 'Publisher', role: 'dev' });
    const task = createTask({
      title: 'queued publish', description: 'p', input: 'p', mode: 'pipeline', assigneeId: publisher.id,
    });
    updateTask(task.id, { status: 'queued' });
    const executed: string[] = [];
    const queue = new TaskQueue({
      executeTask: vi.fn(async (_agentId: string, queuedTask: any) => { executed.push(queuedTask.id); }),
    } as unknown as AgentManager);

    await queue.recoverRunningTasks();

    expect(executed).toContain(task.id);
    expect(getTask(task.id)?.status).not.toBe('failed');
  });

  it('cascade-cancels unmet dependents when a subtask fails (no permanent queue hang)', async () => {
    const parent = createTask({ title: 'parent', description: 'p', input: 'p', mode: 'master' });
    updateTask(parent.id, { status: 'running' });

    const a = createTask({ title: 'A', description: 'a', input: 'a', mode: 'master', parentTaskId: parent.id });
    const b = createTask({ title: 'B', description: 'b', input: 'b', mode: 'master', parentTaskId: parent.id, dependsOn: [a.id] });
    const c = createTask({ title: 'C', description: 'c', input: 'c', mode: 'master', parentTaskId: parent.id, dependsOn: [b.id] });
    const indep = createTask({ title: 'D', description: 'd', input: 'd', mode: 'master', parentTaskId: parent.id });

    // B and C are parked waiting on the chain; D is independent and running.
    updateTask(b.id, { status: 'queued' });
    updateTask(c.id, { status: 'queued' });
    updateTask(indep.id, { status: 'running' });
    updateTask(a.id, { status: 'failed', error: 'boom' });

    const queue = new TaskQueue({ executeTask: vi.fn() } as unknown as AgentManager);
    (queue as any).cascadeDependentFailure({ payload: { taskId: a.id } });

    // Direct dependent B and transitive dependent C are cancelled...
    expect(getTask(b.id)!.status).toBe('cancelled');
    expect(getTask(b.id)!.error).toContain('A');
    expect(getTask(c.id)!.status).toBe('cancelled');
    // ...but the independent, still-running task is left alone.
    expect(getTask(indep.id)!.status).toBe('running');
  });

  it('cancels dependents that do not share a parent (dynamic-workflow / graph style)', () => {
    const a = createTask({ title: 'A', description: 'a', input: 'a', mode: 'direct' });
    const b = createTask({ title: 'B', description: 'b', input: 'b', mode: 'direct', dependsOn: [a.id] });
    updateTask(b.id, { status: 'queued' });
    updateTask(a.id, { status: 'failed', error: 'x' });

    // listDependents finds the dependent via the targeted query.
    expect(listDependents(a.id).map(t => t.id)).toContain(b.id);

    const queue = new TaskQueue({ executeTask: vi.fn() } as unknown as AgentManager);
    (queue as any).cascadeDependentFailure({ payload: { taskId: a.id } });

    expect(getTask(b.id)!.status).toBe('cancelled');
  });

  it('cancels a diamond dependent exactly once (re-entrancy safe)', () => {
    // R -> B, R -> C, {B,C} -> D. D can be reached via two dependency paths.
    const r = createTask({ title: 'R', description: 'r', input: 'r', mode: 'direct' });
    const b = createTask({ title: 'B', description: 'b', input: 'b', mode: 'direct', dependsOn: [r.id] });
    const c = createTask({ title: 'C', description: 'c', input: 'c', mode: 'direct', dependsOn: [r.id] });
    const d = createTask({ title: 'D', description: 'd', input: 'd', mode: 'direct', dependsOn: [b.id, c.id] });
    updateTask(b.id, { status: 'queued' });
    updateTask(c.id, { status: 'queued' });
    updateTask(d.id, { status: 'queued' });
    updateTask(r.id, { status: 'failed', error: 'x' });

    const dCancelEmits: string[] = [];
    const handler = (e: any) => { if (e?.payload?.taskId === d.id) dCancelEmits.push(d.id); };
    eventBus.on('task:cancelled', handler);
    try {
      const queue = new TaskQueue({ executeTask: vi.fn() } as unknown as AgentManager);
      (queue as any).cascadeDependentFailure({ payload: { taskId: r.id } });

      expect(getTask(b.id)!.status).toBe('cancelled');
      expect(getTask(c.id)!.status).toBe('cancelled');
      expect(getTask(d.id)!.status).toBe('cancelled');
      // Despite two dependency paths, D is cancelled/emitted exactly once.
      expect(dCancelEmits.length).toBe(1);
    } finally {
      eventBus.off('task:cancelled', handler);
    }
  });

  it('does not execute a coordination parent as a leaf task (processJob guard)', async () => {
    const parent = createTask({ title: 'parent', description: 'p', input: 'p', mode: 'master' });
    updateTask(parent.id, { status: 'queued' });

    const executed: string[] = [];
    const manager = { executeTask: vi.fn(async (_a: string, t: any) => { executed.push(t.id); }) } as unknown as AgentManager;
    const queue = new TaskQueue(manager);

    await (queue as any).processJob(parent.id);

    expect(executed).not.toContain(parent.id);
    expect(getTask(parent.id)!.assigneeId).toBeFalsy();
  });
});
