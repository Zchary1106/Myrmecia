import { AgentRunStopped } from './run-state.js';
import { getDb } from '../db/database.js';
import { taskMayHaveSideEffects } from './retry-ownership.js';
import { fencedRunWrite } from './run-coordinator.js';
import type { Task } from '../types.js';
import { createHash } from 'node:crypto';
export class RuntimeSliceYield extends AgentRunStopped {
  constructor() { super('interrupted', 'RUNTIME_SLICE_YIELD: stable read-only boundary; durable continuation queued'); }
}
export function continuationEnabled(): boolean { return process.env.MYRMECIA_BOUNDED_CONTINUATION === 'true'; }
export function createSliceDeadlineGuard(controller: AbortController, deadline: number) {
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, Math.max(1, deadline - Date.now()));
  timer.unref();
  return { get expired() { return expired; }, close: () => clearTimeout(timer) };
}
export function resolveSliceDeadline(start: number, elapsedBefore: number, taskLimit: number, sliceLimit = 600_000): number {
  if (![start, elapsedBefore, taskLimit, sliceLimit].every(value => Number.isFinite(value) && value >= 0)
    || !taskLimit || !sliceLimit || sliceLimit > 600_000) throw new Error('RUNTIME_SLICE_LIMIT_INVALID');
  const remaining = taskLimit - elapsedBefore;
  if (remaining <= 0) throw new AgentRunStopped('deadline', 'Cumulative task wall-clock budget exhausted');
  return start + Math.min(sliceLimit, remaining);
}
export function scheduleContinuation(task: Task, executionId: string, elapsedMs: number, maxTaskMs: number): void {
  if (!continuationEnabled() || taskMayHaveSideEffects(task.id)) throw new Error('RECOVERY_REQUIRES_REVIEW: continuation requires a stable read-only execution');
  if (elapsedMs >= maxTaskMs) throw new AgentRunStopped('deadline', 'Cumulative task deadline reached');
  fencedRunWrite(task.id, () => getDb().run(`INSERT INTO agent_run_continuations(workspace_id, task_id, execution_id, elapsed_ms, wakeup_at, status)
    VALUES (?, ?, ?, ?, ?, 'pending') ON CONFLICT(workspace_id, task_id) DO UPDATE SET execution_id = excluded.execution_id,
      elapsed_ms = MAX(agent_run_continuations.elapsed_ms, excluded.elapsed_ms), wakeup_at = excluded.wakeup_at, status = 'pending'`,
    task.workspaceId || 'default', task.id, executionId, elapsedMs, Date.now()));
}
export function continuationJobId(task: Task): string {
  const row = getDb().get<{ execution_id: string }>(`SELECT execution_id FROM agent_run_continuations
    WHERE workspace_id = ? AND task_id = ? AND status IN ('pending','dispatched')`, task.workspaceId || 'default', task.id);
  // BullMQ custom IDs cannot contain colons. The prior slice supplies an immutable identity.
  return row ? `${task.id}-slice-${createHash('sha256').update(row.execution_id).digest('hex').slice(0, 16)}` : task.id;
}
export function markContinuationStarted(task: Task): void {
  fencedRunWrite(task.id, () => getDb().run(`UPDATE agent_run_continuations SET status = 'dispatched'
    WHERE workspace_id = ? AND task_id = ? AND status = 'pending' AND wakeup_at <= ?`,
    task.workspaceId || 'default', task.id, Date.now()));
}
export function settleContinuation(task: Task): void {
  fencedRunWrite(task.id, () => getDb().run(`UPDATE agent_run_continuations SET status = 'settled'
    WHERE workspace_id = ? AND task_id = ? AND status IN ('pending','dispatched')`, task.workspaceId || 'default', task.id));
}
