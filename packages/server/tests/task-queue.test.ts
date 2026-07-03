import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentManager } from '../src/agents/agent-manager.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import { eventBus } from '../src/events/event-bus.js';
import { closeDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask, getTask, getTaskLogs, updateTask, listDependents } from '../src/db/models/task.js';

describe('TaskQueue failure state handling', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-task-queue-')), 'test.db');
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
    vi.restoreAllMocks();
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
