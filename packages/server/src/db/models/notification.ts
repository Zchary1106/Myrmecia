import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { Notification } from '../../types.js';
import { getTask } from './task.js';
import { getPipeline } from './pipeline.js';

function rowToNotification(row: any): Notification {
  return {
    ...row,
    read: !!row.read,
    taskId: row.task_id || undefined,
    pipelineId: row.pipeline_id || undefined,
    workspaceId: row.workspace_id || 'default',
    createdAt: row.created_at,
  };
}

function notificationWorkspaceId(data: { workspaceId?: string; taskId?: string; pipelineId?: string }): string {
  return data.workspaceId
    || (data.taskId ? getTask(data.taskId)?.workspaceId : undefined)
    || (data.pipelineId ? getPipeline(data.pipelineId)?.workspaceId : undefined)
    || 'default';
}

export function createNotification(data: {
  type: Notification['type'];
  title: string;
  message: string;
  taskId?: string;
  pipelineId?: string;
  workspaceId?: string;
}): Notification {
  const db = getDb();
  const workspaceId = notificationWorkspaceId(data);
  const duplicate = db.get(`
    SELECT * FROM notifications
    WHERE type = ?
      AND title = ?
      AND message = ?
      AND COALESCE(task_id, '') = COALESCE(?, '')
      AND COALESCE(pipeline_id, '') = COALESCE(?, '')
      AND workspace_id = ?
      AND created_at >= datetime('now', '-30 seconds')
    ORDER BY created_at DESC
    LIMIT 1
  `, data.type, data.title, data.message, data.taskId || null, data.pipelineId || null, workspaceId) as any;
  if (duplicate) return rowToNotification(duplicate);

  const id = `notif_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO notifications (id, type, title, message, task_id, pipeline_id, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, id, data.type, data.title, data.message, data.taskId || null, data.pipelineId || null, workspaceId);

  return {
    id, type: data.type, title: data.title, message: data.message,
    taskId: data.taskId, pipelineId: data.pipelineId, workspaceId,
    read: false, createdAt: new Date().toISOString(),
  };
}

export function listNotifications(opts?: { unreadOnly?: boolean; workspaceId?: string; limit?: number }): Notification[] {
  const db = getDb();
  let sql = 'SELECT * FROM notifications';
  const params: any[] = [];
  const conditions: string[] = [];
  if (opts?.workspaceId) { conditions.push('workspace_id = ?'); params.push(opts.workspaceId); }
  if (opts?.unreadOnly) { conditions.push('read = 0'); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

  return db.all(sql, ...params).map(rowToNotification);
}

export function markNotificationRead(id: string, workspaceId?: string): void {
  const db = getDb();
  if (workspaceId) db.run('UPDATE notifications SET read = 1 WHERE id = ? AND workspace_id = ?', id, workspaceId);
  else db.run('UPDATE notifications SET read = 1 WHERE id = ?', id);
}

export function markAllNotificationsRead(workspaceId?: string): void {
  const db = getDb();
  if (workspaceId) db.run('UPDATE notifications SET read = 1 WHERE read = 0 AND workspace_id = ?', workspaceId);
  else db.run('UPDATE notifications SET read = 1 WHERE read = 0');
}
