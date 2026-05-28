import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { Notification } from '../../types.js';

export function createNotification(data: {
  type: Notification['type'];
  title: string;
  message: string;
  taskId?: string;
  pipelineId?: string;
}): Notification {
  const db = getDb();
  const id = `notif_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO notifications (id, type, title, message, task_id, pipeline_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `, id, data.type, data.title, data.message, data.taskId || null, data.pipelineId || null);

  return {
    id, type: data.type, title: data.title, message: data.message,
    taskId: data.taskId, pipelineId: data.pipelineId,
    read: false, createdAt: new Date().toISOString(),
  };
}

export function listNotifications(opts?: { unreadOnly?: boolean; limit?: number }): Notification[] {
  const db = getDb();
  let sql = 'SELECT * FROM notifications';
  const params: any[] = [];
  if (opts?.unreadOnly) { sql += ' WHERE read = 0'; }
  sql += ' ORDER BY created_at DESC';
  if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

  return db.all(sql, ...params).map(row => ({
    ...row,
    read: !!row.read,
    taskId: row.task_id,
    pipelineId: row.pipeline_id,
    createdAt: row.created_at,
  }));
}

export function markNotificationRead(id: string): void {
  const db = getDb();
  db.run('UPDATE notifications SET read = 1 WHERE id = ?', id);
}

export function markAllNotificationsRead(): void {
  const db = getDb();
  db.run('UPDATE notifications SET read = 1 WHERE read = 0');
}
