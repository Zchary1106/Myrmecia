import { getDb } from '../database.js';
import { getTask } from './task.js';

export interface RunLease {
  taskId: string; workspaceId: string; owner: string; token: number; leaseUntil: number; firstStartedAtMs: number;
}
export function claimRun(data: { taskId: string; workspaceId: string; owner: string; nowMs?: number; leaseMs?: number }): RunLease {
  const now = data.nowMs ?? Date.now();
  const duration = data.leaseMs ?? 60_000;
  const task = getTask(data.taskId);
  if (!task || (task.workspaceId || 'default') !== data.workspaceId || ['done', 'cancelled'].includes(task.status)) throw new Error('RUN_CLAIM_SCOPE_DENIED');
  if (!data.owner || !Number.isSafeInteger(now) || duration < 1 || duration > 60_000) throw new Error('RUN_LEASE_INVALID');
  return getDb().transaction(() => {
    getDb().run(`INSERT INTO agent_run_ownership(workspace_id, task_id, owner, fence_token, lease_until, first_started_at_ms)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(workspace_id, task_id) DO UPDATE SET owner = excluded.owner,
        fence_token = agent_run_ownership.fence_token + 1, lease_until = excluded.lease_until,
        first_started_at_ms = CASE WHEN agent_run_ownership.first_started_at_ms > 0
          THEN agent_run_ownership.first_started_at_ms ELSE excluded.first_started_at_ms END
      WHERE agent_run_ownership.lease_until <= ?`,
      data.workspaceId, data.taskId, data.owner, now + duration, now, now);
    const row = activeRunLease(data.taskId, data.workspaceId, now);
    if (!row || row.owner !== data.owner) throw new Error('RUN_ALREADY_OWNED');
    return row;
  });
}
export function activeRunLease(taskId: string, workspaceId: string, nowMs = Date.now()): RunLease | undefined {
  const row = getDb().get<any>(`SELECT * FROM agent_run_ownership WHERE task_id = ? AND workspace_id = ? AND lease_until > ?`,
    taskId, workspaceId, nowMs);
  return row ? { taskId: row.task_id, workspaceId: row.workspace_id, owner: row.owner,
    token: row.fence_token, leaseUntil: row.lease_until, firstStartedAtMs: row.first_started_at_ms } : undefined;
}
export function assertRunLease(lease: RunLease, nowMs = Date.now()): void {
  const active = activeRunLease(lease.taskId, lease.workspaceId, nowMs);
  if (!active || active.owner !== lease.owner || active.token !== lease.token) throw new Error('RUN_FENCE_LOST');
}
export function renewRunLease(lease: RunLease, nowMs = Date.now(), leaseMs = 60_000): RunLease {
  if (!Number.isSafeInteger(nowMs) || leaseMs < 1 || leaseMs > 60_000) throw new Error('RUN_LEASE_INVALID');
  const result = getDb().run(`UPDATE agent_run_ownership SET lease_until = ?
    WHERE workspace_id = ? AND task_id = ? AND owner = ? AND fence_token = ? AND lease_until > ?`,
    nowMs + leaseMs, lease.workspaceId, lease.taskId, lease.owner, lease.token, nowMs);
  if (result.changes !== 1) throw new Error('RUN_FENCE_LOST');
  return { ...lease, leaseUntil: nowMs + leaseMs };
}
export function releaseRunLease(lease: RunLease): void {
  getDb().run(`UPDATE agent_run_ownership SET lease_until = 0
    WHERE workspace_id = ? AND task_id = ? AND owner = ? AND fence_token = ?`,
    lease.workspaceId, lease.taskId, lease.owner, lease.token);
}
export function commitRunEvent<T>(lease: RunLease, write: () => T): T {
  return getDb().transaction(() => {
    // A conditional write acquires the DB write lock before checking/committing dependent state.
    const checked = getDb().run(`UPDATE agent_run_ownership SET lease_until = lease_until
      WHERE workspace_id = ? AND task_id = ? AND owner = ? AND fence_token = ? AND lease_until > ?`,
      lease.workspaceId, lease.taskId, lease.owner, lease.token, Date.now());
    if (checked.changes !== 1) throw new Error('RUN_FENCE_LOST');
    return write();
  });
}
