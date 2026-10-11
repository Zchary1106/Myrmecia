import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution } from '../src/db/models/execution.js';
import { continuationJobId, createSliceDeadlineGuard, markContinuationStarted, resolveSliceDeadline, scheduleContinuation, settleContinuation } from '../src/agents/runtime-continuation.js';
import { saveLoopCheckpoint, readLoopCheckpoint } from '../src/agents/loop-checkpoint.js';
import { reconcileInterruptedRun } from '../src/agents/run-coordinator.js';
beforeEach(() => { process.env.DB_PATH = ':memory:'; process.env.MYRMECIA_BOUNDED_CONTINUATION = 'true'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; delete process.env.MYRMECIA_BOUNDED_CONTINUATION; vi.useRealTimers(); });
describe('bounded persistent continuation', () => {
  it('aborts an in-flight tool/resource wait at the slice deadline and does not leave a timer after cleanup', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const controller = new AbortController();
    const guard = createSliceDeadlineGuard(controller, 1100);
    await vi.advanceTimersByTimeAsync(99);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(guard.expired).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    guard.close();
    const second = new AbortController();
    createSliceDeadlineGuard(second, 1200).close();
    await vi.advanceTimersByTimeAsync(100);
    expect(second.signal.aborted).toBe(false);
  });
  it('keeps each slice below ten minutes while never resetting the cumulative task clock', () => {
    expect(resolveSliceDeadline(100, 0, 1_200_000)).toBe(600_100);
    expect(resolveSliceDeadline(700_000, 600_000, 1_200_000)).toBe(1_300_000);
    expect(() => resolveSliceDeadline(1_500_000, 1_200_000, 1_200_000)).toThrow('Cumulative');
    expect(() => resolveSliceDeadline(0, 0, 1_800_000, 600_001)).toThrow('INVALID');
  });
  it('persists a wakeup separately from a failed-task retry and refuses an exhausted task budget', () => {
    const task = createTask({ title: 'fixture', input: 'fixture', description: '', mode: 'direct' });
    const run = createExecution({ taskId: task.id, agentDefId: 'fixture' });
    scheduleContinuation(task, run.id, 600_000, 1_200_000);
    scheduleContinuation(task, run.id, 700_000, 1_200_000);
    expect(getDb().get<any>('SELECT * FROM agent_run_continuations')).toMatchObject({ elapsed_ms: 700_000, status: 'pending' });
    const jobId = continuationJobId(task);
    expect(jobId).not.toContain(':');
    expect(continuationJobId(task)).toBe(jobId);
    markContinuationStarted(task);
    expect(getDb().get<any>('SELECT status FROM agent_run_continuations').status).toBe('dispatched');
    settleContinuation(task);
    expect(getDb().get<any>('SELECT status FROM agent_run_continuations').status).toBe('settled');
    expect(() => scheduleContinuation(task, run.id, 1_200_000, 1_200_000)).toThrow('deadline');
  });
  it('does not make an in-flight request checkpoint automatically replayable', () => {
    const task = createTask({ title: 'fixture', input: 'fixture', description: '', mode: 'direct' });
    const run = createExecution({ taskId: task.id, agentDefId: 'fixture' });
    saveLoopCheckpoint(task, run.id, 'fingerprint', { schemaVersion: 1, messages: [], turn: 1,
      inputTokens: 100, outputTokens: 100, toolCallCount: 0, toolRuntimeMs: 0, elapsedMs: 50, finalOutput: '',
      boundary: 'request_pending', pendingRequestId: 'q1', journalCursor: 1 });
    expect(getDb().get<any>('SELECT resumable FROM agent_loop_checkpoints').resumable).toBe(0);
    expect(readLoopCheckpoint(task, 'fingerprint', 'new-run')).toBeUndefined();
    expect(reconcileInterruptedRun(task)).toBe('review_required');
  });
});
