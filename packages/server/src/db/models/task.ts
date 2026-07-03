import { getDb } from '../database.js';
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
    domainId: row.domain_id || undefined,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function createTask(data: {
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
  domainId?: string;
  dependsOn?: string[];
  maxRetries?: number;
}): Task {
  const db = getDb();
  const id = `task_${uuid().slice(0, 8)}`;

  db.run(`
    INSERT INTO tasks (id, title, description, mode, priority, assignee_id, created_by,
      parent_task_id, pipeline_id, stage_index, input, workdir, workspace_path, workspace_id, domain_id, depends_on, max_retries)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    id, data.title, data.description, data.mode,
    data.priority || 'normal', data.assigneeId || null, data.createdBy || 'user',
    data.parentTaskId || null, data.pipelineId || null, data.stageIndex ?? null,
    data.input, data.workdir || null, data.workspacePath || null,
    data.workspaceId || 'default', data.domainId || null,
    JSON.stringify(data.dependsOn || []), data.maxRetries ?? 2
  );

  return getTask(id)!;
}

export function getTask(id: string): Task | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM tasks WHERE id = ?', id);
  return row ? rowToTask(row) : undefined;
}

export function listTasks(filter?: {
  status?: TaskStatus;
  mode?: TaskMode;
  assigneeId?: string;
  pipelineId?: string;
  parentTaskId?: string;
  workspaceId?: string;
  limit?: number;
  offset?: number;
}): Task[] {
  const db = getDb();
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

  return db.all(sql, ...params).map(rowToTask);
}

/**
 * Non-terminal tasks that declare a dependency on `dependencyId`. Uses a coarse
 * LIKE pre-filter on the JSON `depends_on` column (matching the quoted id), then
 * the caller should exact-check `dependsOn.includes(id)` to be safe against LIKE
 * wildcard/substring matches. Far cheaper than scanning every non-terminal task.
 */
export function listDependents(
  dependencyId: string,
  statuses: TaskStatus[] = ['pending', 'queued', 'assigned'],
): Task[] {
  if (statuses.length === 0) return [];
  const db = getDb();
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db.all(
    `SELECT * FROM tasks WHERE status IN (${placeholders}) AND depends_on LIKE ?`,
    ...statuses,
    `%"${dependencyId}"%`,
  );
  return rows.map(rowToTask);
}

export function updateTask(id: string, updates: Partial<{
  status: TaskStatus;
  assigneeId: string | null;
  output: string | null;
  workspacePath: string | null;
  error: string | null;
  retryCount: number;
  startedAt: string | null;
  completedAt: string | null;
}>): Task | undefined {
  const db = getDb();
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

  if (sets.length === 0) return getTask(id);
  params.push(id);
  db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getTask(id);
}

export function deleteTask(id: string): boolean {
  const db = getDb();
  const result = db.run('DELETE FROM tasks WHERE id = ?', id);
  return result.changes > 0;
}

// Task Logs
export function addTaskLog(taskId: string, level: string, message: string, source: string): LogEntry {
  const db = getDb();
  const result = db.run(
    'INSERT INTO task_logs (task_id, level, message, source) VALUES (?, ?, ?, ?)',
    taskId, level, message, source
  );

  return {
    id: Number(result.lastInsertRowid),
    taskId, level: level as LogEntry['level'], message, source,
    createdAt: new Date().toISOString(),
  };
}

export function getTaskLogs(taskId: string, opts?: { limit?: number; since?: string }): LogEntry[] {
  const db = getDb();
  let sql = 'SELECT * FROM task_logs WHERE task_id = ?';
  const params: any[] = [taskId];

  if (opts?.since) { sql += ' AND created_at > ?'; params.push(opts.since); }
  sql += ' ORDER BY created_at DESC';
  if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

  return db.all(sql, ...params).map((row: any) => ({
    ...row,
    taskId: row.task_id,
    createdAt: row.created_at,
  }));
}
