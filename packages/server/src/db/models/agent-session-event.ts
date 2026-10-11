import { createHash, randomUUID } from 'node:crypto';
import type { AgentSessionEvent, AgentSessionPayload, Task } from '../../types.js';
import { getDb } from '../database.js';
import { getTask } from './task.js';
import { getExecution } from './execution.js';
import { conversationForTask } from './conversation.js';
import { dlpCheck } from '../../security/dlp.js';
import { fencedRunWrite } from '../../agents/run-coordinator.js';

export function agentSessionForTask(task: Task): string {
  const byId = new Map([[task.id, task]]);
  let current = task;
  while (current.parentTaskId && !byId.has(current.parentTaskId)) {
    const parent = getTask(current.parentTaskId);
    if (!parent) break;
    if ((parent.workspaceId || 'default') !== (task.workspaceId || 'default')) throw new Error('SESSION_WORKSPACE_MISMATCH');
    byId.set(parent.id, parent);
    current = parent;
  }
  const sessionId = conversationForTask(task, byId);
  if (sessionId.startsWith('pipeline:')) {
    const pipeline = getDb().get<{ workspace_id: string }>('SELECT workspace_id FROM pipelines WHERE id = ?', sessionId.slice(9));
    if (!pipeline || (pipeline.workspace_id || 'default') !== (task.workspaceId || 'default')) throw new Error('SESSION_PIPELINE_SCOPE_DENIED');
  }
  return sessionId;
}

function decode(row: any): AgentSessionEvent {
  return {
    eventId: row.event_id, schemaVersion: row.schema_version, workspaceId: row.workspace_id,
    sessionId: row.session_id, sequence: row.sequence, eventKey: row.event_key, runId: row.run_id,
    requestId: row.request_id || undefined, type: row.type,
    payload: JSON.parse(row.payload), payloadHash: row.payload_hash, createdAt: row.created_at,
  };
}

/** Atomic allocator + immutable idempotency binding. Events never trigger tool replay. */
export function appendSessionEvent(data: {
  workspaceId: string; sessionId: string; runId: string; requestId?: string;
  eventKey: string; payload: AgentSessionPayload;
}): AgentSessionEvent {
  if (!data.eventKey || data.eventKey.length > 256 || !data.workspaceId || !data.sessionId) throw new Error('SESSION_EVENT_IDENTITY_INVALID');
  if (['context.recorded', 'model.message'].includes(data.payload.type) && !data.requestId) throw new Error('SESSION_REQUEST_ID_REQUIRED');
  if ('schemaVersion' in data.payload && (data.payload.workspaceId !== data.workspaceId
    || data.payload.runId !== data.runId || data.payload.requestId !== data.requestId
    || data.payload.conversationId !== data.sessionId)) throw new Error('SESSION_PAYLOAD_IDENTITY_MISMATCH');
  const execution = getExecution(data.runId);
  const task = execution && getTask(execution.taskId);
  if (!execution || !task || (task.workspaceId || 'default') !== data.workspaceId
    || (execution.workspaceId || 'default') !== data.workspaceId || agentSessionForTask(task) !== data.sessionId) {
    throw new Error('SESSION_EVENT_SCOPE_DENIED');
  }
  const raw = JSON.stringify(data.payload);
  if (Buffer.byteLength(raw) > 2_000_000) throw new Error('SESSION_EVENT_TOO_LARGE');
  const checked = dlpCheck(raw, { taskId: task.id, workspaceId: data.workspaceId });
  if (checked.violations.some(violation => violation.action === 'block')) throw new Error('SESSION_EVENT_UNPERSISTABLE');
  const serialized = checked.redactedContent || raw;
  try { JSON.parse(serialized); } catch { throw new Error('SESSION_EVENT_UNPERSISTABLE'); }
  const hash = createHash('sha256').update(serialized).digest('hex');
  const db = getDb();
  return fencedRunWrite(task.id, () => db.transaction(() => {
    // First statement is a write, so another writer cannot race a deferred read/MAX.
    db.run(
      `INSERT INTO agent_session_events
        (event_id, schema_version, workspace_id, session_id, sequence, event_key, run_id, request_id, type, payload, payload_hash, created_at)
        SELECT ?, 1, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?, ?, ?
        FROM agent_session_events WHERE workspace_id = ? AND session_id = ?
        ON CONFLICT(workspace_id, session_id, event_key) DO NOTHING`,
      randomUUID(), data.workspaceId, data.sessionId, data.eventKey, data.runId, data.requestId || null,
      data.payload.type, serialized, hash, new Date().toISOString(), data.workspaceId, data.sessionId,
    );
    const row = db.get<any>('SELECT * FROM agent_session_events WHERE workspace_id = ? AND session_id = ? AND event_key = ?',
      data.workspaceId, data.sessionId, data.eventKey);
    if (!row || row.payload_hash !== hash || row.run_id !== data.runId || (row.request_id || undefined) !== data.requestId) {
      throw new Error('SESSION_EVENT_IDEMPOTENCY_CONFLICT');
    }
    return decode(row);
  }));
}

export function listSessionEvents(data: {
  workspaceId: string; sessionId: string; afterSequence?: number; limit?: number; throughSequence?: number;
}): AgentSessionEvent[] {
  const after = data.afterSequence ?? 0;
  const limit = data.limit ?? 200;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('SESSION_CURSOR_INVALID');
  }
  return getDb().all(
    `SELECT * FROM agent_session_events
      WHERE workspace_id = ? AND session_id = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence LIMIT ?`,
    data.workspaceId, data.sessionId, after, data.throughSequence ?? Number.MAX_SAFE_INTEGER, limit,
  ).map(decode);
}

export function sessionEventCursor(workspaceId: string, sessionId: string): number {
  return getDb().get<{ sequence: number }>(
    'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_session_events WHERE workspace_id = ? AND session_id = ?',
    workspaceId, sessionId,
  )?.sequence || 0;
}
