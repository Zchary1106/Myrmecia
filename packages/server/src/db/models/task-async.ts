/**
 * Async Task Model — uses getAsyncDb() for non-blocking database access.
 * Preferred over sync version in production (route handlers).
 */

import { getAsyncDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { Task, TaskMode, TaskStatus, Priority, LogEntry } from '../../types.js';

function rowToTask(row: any): Task {
  return {
    ...row,
    dependsOn: JSON.parse(row.depends_on || '[]'),
    assigneeId: row.assignee_id,
    createdBy: row.created_by,
    parentTaskId: row.parent_task_id,
    pipelineId: row.pipeline_id,
    stageIndex: row.stage_index,
    workspacePath: row.workspace_path,
    workspaceId: row.workspace_id || 'default',
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function createTaskAsync(data: {
  title: string;
  description: string;
  mode: TaskMode;
  priority?: Priority;
  assigneeId?: string;
  createdBy?: 'user' | 'master';
  parentTaskId?: string;
  pipelineId?: string;
  stageIndex?: number;
  input: string;
  workdir?: string;
  workspacePath?: string;
  workspaceId?: string;
  dependsOn?: string[];
  maxRetries?: number;
}): Promise<Task> {
  const db = getAsyncDb();
  const id = `task_${uuid().slice(0, 8)}`;

  await db.run(`
    INSERT INTO tasks (id, title, description, mode, priority, assignee_id, created_by,
      parent_task_id, pipeline_id, stage_index, input, workdir, workspace_path, depends_on, max_retries, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    id, data.title, data.description, data.mode,
    data.priority || 'normal', data.assigneeId || null, data.createdBy || 'user',
    data.parentTaskId || null, data.pipelineId || null, data.stageIndex ?? null,
    data.input, data.workdir || null, data.workspacePath || null,
    JSON.stringify(data.dependsOn || []), data.maxRetries ?? 2,
    data.workspaceId || 'default'
  );

  return (await getTaskAsync(id))!;
}

export async function getTaskAsync(id: string): Promise<Task | undefined> {
  const db = getAsyncDb();
  const row = await db.get('SELECT * FROM tasks WHERE id = ?', id);
  return row ? rowToTask(row) : undefined;
}

export async function listTasksAsync(filter?: {
  status?: TaskStatus;
  mode?: TaskMode;
  assigneeId?: string;
  pipelineId?: string;
  parentTaskId?: string;
  workspaceId?: string;
  limit?: number;
  offset?: number;
}): Promise<Task[]> {
  const db = getAsyncDb();
  let sql = 'SELECT * FROM tasks';
  const params: any[] = [];
  const conditions: string[] = [];

  if (filter?.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
  if (filter?.mode) { conditions.push('mode = ?'); params.push(filter.mode); }
  if (filter?.assigneeId) { conditions.push('assignee_id = ?'); params.push(filter.assigneeId); }
  if (filter?.pipelineId) { conditions.push('pipeline_id = ?'); params.push(filter.pipelineId); }
  if (filter?.parentTaskId) { conditions.push('parent_task_id = ?'); params.push(filter.parentTaskId); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
  if (filter?.offset) { sql += ' OFFSET ?'; params.push(filter.offset); }

  const rows = await db.all(sql, ...params);
  return rows.map(rowToTask);
}

export async function updateTaskAsync(id: string, updates: Partial<{
  status: TaskStatus;
  assigneeId: string | null;
  output: string | null;
  workspacePath: string | null;
  error: string | null;
  retryCount: number;
  startedAt: string | null;
  completedAt: string | null;
}>): Promise<Task | undefined> {
  const db = getAsyncDb();
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.assigneeId !== undefined) { sets.push('assignee_id = ?'); params.push(updates.assigneeId); }
  if (updates.output !== undefined) { sets.push('output = ?'); params.push(updates.output); }
  if (updates.workspacePath !== undefined) { sets.push('workspace_path = ?'); params.push(updates.workspacePath); }
  if (updates.error !== undefined) { sets.push('error = ?'); params.push(updates.error); }
  if (updates.retryCount !== undefined) { sets.push('retry_count = ?'); params.push(updates.retryCount); }
  if (updates.startedAt !== undefined) { sets.push('started_at = ?'); params.push(updates.startedAt); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt); }

  if (sets.length === 0) return getTaskAsync(id);
  params.push(id);
  await db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getTaskAsync(id);
}

export async function deleteTaskAsync(id: string): Promise<boolean> {
  const db = getAsyncDb();
  const result = await db.run('DELETE FROM tasks WHERE id = ?', id);
  return result.changes > 0;
}

export async function addTaskLogAsync(taskId: string, level: string, message: string, source: string): Promise<LogEntry> {
  const db = getAsyncDb();
  const result = await db.run(
    'INSERT INTO task_logs (task_id, level, message, source) VALUES (?, ?, ?, ?)',
    taskId, level, message, source
  );

  return {
    id: Number(result.lastInsertRowid),
    taskId, level: level as LogEntry['level'], message, source,
    createdAt: new Date().toISOString(),
  };
}

export async function getTaskLogsAsync(taskId: string, opts?: { limit?: number; since?: string }): Promise<LogEntry[]> {
  const db = getAsyncDb();
  let sql = 'SELECT * FROM task_logs WHERE task_id = ?';
  const params: any[] = [taskId];

  if (opts?.since) { sql += ' AND created_at > ?'; params.push(opts.since); }
  sql += ' ORDER BY created_at DESC';
  if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

  const rows = await db.all(sql, ...params);
  return rows.map((row: any) => ({
    ...row,
    taskId: row.task_id,
    createdAt: row.created_at,
  }));
}
