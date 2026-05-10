import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { QualityLoopAttempt, QualityLoopAttemptStatus } from '../../types.js';

function rowToQualityLoopAttempt(row: any): QualityLoopAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    iteration: row.iteration,
    status: row.status,
    reviewTaskId: row.review_task_id || undefined,
    fixTaskId: row.fix_task_id || undefined,
    reviewerAgentId: row.reviewer_agent_id || undefined,
    developerAgentId: row.developer_agent_id || undefined,
    reviewOutput: row.review_output || undefined,
    fixOutput: row.fix_output || undefined,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || undefined,
  };
}

export function createQualityLoopAttempt(data: {
  taskId: string;
  iteration: number;
  status?: QualityLoopAttemptStatus;
  reviewTaskId?: string;
  fixTaskId?: string;
  reviewerAgentId?: string;
  developerAgentId?: string;
  reviewOutput?: string;
  fixOutput?: string;
  error?: string;
}): QualityLoopAttempt {
  const db = getDb();
  const id = `ql_${uuid().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO quality_loop_attempts (
      id, task_id, iteration, status, review_task_id, fix_task_id, reviewer_agent_id,
      developer_agent_id, review_output, fix_output, error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.taskId,
    data.iteration,
    data.status || 'reviewing',
    data.reviewTaskId || null,
    data.fixTaskId || null,
    data.reviewerAgentId || null,
    data.developerAgentId || null,
    data.reviewOutput || null,
    data.fixOutput || null,
    data.error || null,
  );
  return getQualityLoopAttempt(id)!;
}

export function getQualityLoopAttempt(id: string): QualityLoopAttempt | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM quality_loop_attempts WHERE id = ?').get(id) as any;
  return row ? rowToQualityLoopAttempt(row) : undefined;
}

export function listQualityLoopAttempts(filter?: {
  taskId?: string;
  status?: QualityLoopAttemptStatus;
  limit?: number;
}): QualityLoopAttempt[] {
  const db = getDb();
  let sql = 'SELECT * FROM quality_loop_attempts';
  const params: any[] = [];
  const conditions: string[] = [];

  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY iteration ASC, created_at ASC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }

  return (db.prepare(sql).all(...params) as any[]).map(rowToQualityLoopAttempt);
}

export function updateQualityLoopAttempt(id: string, updates: Partial<{
  status: QualityLoopAttemptStatus;
  reviewTaskId: string | null;
  fixTaskId: string | null;
  reviewerAgentId: string | null;
  developerAgentId: string | null;
  reviewOutput: string | null;
  fixOutput: string | null;
  error: string | null;
  completedAt: string | null;
}>): QualityLoopAttempt | undefined {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const params: any[] = [new Date().toISOString()];

  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.reviewTaskId !== undefined) { sets.push('review_task_id = ?'); params.push(updates.reviewTaskId); }
  if (updates.fixTaskId !== undefined) { sets.push('fix_task_id = ?'); params.push(updates.fixTaskId); }
  if (updates.reviewerAgentId !== undefined) { sets.push('reviewer_agent_id = ?'); params.push(updates.reviewerAgentId); }
  if (updates.developerAgentId !== undefined) { sets.push('developer_agent_id = ?'); params.push(updates.developerAgentId); }
  if (updates.reviewOutput !== undefined) { sets.push('review_output = ?'); params.push(updates.reviewOutput); }
  if (updates.fixOutput !== undefined) { sets.push('fix_output = ?'); params.push(updates.fixOutput); }
  if (updates.error !== undefined) { sets.push('error = ?'); params.push(updates.error); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt); }

  params.push(id);
  db.prepare(`UPDATE quality_loop_attempts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getQualityLoopAttempt(id);
}
