import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { InboxEntry, InboxEntryStatus, InboxEntryType } from '../../types.js';
import { getTask } from './task.js';
import { getPipeline } from './pipeline.js';
import { getExecution } from './execution.js';

function rowToInboxEntry(row: any): InboxEntry {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    title: row.title,
    message: row.message,
    options: JSON.parse(row.options || '[]'),
    response: row.response || undefined,
    taskId: row.task_id || undefined,
    pipelineId: row.pipeline_id || undefined,
    executionId: row.execution_id || undefined,
    workspaceId: row.workspace_id || 'default',
    createdBy: row.created_by,
    createdAt: row.created_at,
    respondedAt: row.responded_at || undefined,
  };
}

function inboxWorkspaceId(data: { workspaceId?: string; taskId?: string; pipelineId?: string; executionId?: string }): string {
  return data.workspaceId
    || (data.taskId ? getTask(data.taskId)?.workspaceId : undefined)
    || (data.pipelineId ? getPipeline(data.pipelineId)?.workspaceId : undefined)
    || (data.executionId ? getExecution(data.executionId)?.workspaceId : undefined)
    || 'default';
}

export function createInboxEntry(data: {
  type: InboxEntryType;
  title: string;
  message: string;
  options?: string[];
  taskId?: string;
  pipelineId?: string;
  executionId?: string;
  workspaceId?: string;
  createdBy?: InboxEntry['createdBy'];
}): InboxEntry {
  const db = getDb();
  const id = `inbox_${uuid().slice(0, 8)}`;
  const workspaceId = inboxWorkspaceId(data);
  db.run(`
    INSERT INTO inbox_entries (id, type, title, message, options, task_id, pipeline_id, execution_id, workspace_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    id,
    data.type,
    data.title,
    data.message,
    JSON.stringify(data.options || []),
    data.taskId || null,
    data.pipelineId || null,
    data.executionId || null,
    workspaceId,
    data.createdBy || 'system',
  );
  return getInboxEntry(id)!;
}

export function getInboxEntry(id: string): InboxEntry | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM inbox_entries WHERE id = ?', id);
  return row ? rowToInboxEntry(row) : undefined;
}

export function listInboxEntries(filter?: {
  status?: InboxEntryStatus;
  taskId?: string;
  pipelineId?: string;
  executionId?: string;
  workspaceId?: string;
  limit?: number;
}): InboxEntry[] {
  const db = getDb();
  let sql = 'SELECT * FROM inbox_entries';
  const params: any[] = [];
  const conditions: string[] = [];

  if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter?.pipelineId) { conditions.push('pipeline_id = ?'); params.push(filter.pipelineId); }
  if (filter?.executionId) { conditions.push('execution_id = ?'); params.push(filter.executionId); }
  if (filter?.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }

  return db.all(sql, ...params).map(rowToInboxEntry);
}

export function respondToInboxEntry(id: string, data: {
  status: Exclude<InboxEntryStatus, 'pending'>;
  response?: string;
}): InboxEntry | undefined {
  const db = getDb();
  db.run(`
    UPDATE inbox_entries
    SET status = ?, response = ?, responded_at = ?
    WHERE id = ?
  `, data.status, data.response || null, new Date().toISOString(), id);
  return getInboxEntry(id);
}
