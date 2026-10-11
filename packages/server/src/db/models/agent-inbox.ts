import { createHash, randomUUID } from 'node:crypto';
import type { AgentInboxEntry, AgentInboxMode } from '@myrmecia/shared';
import { getDb } from '../database.js';
import { getExecution } from './execution.js';
import { getTask } from './task.js';
import { agentSessionForTask, appendSessionEvent } from './agent-session-event.js';
import { dlpCheck } from '../../security/dlp.js';

function rowToEntry(row: any): AgentInboxEntry {
  return {
    id: row.id, workspaceId: row.workspace_id, sessionId: row.session_id,
    targetExecutionId: row.target_execution_id,
    sourceMessageId: row.source_message_id ?? undefined, userMessageId: row.user_message_id ?? undefined,
    idempotencyKey: row.idempotency_key, mode: row.mode, content: row.content, status: row.status,
    claimOwner: row.claim_owner || undefined, claimUntil: row.claim_until ?? undefined,
    appliedEventId: row.applied_event_id || undefined, acknowledgedRequestId: row.acknowledged_request_id || undefined,
    assignedTaskId: row.assigned_task_id || undefined, reason: row.reason || undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function assertTarget(workspaceId: string, sessionId: string, executionId: string): void {
  const execution = getExecution(executionId);
  const task = execution && getTask(execution.taskId);
  if (!execution || !task || (execution.workspaceId || 'default') !== workspaceId
    || (task.workspaceId || 'default') !== workspaceId || agentSessionForTask(task) !== sessionId) throw new Error('INBOX_SCOPE_DENIED');
}

export function getInboxEntry(id: string, workspaceId: string): AgentInboxEntry | undefined {
  const row = getDb().get('SELECT * FROM agent_inbox_entries WHERE id = ? AND workspace_id = ?', id, workspaceId);
  return row ? rowToEntry(row) : undefined;
}

export function enqueueInbox(data: {
  workspaceId: string; sessionId: string; targetExecutionId: string;
  mode: AgentInboxMode; content: string; idempotencyKey: string;
  sourceMessageId?: number; userMessageId?: number;
}): AgentInboxEntry {
  assertTarget(data.workspaceId, data.sessionId, data.targetExecutionId);
  if (getDb().get('SELECT 1 FROM conversation_lifecycle WHERE workspace_id = ? AND conversation_id = ?', data.workspaceId, data.sessionId)) {
    throw new Error('INBOX_CONVERSATION_INACTIVE: restore the conversation before submitting new instructions');
  }
  const text = data.content.trim();
  if (!text || text.length > 200_000 || (!data.userMessageId && text.length > 20_000) || !['steer', 'follow_up'].includes(data.mode)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(data.idempotencyKey)) throw new Error('INBOX_INPUT_INVALID');
  if (data.sourceMessageId !== undefined) {
    const message = getDb().get<{ to_execution: string; from_execution: string | null }>(
      'SELECT to_execution, from_execution FROM agent_messages WHERE id = ?', data.sourceMessageId,
    );
    if (!message || message.to_execution !== data.targetExecutionId || message.from_execution) throw new Error('INBOX_MESSAGE_SCOPE_DENIED');
  }
  if (data.userMessageId !== undefined) {
    const message = getDb().get<{ execution_id: string; type: string; message_subtype: string | null; content: string }>(
      'SELECT execution_id, type, message_subtype, content FROM execution_messages WHERE id = ?', data.userMessageId,
    );
    if (!message || message.execution_id !== data.targetExecutionId
      || (message.type !== 'user_follow_up' && message.message_subtype !== 'user_follow_up')
      || message.content.length > 20_000) throw new Error('INBOX_MESSAGE_SCOPE_DENIED');
  }
  const checked = dlpCheck(text, { workspaceId: data.workspaceId });
  if (checked.violations.some(violation => violation.action === 'block')) throw new Error('INBOX_SENSITIVE_INPUT');
  const content = checked.redactedContent || text;
  const hash = createHash('sha256').update(JSON.stringify([data.mode, data.targetExecutionId, content])).digest('hex');
  const now = new Date().toISOString();
  const db = getDb();
  return db.transaction(() => {
    db.run(
      `INSERT INTO agent_inbox_entries
        (id, workspace_id, session_id, target_execution_id, source_message_id, user_message_id,
        idempotency_key, mode, content, content_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(workspace_id, session_id, idempotency_key) DO NOTHING`,
      `inbox_${randomUUID()}`, data.workspaceId, data.sessionId, data.targetExecutionId,
      data.sourceMessageId ?? null, data.userMessageId ?? null, data.idempotencyKey, data.mode, content, hash, now, now,
    );
    const row = db.get<any>('SELECT * FROM agent_inbox_entries WHERE workspace_id = ? AND session_id = ? AND idempotency_key = ?',
      data.workspaceId, data.sessionId, data.idempotencyKey);
    if (!row || row.content_hash !== hash) throw new Error('INBOX_IDEMPOTENCY_CONFLICT');
    const userMessage = data.userMessageId
      ? db.get<{ content: string }>('SELECT content FROM execution_messages WHERE id = ?', data.userMessageId)
      : undefined;
    appendSessionEvent({
      workspaceId: data.workspaceId, sessionId: data.sessionId, runId: data.targetExecutionId,
      eventKey: `inbox:${row.id}:submitted`,
      payload: { type: 'inbox.submitted', inboxId: row.id, mode: data.mode, content: userMessage?.content || content },
    });
    return rowToEntry(row);
  });
}

export function listInboxEntries(workspaceId: string, sessionId: string): AgentInboxEntry[] {
  return getDb().all('SELECT * FROM agent_inbox_entries WHERE workspace_id = ? AND session_id = ? ORDER BY created_at, rowid LIMIT 500',
    workspaceId, sessionId).map(rowToEntry);
}

export function claimInbox(data: {
  workspaceId: string; sessionId: string; targetExecutionId: string; mode: AgentInboxMode;
  owner: string; nowMs?: number; leaseMs?: number;
}): AgentInboxEntry[] {
  assertTarget(data.workspaceId, data.sessionId, data.targetExecutionId);
  const now = data.nowMs ?? Date.now();
  const lease = data.leaseMs ?? 60_000;
  if (!data.owner || data.owner.length > 256 || !['steer', 'follow_up'].includes(data.mode)
    || !Number.isFinite(now) || !Number.isFinite(lease) || lease < 1 || lease > 60_000) {
    throw new Error('INBOX_CLAIM_INVALID');
  }
  const db = getDb();
  return db.transaction(() => {
    db.run(
      `UPDATE agent_inbox_entries SET status = 'claimed', claim_owner = ?, claim_until = ?, updated_at = ?
       WHERE id IN (
        SELECT id FROM agent_inbox_entries
        WHERE workspace_id = ? AND session_id = ? AND target_execution_id = ? AND mode = ?
          AND (status = 'pending' OR (status = 'claimed' AND claim_until <= ?))
        ORDER BY created_at, rowid LIMIT 20
       )`,
      data.owner, now + lease, new Date().toISOString(), data.workspaceId, data.sessionId,
      data.targetExecutionId, data.mode, now,
    );
    return db.all(
      `SELECT * FROM agent_inbox_entries WHERE workspace_id = ? AND session_id = ? AND target_execution_id = ?
        AND mode = ? AND status = 'claimed' AND claim_owner = ? AND claim_until > ? ORDER BY created_at, rowid`,
      data.workspaceId, data.sessionId, data.targetExecutionId, data.mode, data.owner, now,
    ).map(rowToEntry);
  });
}

/** Application + journal event + legacy consumption are one recoverable transaction. */
export function applyInbox(data: {
  workspaceId: string; id: string; owner: string; requestId: string; nowMs?: number;
}): AgentInboxEntry {
  const db = getDb();
  const now = data.nowMs ?? Date.now();
  if (!data.requestId) throw new Error('INBOX_REQUEST_REQUIRED');
  return db.transaction(() => {
    const claimed = db.run(
      `UPDATE agent_inbox_entries SET status = 'applied', updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'claimed' AND claim_owner = ? AND claim_until > ?`,
      new Date().toISOString(), data.workspaceId, data.id, data.owner, now,
    );
    const entry = getInboxEntry(data.id, data.workspaceId);
    if (claimed.changes !== 1) {
      if (entry && ['applied', 'acknowledged'].includes(entry.status) && entry.claimOwner === data.owner) return entry;
      throw new Error('INBOX_CLAIM_LOST');
    }
    if (!entry) throw new Error('INBOX_NOT_FOUND');
    const userMessage = entry.userMessageId
      ? db.get<{ content: string }>('SELECT content FROM execution_messages WHERE id = ?', entry.userMessageId)
      : undefined;
    const event = appendSessionEvent({
      workspaceId: entry.workspaceId, sessionId: entry.sessionId, runId: entry.targetExecutionId,
      requestId: data.requestId, eventKey: `inbox:${entry.id}:applied`,
      payload: { type: 'inbox.applied', inboxId: entry.id, mode: entry.mode, content: userMessage?.content || entry.content },
    });
    db.run('UPDATE agent_inbox_entries SET applied_event_id = ? WHERE id = ? AND workspace_id = ?', event.eventId, entry.id, entry.workspaceId);
    if (entry.sourceMessageId) db.run('UPDATE agent_messages SET consumed = 1 WHERE id = ?', entry.sourceMessageId);
    return getInboxEntry(entry.id, entry.workspaceId)!;
  });
}

export function ackInbox(data: { workspaceId: string; id: string; requestId: string }): AgentInboxEntry {
  const entry = getInboxEntry(data.id, data.workspaceId);
  if (!entry || !data.requestId || !entry.appliedEventId) throw new Error('INBOX_NOT_APPLIED');
  const original = getDb().get<{ request_id: string; run_id: string }>(
    'SELECT request_id, run_id FROM agent_session_events WHERE event_id = ? AND workspace_id = ? AND session_id = ?',
    entry.appliedEventId, entry.workspaceId, entry.sessionId);
  if (original?.request_id !== data.requestId) throw new Error('INBOX_ACK_REQUEST_MISMATCH');
  if (entry.status === 'acknowledged' && entry.acknowledgedRequestId === data.requestId) return entry;
  if (entry.status !== 'applied') throw new Error('INBOX_NOT_APPLIED');
  const observed = getDb().get(
    `SELECT event_id FROM agent_session_events WHERE workspace_id = ? AND session_id = ? AND run_id = ? AND request_id = ?
      AND type IN ('assistant.delta', 'assistant.completed', 'tool.started', 'usage') LIMIT 1`,
    entry.workspaceId, entry.sessionId, original.run_id, data.requestId,
  );
  if (!observed) throw new Error('INBOX_DELIVERY_UNOBSERVED');
  const db = getDb();
  return db.transaction(() => {
    const changed = db.run(`UPDATE agent_inbox_entries SET status = 'acknowledged', acknowledged_request_id = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status = 'applied'`, data.requestId, new Date().toISOString(), data.id, data.workspaceId);
    if (changed.changes !== 1) throw new Error('INBOX_ACK_STATE_LOST');
    appendSessionEvent({
      workspaceId: entry.workspaceId, sessionId: entry.sessionId, runId: entry.targetExecutionId,
      requestId: data.requestId, eventKey: `inbox:${entry.id}:acknowledged`,
      payload: { type: 'inbox.delivery', inboxId: entry.id, status: 'acknowledged' },
    });
    return getInboxEntry(data.id, data.workspaceId)!;
  });
}

export function rejectInbox(workspaceId: string, id: string, reason: string): AgentInboxEntry {
  const db = getDb();
  return db.transaction(() => {
    const changed = db.run(`UPDATE agent_inbox_entries SET status = 'rejected', reason = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status IN ('pending','claimed','applied')`, reason.slice(0, 500), new Date().toISOString(), id, workspaceId);
    const entry = getInboxEntry(id, workspaceId);
    if (!entry) throw new Error('INBOX_NOT_FOUND');
    if (changed.changes && entry.sourceMessageId) db.run('UPDATE agent_messages SET consumed = 1 WHERE id = ?', entry.sourceMessageId);
    if (changed.changes) appendSessionEvent({
      workspaceId, sessionId: entry.sessionId, runId: entry.targetExecutionId, eventKey: `inbox:${entry.id}:rejected`,
      payload: { type: 'inbox.delivery', inboxId: entry.id, status: 'rejected', reason: entry.reason },
    });
    return entry;
  });
}

export function markInboxDeliveryUncertain(workspaceId: string, id: string): void {
  const entry = getInboxEntry(id, workspaceId);
  if (!entry || entry.status !== 'applied' || !entry.appliedEventId) return;
  const reason = 'Delivery uncertain: request dispatched without an observed model receipt; do not automatically replay.';
  getDb().transaction(() => {
    getDb().run("UPDATE agent_inbox_entries SET reason = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'applied'",
      reason, new Date().toISOString(), id, workspaceId);
    appendSessionEvent({ workspaceId, sessionId: entry.sessionId, runId: entry.targetExecutionId,
      eventKey: `inbox:${entry.id}:uncertain`, payload: { type: 'inbox.delivery', inboxId: entry.id, status: 'applied', reason } });
  });
}

/** Bind a materialized follow-up to its first actual request without injecting it twice. */
export function bindAssignedFollowUps(data: {
  workspaceId: string; sessionId: string; taskId: string; executionId: string; requestId: string;
}): AgentInboxEntry[] {
  assertTarget(data.workspaceId, data.sessionId, data.executionId);
  if (getExecution(data.executionId)?.taskId !== data.taskId) throw new Error('INBOX_SCOPE_DENIED');
  return getDb().transaction(() => {
    const entries = getDb().all<any>(`SELECT * FROM agent_inbox_entries WHERE workspace_id = ? AND session_id = ?
      AND assigned_task_id = ? AND status = 'applied' AND applied_event_id IS NULL`, data.workspaceId, data.sessionId, data.taskId);
    return entries.map(row => {
      const event = appendSessionEvent({ workspaceId: data.workspaceId, sessionId: data.sessionId, runId: data.executionId,
        requestId: data.requestId, eventKey: `inbox:${row.id}:assigned-request`,
        payload: { type: 'inbox.applied', inboxId: row.id, mode: 'follow_up', content: row.content } });
      getDb().run(`UPDATE agent_inbox_entries SET applied_event_id = ?, reason = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND applied_event_id IS NULL`, event.eventId, new Date().toISOString(), row.id, data.workspaceId);
      return getInboxEntry(row.id, data.workspaceId)!;
    });
  });
}

export function finalizeInboxForExecution(workspaceId: string, executionId: string): void {
  const rows = getDb().all<{ id: string; mode: string; status: string }>(
    `SELECT id, mode, status FROM agent_inbox_entries WHERE workspace_id = ? AND target_execution_id = ?
      AND status IN ('pending','claimed','applied')`, workspaceId, executionId);
  for (const row of rows) {
    if (row.mode !== 'steer') continue;
    if (row.status === 'applied') markInboxDeliveryUncertain(workspaceId, row.id);
    else rejectInbox(workspaceId, row.id,
      '当前执行已结束，未出现可以安全应用的下一轮；请重新追问或选择完成后继续。');
  }
}
