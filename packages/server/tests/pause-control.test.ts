import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask, getTask, updateTask } from '../src/db/models/task.js';
import { createExecution, updateExecution } from '../src/db/models/execution.js';
import { createPipeline, getPipeline, updatePipeline } from '../src/db/models/pipeline.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import type { AgentManager } from '../src/agents/agent-manager.js';
import { PipelineEngine } from '../src/pipelines/pipeline-engine.js';
import { clearPauseControl, getPauseControl, pauseAtCheckpoint, setPauseControl, taskSchedulingPaused, UserPauseReached } from '../src/agents/pause-control.js';
import { saveLoopCheckpoint, readLoopCheckpoint, type AgentLoopCheckpoint } from '../src/agents/loop-checkpoint.js';
import { initialAgentRunState } from '../src/agents/run-state.js';
import { eventBus } from '../src/events/event-bus.js';
import { getOrchestration, Orchestrator, reconcileOrchestrations } from '../src/agents/orchestrator.js';
import { runWriteOnce } from '../src/tools/write-once.js';
import express from 'express';
import { createTaskRoutes } from '../src/routes/tasks.js';
import type { AddressInfo } from 'node:net';

let databasePath: string;
beforeEach(() => {
  closeDb();
  databasePath = join(mkdtempSync(join(tmpdir(), 'myrmecia-user-pause-')), 'test.db');
  process.env.DB_PATH = databasePath;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  getDb();
  createAgent({ id: 'pause-fixture', name: 'Pause Fixture', role: 'dev' });
});
afterEach(() => {
  (eventBus as any).emitter.removeAllListeners();
  closeDb();
  delete process.env.DB_PATH;
  vi.restoreAllMocks();
});
const snapshot: AgentLoopCheckpoint = {
  schemaVersion: 1, boundary: 'stable',
  messages: [{ role: 'user', content: 'fixture' }, { role: 'assistant', content: 'already observed result' }],
  turn: 1, inputTokens: 100, outputTokens: 20, toolCallCount: 1, toolRuntimeMs: 30,
  elapsedMs: 45, finalOutput: 'already observed result',
};
function taskFixture(parentTaskId?: string) {
  return createTask({ title: 'Pause fixture', description: '', input: 'fixture', mode: 'direct',
    assigneeId: 'pause-fixture', parentTaskId, modelId: 'gpt-5.4' });
}
function queueFixture(capacity = false) {
  const executeTask = vi.fn().mockResolvedValue('fixture');
  const manager = { executeTask, hasCapacity: () => capacity, cancelTask: vi.fn() } as unknown as AgentManager;
  return { queue: new TaskQueue(manager), manager, executeTask };
}
function pausedRun() {
  const task = taskFixture();
  const execution = createExecution({ taskId: task.id, agentDefId: task.assigneeId!, modelId: task.modelId });
  saveLoopCheckpoint(task, execution.id, 'same-policy', snapshot);
  updateExecution(execution.id, { status: 'failed', completedAt: new Date().toISOString(),
    runState: { ...initialAgentRunState(), phase: 'interrupted', stopReason: 'interrupted', userPaused: true } });
  updateTask(task.id, { status: 'queued' });
  setPauseControl('task', task.id, 'paused', 'running');
  return { task, execution };
}

