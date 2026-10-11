import { getDb } from '../db/database.js';
import type { TaskPauseControl } from '@myrmecia/shared';

export function getPauseControl(kind: 'task' | 'pipeline', id: string): TaskPauseControl | undefined {
  const row = getDb().get<{ state: string; requested_at: string; paused_at: string | null; previous_status: string | null }>(
    'SELECT * FROM runtime_pause_controls WHERE target_kind = ? AND target_id = ?', kind, id,
  );
  return row ? {
    state: row.state as TaskPauseControl['state'], requestedAt: row.requested_at,
    pausedAt: row.paused_at || undefined, previousStatus: row.previous_status || undefined,
  } : undefined;
}

export function setPauseControl(kind: 'task' | 'pipeline', id: string, state: TaskPauseControl['state'], previousStatus?: string): void {
  const now = new Date().toISOString();
  getDb().run(`INSERT INTO runtime_pause_controls(target_kind,target_id,state,requested_at,paused_at,previous_status)
    VALUES (?,?,?,?,?,?) ON CONFLICT(target_kind,target_id) DO UPDATE SET
    state=excluded.state, paused_at=excluded.paused_at`,
  kind, id, state, now, state === 'paused' ? now : null, previousStatus || null);
}

export function clearPauseControl(kind: 'task' | 'pipeline', id: string): void {
  getDb().run('DELETE FROM runtime_pause_controls WHERE target_kind = ? AND target_id = ?', kind, id);
}

/** Scheduling checks include ancestors, so descendants created after pause also stay held. */
export function taskSchedulingPaused(taskId: string): boolean {
  const visited = new Set<string>();
  let id: string | null = taskId;
  while (id && !visited.has(id)) {
    visited.add(id);
    if (getPauseControl('task', id)) return true;
    const row: { parent_task_id: string | null; pipeline_id: string | null } | undefined = getDb().get(
      'SELECT parent_task_id,pipeline_id FROM tasks WHERE id = ?', id,
    );
    if (row?.pipeline_id && getPauseControl('pipeline', row.pipeline_id)) return true;
    id = row?.parent_task_id || null;
  }
  return false;
}

export class UserPauseReached extends Error {
  constructor() {
    super('USER_PAUSE: execution stopped at a complete model/tool turn checkpoint');
    this.name = 'UserPauseReached';
  }
}

export function pauseAtCheckpoint(taskId: string): void {
  if (taskSchedulingPaused(taskId)) throw new UserPauseReached();
}
