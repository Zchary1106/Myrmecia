import { getDb } from '../database.js';
import type { OperatorAction, OperatorActor } from '../../types.js';

function rowToOperatorAction(row: any): OperatorAction {
  return {
    id: row.id,
    action: row.action,
    actor: {
      id: row.actor_id,
      role: row.actor_role,
      source: row.actor_source,
    },
    targetType: row.target_type,
    targetId: row.target_id || undefined,
    taskId: row.task_id || undefined,
    pipelineId: row.pipeline_id || undefined,
    inboxEntryId: row.inbox_entry_id || undefined,
    status: row.status,
    metadata: JSON.parse(row.metadata || '{}'),
    createdAt: row.created_at,
  };
}

export function createOperatorAction(data: {
  action: string;
  actor: OperatorActor;
  targetType: OperatorAction['targetType'];
  targetId?: string;
  taskId?: string;
  pipelineId?: string;
  inboxEntryId?: string;
  status?: OperatorAction['status'];
  metadata?: Record<string, unknown>;
}): OperatorAction {
  const db = getDb();
  const result = db.run(`
    INSERT INTO operator_actions (
      action, actor_id, actor_role, actor_source, target_type, target_id,
      task_id, pipeline_id, inbox_entry_id, status, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    data.action,
    data.actor.id,
    data.actor.role,
    data.actor.source,
    data.targetType,
    data.targetId || null,
    data.taskId || null,
    data.pipelineId || null,
    data.inboxEntryId || null,
    data.status || 'success',
    JSON.stringify(data.metadata || {}),
  );
  return getOperatorAction(Number(result.lastInsertRowid))!;
}

export function getOperatorAction(id: number): OperatorAction | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM operator_actions WHERE id = ?', id);
  return row ? rowToOperatorAction(row) : undefined;
}

export function listOperatorActions(filter?: {
  action?: string;
  actorId?: string;
  targetType?: OperatorAction['targetType'];
  taskId?: string;
  pipelineId?: string;
  inboxEntryId?: string;
  limit?: number;
}): OperatorAction[] {
  const db = getDb();
  let sql = 'SELECT * FROM operator_actions';
  const params: any[] = [];
  const conditions: string[] = [];

  if (filter?.action) { conditions.push('action = ?'); params.push(filter.action); }
  if (filter?.actorId) { conditions.push('actor_id = ?'); params.push(filter.actorId); }
  if (filter?.targetType) { conditions.push('target_type = ?'); params.push(filter.targetType); }
  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter?.pipelineId) { conditions.push('pipeline_id = ?'); params.push(filter.pipelineId); }
  if (filter?.inboxEntryId) { conditions.push('inbox_entry_id = ?'); params.push(filter.inboxEntryId); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(filter?.limit || 100);

  return db.all(sql, ...params).map(rowToOperatorAction);
}