describe('durable user pause controls', () => {
  it('exercises authorized real HTTP pause/resume routes and retains viewer rejection', async () => {
    const task = taskFixture(), { queue } = queueFixture();
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes(queue));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tasks/${task.id}`;
    try {
      const denied = await fetch(`${base}/pause`, {
        method: 'POST', headers: { 'x-operator-id': 'viewer-fixture', 'x-operator-role': 'viewer' },
      });
      expect(denied.status).toBe(403);
      expect(getTask(task.id)?.pauseControl).toBeUndefined();
      const paused = await fetch(`${base}/pause`, { method: 'POST' });
      expect(paused.status).toBe(200);
      expect(await paused.json()).toMatchObject({ id: task.id, pauseControl: { state: 'paused' } });
      const replay = await fetch(`${base}/pause`, { method: 'POST' });
      expect(replay.status).toBe(200);
      const resumed = await fetch(`${base}/resume`, { method: 'POST' });
      expect(resumed.status).toBe(200);
      expect((await resumed.json()).pauseControl).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('rejects unsupported runtime pause without leaving a hold behind', async () => {
    const task = taskFixture(), { queue } = queueFixture();
    updateTask(task.id, { status: 'running' });
    const execution = createExecution({ taskId: task.id, agentDefId: task.assigneeId! });
    updateExecution(execution.id, { runState: { ...initialAgentRunState(), runtime: 'remote-http' } });
    await expect(queue.pauseTask(task.id)).rejects.toThrow('PAUSE_UNSUPPORTED');
    expect(getTask(task.id)?.pauseControl).toBeUndefined();
  });

  it('holds queued work idempotently, including across a database reopen', async () => {
    const task = taskFixture(), { queue, executeTask } = queueFixture();
    updateTask(task.id, { status: 'queued' });
    const paused = await queue.pauseTask(task.id);
    await queue.pauseTask(task.id);
    expect(paused.pauseControl?.state).toBe('paused');
    await (queue as any).processJob(task.id);
    expect(executeTask).not.toHaveBeenCalled();
    closeDb(); getDb();
    expect(getTask(task.id)?.pauseControl?.state).toBe('paused');
    await queue.recoverRunningTasks();
    expect(executeTask).not.toHaveBeenCalled();
    await queue.resumeTask(task.id);
    expect(getTask(task.id)?.pauseControl).toBeUndefined();
    expect(getTask(task.id)?.modelId).toBe('gpt-5.4');
  });

  it('requests a safe boundary without aborting an in-flight execution', async () => {
    const task = taskFixture(), { queue, manager } = queueFixture();
    updateTask(task.id, { status: 'running' });
    createExecution({ taskId: task.id, agentDefId: task.assigneeId! });
    expect((await queue.pauseTask(task.id)).pauseControl?.state).toBe('requested');
    expect(manager.cancelTask).not.toHaveBeenCalled();
    expect(() => pauseAtCheckpoint(task.id)).toThrow(UserPauseReached);
    await expect(queue.resumeTask(task.id)).rejects.toThrow('PAUSE_IN_PROGRESS');
    expect(getPauseControl('task', task.id)?.state).toBe('requested');
  });

  it('resumes the same identity and preserves complete turn observations and cumulative usage', async () => {
    const { task, execution } = pausedRun(), { queue } = queueFixture();
    await queue.resumeTask(task.id);
    const next = createExecution({ taskId: task.id, agentDefId: task.assigneeId! });
    const restored = readLoopCheckpoint(getTask(task.id)!, 'same-policy', next.id)!;
    expect(restored.executionId).toBe(execution.id);
    expect(restored.snapshot).toMatchObject(snapshot);
    expect(getTask(task.id)?.retryCount).toBe(0);
    expect(getTask(task.id)?.modelId).toBe(task.modelId);
  });

  it('fails closed if the model or tool policy changed after a user pause', () => {
    const { task } = pausedRun();
    const next = createExecution({ taskId: task.id, agentDefId: task.assigneeId! });
    expect(() => readLoopCheckpoint(task, 'different-model-or-tools', next.id)).toThrow('PAUSE_CHECKPOINT_INCOMPATIBLE');
  });

  it('refuses unsafe write replay without clearing the hold', async () => {
    const { task, execution } = pausedRun(), { queue } = queueFixture();
    const operation = vi.fn().mockResolvedValue('fixture write result');
    await runWriteOnce(task, execution.id, 'unknown_write', { fixture: true }, operation);
    await expect(queue.resumeTask(task.id)).rejects.toThrow('PAUSE_RECONCILIATION_REQUIRED');
    expect(getPauseControl('task', task.id)?.state).toBe('paused');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('holds descendants created after the parent pause and leaves other sessions unaffected', async () => {
    const root = taskFixture(), other = taskFixture(), { queue } = queueFixture();
    await queue.pauseTask(root.id);
    const child = taskFixture(root.id);
    expect(taskSchedulingPaused(child.id)).toBe(true);
    expect(taskSchedulingPaused(other.id)).toBe(false);
    expect(() => pauseAtCheckpoint(child.id)).toThrow(UserPauseReached);
    clearPauseControl('task', root.id);
    expect(taskSchedulingPaused(child.id)).toBe(false);
  });

  it('does not auto-recover a pause interrupted before a stable checkpoint', async () => {
    const task = taskFixture(), { queue, executeTask } = queueFixture();
    updateTask(task.id, { status: 'running' });
    const execution = createExecution({ taskId: task.id, agentDefId: task.assigneeId! });
    setPauseControl('task', task.id, 'requested', 'running');
    await queue.recoverRunningTasks();
    expect(executeTask).not.toHaveBeenCalled();
    expect(getTask(task.id)).toMatchObject({
      status: 'failed', pauseControl: { state: 'paused' },
      error: expect.stringContaining('PAUSE_RECONCILIATION_REQUIRED'),
    });
    await expect(queue.resumeTask(task.id)).rejects.toThrow('PAUSE_RECONCILIATION_REQUIRED');
    expect(getDb().get<any>('SELECT status FROM task_executions WHERE id = ?', execution.id)?.status).toBe('failed');
  });

  it('resumes a user-held manual pipeline without approving its gate', async () => {
    const { queue, manager } = queueFixture();
    const engine = new PipelineEngine(queue, manager);
    const pipeline = createPipeline({ name: 'manual gate', input: 'fixture', gateMode: 'manual', stages: [] });
    updatePipeline(pipeline.id, { status: 'paused' });
    await engine.pause(pipeline.id);
    await expect(engine.approveGate(pipeline.id)).rejects.toThrow('PIPELINE_PAUSED');
    await engine.resume(pipeline.id);
    expect(getPipeline(pipeline.id)?.status).toBe('paused');
    expect(getPipeline(pipeline.id)?.pauseControl).toBeUndefined();
  });
});

describe('truthful orchestration ownership', () => {
  function plan(id: string, pipelineId?: string) {
    getDb().run(`INSERT INTO orchestrations(id,input,intent,status,task_ids,pipeline_id)
      VALUES (?,?,'{}','running','[]',?)`, id, 'fixture', pipelineId || null);
  }
  it('settles a historical ownerless running plan as unknown failure, not invented success', () => {
    plan('orphan');
    reconcileOrchestrations();
    expect(getOrchestration('orphan')).toMatchObject({ status: 'failed', result: expect.stringContaining('OWNER_MISSING') });
    const completedAt = getOrchestration('orphan')!.completedAt;
    reconcileOrchestrations();
    expect(getOrchestration('orphan')!.completedAt).toBe(completedAt);
  });
  it('keeps pipeline ownership while async tasks are absent, then follows tasks and pipeline outcome', () => {
    const pipeline = createPipeline({ name: 'async pipeline', input: 'fixture', stages: [] });
    plan('linked', pipeline.id);
    reconcileOrchestrations();
    expect(getOrchestration('linked')).toMatchObject({ status: 'running', pipelineId: pipeline.id, taskIds: [] });
    const task = createTask({ title: 'late task', input: 'fixture', description: '', mode: 'pipeline', pipelineId: pipeline.id });
    reconcileOrchestrations();
    expect(getOrchestration('linked')!.taskIds).toEqual([task.id]);
    setPauseControl('pipeline', pipeline.id, 'paused', 'running');
    reconcileOrchestrations();
    expect(getOrchestration('linked')!.status).toBe('paused');
    updatePipeline(pipeline.id, { status: 'done', completedAt: new Date().toISOString() });
    reconcileOrchestrations();
    expect(getOrchestration('linked')!.status).toBe('done');
  });
  it('captures tasks arriving through the actual event envelope after pipeline dispatch', () => {
    const { queue } = queueFixture();
    new Orchestrator(queue, {} as PipelineEngine);
    const pipeline = createPipeline({ name: 'async owner', input: 'fixture', stages: [] });
    plan('event-linked', pipeline.id);
    const task = createTask({ title: 'late task', input: 'fixture', description: '', mode: 'pipeline', pipelineId: pipeline.id });
    eventBus.emit('task:created', { taskId: task.id });
    expect(getOrchestration('event-linked')!.taskIds).toEqual([task.id]);
  });
  it('projects user pause separately from a manual approval hold without mutating reads', () => {
    const pipeline = createPipeline({ name: 'approval gate', input: 'fixture', stages: [] });
    plan('gate-linked', pipeline.id);
    updatePipeline(pipeline.id, { status: 'paused' });
    expect(getOrchestration('gate-linked')).toMatchObject({ status: 'paused' });
    expect(getOrchestration('gate-linked')?.pauseControl).toBeUndefined();
    expect(getDb().get<any>('SELECT status FROM orchestrations WHERE id = ?', 'gate-linked')?.status).toBe('running');
    setPauseControl('pipeline', pipeline.id, 'paused', 'paused');
    expect(getOrchestration('gate-linked')?.pauseControl?.state).toBe('paused');
  });
});
