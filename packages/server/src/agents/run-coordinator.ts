import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Task } from '../types.js';
import { activeRunLease, assertRunLease, claimRun, commitRunEvent, releaseRunLease, renewRunLease, type RunLease } from '../db/models/run-ownership.js';
import { runtimeV2Enabled } from './runtime-version.js';
import { getDb } from '../db/database.js';
import { taskMayHaveSideEffects } from './retry-ownership.js';

const ownership = new AsyncLocalStorage<RunLease>();
export function currentRunLease(): RunLease | undefined { return ownership.getStore(); }

/** Operator lifecycle writes are separate. Runtime commits must carry their original fence. */
export function assertRunWrite(taskId: string): void {
  const lease = ownership.getStore();
  if (lease?.taskId === taskId) assertRunLease(lease);
}

export function fencedRunWrite<T>(taskId: string | undefined, write: () => T): T {
  const lease = ownership.getStore();
  return lease && lease.taskId === taskId ? commitRunEvent(lease, write) : write();
}

export function reconcileInterruptedRun(task: Task): 'active_owner' | 'review_required' | 'read_only_recovery' {
  if (activeRunLease(task.id, task.workspaceId || 'default')) return 'active_owner';
  if (taskMayHaveSideEffects(task.id)) return 'review_required';
  const pending = getDb().get<{ snapshot: string }>(`SELECT snapshot FROM agent_loop_checkpoints
    WHERE workspace_id = ? AND task_id = ? AND resumable = 0 ORDER BY updated_at DESC LIMIT 1`,
    task.workspaceId || 'default', task.id);
  try {
    if (pending && JSON.parse(pending.snapshot).boundary === 'request_pending') return 'review_required';
  } catch { return 'review_required'; }
  if (getDb().get(`SELECT 1 FROM agent_provider_sessions
    WHERE workspace_id = ? AND task_id = ? AND status = 'pending'`, task.workspaceId || 'default', task.id)) return 'review_required';
  // Release only trusted read locks; retain any unresolved write/unknown claim and budget reservation.
  getDb().run(`UPDATE agent_tool_resource_locks SET status = 'released'
    WHERE workspace_id = ? AND task_id = ? AND effect = 'read' AND status = 'held'`, task.workspaceId || 'default', task.id);
  getDb().run(`UPDATE agent_run_continuations SET status = 'pending'
    WHERE workspace_id = ? AND task_id = ? AND status = 'dispatched'`, task.workspaceId || 'default', task.id);
  return 'read_only_recovery';
}

export async function withOwnedRun<T>(task: Task, execute: () => Promise<T>): Promise<T> {
  if (!runtimeV2Enabled()) return execute();
  const lease = claimRun({ taskId: task.id, workspaceId: task.workspaceId || 'default', owner: `worker:${randomUUID()}` });
  const heartbeat = setInterval(() => {
    try { renewRunLease(lease); } catch { /* dispatch and commit gates fail closed on the old token */ }
  }, 20_000);
  heartbeat.unref();
  try { return await ownership.run(lease, execute); }
  finally { clearInterval(heartbeat); releaseRunLease(lease); }
}
