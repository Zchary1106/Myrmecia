import { getDb } from '../database.js';
import type { PlatformEvent, PlatformEventSeverity, WSEventType } from '../../types.js';
import type { BusEvent } from '../../events/event-bus.js';
import { getTask } from './task.js';
import { getPipeline } from './pipeline.js';
import { getExecution } from './execution.js';

function rowToPlatformEvent(row: any): PlatformEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    severity: row.severity,
    taskId: row.task_id || undefined,
    pipelineId: row.pipeline_id || undefined,
    agentId: row.agent_id || undefined,
    executionId: row.execution_id || undefined,
    inboxEntryId: row.inbox_entry_id || undefined,
    qualityAttemptId: row.quality_attempt_id || undefined,
    workspaceId: row.workspace_id || undefined,
    payload: JSON.parse(row.payload || '{}'),
    createdAt: row.created_at,
  };
}

function eventWorkspaceId(payload: any, refs: ReturnType<typeof eventRefs>): string {
  return payload?.workspaceId
    || payload?.task?.workspaceId
    || payload?.pipeline?.workspaceId
    || payload?.entry?.workspaceId
    || payload?.notification?.workspaceId
    || (refs.taskId ? getTask(refs.taskId)?.workspaceId : undefined)
    || (refs.pipelineId ? getPipeline(refs.pipelineId)?.workspaceId : undefined)
    || (refs.executionId ? getExecution(refs.executionId)?.workspaceId : undefined)
    || 'default';
}

function eventSeverity(type: WSEventType, payload: any): PlatformEventSeverity {
  if (type.includes('failed') || payload?.error) return 'error';
  if (type.includes('cancelled') || type === 'task:log' && payload?.level === 'warn') return 'warn';
  return 'info';
}

function eventRefs(payload: any) {
  return {
    taskId: payload?.taskId || payload?.task?.id || payload?.attempt?.taskId,
    pipelineId: payload?.pipelineId || payload?.pipeline?.id,
    agentId: payload?.agentId || payload?.agentDefId,
    executionId: payload?.executionId,
    inboxEntryId: payload?.inboxEntryId || payload?.entry?.id,
    qualityAttemptId: payload?.attempt?.id,
  };
}

export function recordPlatformEvent(event: BusEvent): PlatformEvent {
  const db = getDb();
  const payload = event.payload as any;
  const refs = eventRefs(payload);
  const workspaceId = eventWorkspaceId(payload, refs);
  const result = db.run(`
    INSERT INTO platform_events (
      event_type, severity, task_id, pipeline_id, agent_id, execution_id,
      inbox_entry_id, quality_attempt_id, workspace_id, payload, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    event.type,
    eventSeverity(event.type, payload),
    refs.taskId || null,
    refs.pipelineId || null,
    refs.agentId || null,
    refs.executionId || null,
    refs.inboxEntryId || null,
    refs.qualityAttemptId || null,
    workspaceId,
    JSON.stringify(payload || {}),
    event.timestamp,
  );
  return getPlatformEvent(Number(result.lastInsertRowid))!;
}

export function getPlatformEvent(id: number): PlatformEvent | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM platform_events WHERE id = ?', id);
  return row ? rowToPlatformEvent(row) : undefined;
}

export function listPlatformEvents(filter?: {
  eventType?: WSEventType;
  severity?: PlatformEventSeverity;
  taskId?: string;
  pipelineId?: string;
  workspaceId?: string;
  limit?: number;
}): PlatformEvent[] {
  const db = getDb();
  let sql = 'SELECT * FROM platform_events';
  const params: any[] = [];
  const conditions: string[] = [];

  if (filter?.eventType) { conditions.push('event_type = ?'); params.push(filter.eventType); }
  if (filter?.severity) { conditions.push('severity = ?'); params.push(filter.severity); }
  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter?.pipelineId) { conditions.push('pipeline_id = ?'); params.push(filter.pipelineId); }
  if (filter?.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY id DESC';
  sql += ' LIMIT ?';
  params.push(filter?.limit || 100);

  return db.all(sql, ...params).map(rowToPlatformEvent);
}

export function countPlatformEvents(workspaceId?: string): number {
  const db = getDb();
  const row = workspaceId
    ? db.get('SELECT COUNT(*) AS count FROM platform_events WHERE workspace_id = ?', workspaceId)
    : db.get('SELECT COUNT(*) AS count FROM platform_events');
  return row?.count || 0;
}
