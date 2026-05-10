import { v4 as uuid } from 'uuid';
import { getDb } from '../database.js';
import type { RunTrace, RunTraceStatus, TraceSpan, TraceSpanStatus } from '../../types.js';

function parseMetadata(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function rowToSpan(row: any): TraceSpan {
  return {
    id: row.id,
    traceId: row.trace_id,
    parentSpanId: row.parent_span_id || undefined,
    type: row.type,
    name: row.name,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
    durationMs: row.duration_ms ?? undefined,
    metadata: parseMetadata(row.metadata),
    error: row.error || undefined,
  };
}

function rowToTrace(row: any, spans: TraceSpan[] = []): RunTrace {
  return {
    id: row.id,
    taskId: row.task_id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
    summary: row.summary || undefined,
    spans,
  };
}

export function createRunTrace(data: {
  id?: string;
  taskId: string;
  executionId: string;
  agentId: string;
}): RunTrace {
  const db = getDb();
  const id = data.id || `trace_${uuid().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO run_traces (id, task_id, execution_id, agent_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(execution_id) DO UPDATE SET
      status = 'running',
      summary = NULL,
      completed_at = NULL
  `).run(id, data.taskId, data.executionId, data.agentId);
  return getRunTraceByExecution(data.executionId)!;
}

export function completeRunTrace(id: string, updates: {
  status: RunTraceStatus;
  summary?: string;
  completedAt?: string;
}): RunTrace | undefined {
  const db = getDb();
  db.prepare(`
    UPDATE run_traces
    SET status = ?, summary = ?, completed_at = COALESCE(?, CURRENT_TIMESTAMP)
    WHERE id = ?
  `).run(updates.status, updates.summary || null, updates.completedAt || null, id);
  return getRunTrace(id);
}

export function getRunTrace(id: string): RunTrace | undefined {
  const row = getDb().prepare('SELECT * FROM run_traces WHERE id = ?').get(id) as any;
  return row ? rowToTrace(row, listTraceSpans(row.id)) : undefined;
}

export function getRunTraceByExecution(executionId: string): RunTrace | undefined {
  const row = getDb().prepare('SELECT * FROM run_traces WHERE execution_id = ?').get(executionId) as any;
  return row ? rowToTrace(row, listTraceSpans(row.id)) : undefined;
}

export function getRunTraceByTask(taskId: string): RunTrace | undefined {
  const row = getDb().prepare('SELECT * FROM run_traces WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(taskId) as any;
  return row ? rowToTrace(row, listTraceSpans(row.id)) : undefined;
}

export function createTraceSpan(data: {
  id?: string;
  traceId: string;
  parentSpanId?: string;
  type: string;
  name: string;
  status?: TraceSpanStatus;
  metadata?: Record<string, unknown>;
  startedAt?: string;
}): TraceSpan {
  const db = getDb();
  const id = data.id || `span_${uuid().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO trace_spans (
      id, trace_id, parent_span_id, type, name, status, metadata, started_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).run(
    id,
    data.traceId,
    data.parentSpanId || null,
    data.type,
    data.name,
    data.status || 'running',
    JSON.stringify(data.metadata || {}),
    data.startedAt || null,
  );
  return getTraceSpan(id)!;
}

export function completeTraceSpan(id: string, updates: {
  status: TraceSpanStatus;
  metadata?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  completedAt?: string;
}): TraceSpan | undefined {
  const existing = getTraceSpan(id);
  if (!existing) return undefined;
  const metadata = { ...existing.metadata, ...(updates.metadata || {}) };
  const durationMs = updates.durationMs ?? (
    updates.completedAt
      ? new Date(updates.completedAt).getTime() - new Date(existing.startedAt).getTime()
      : undefined
  );
  getDb().prepare(`
    UPDATE trace_spans
    SET status = ?,
        metadata = ?,
        error = ?,
        duration_ms = ?,
        completed_at = COALESCE(?, CURRENT_TIMESTAMP)
    WHERE id = ?
  `).run(
    updates.status,
    JSON.stringify(metadata),
    updates.error || null,
    durationMs ?? null,
    updates.completedAt || null,
    id,
  );
  return getTraceSpan(id);
}

export function getTraceSpan(id: string): TraceSpan | undefined {
  const row = getDb().prepare('SELECT * FROM trace_spans WHERE id = ?').get(id) as any;
  return row ? rowToSpan(row) : undefined;
}

export function listTraceSpans(traceId: string): TraceSpan[] {
  return (getDb().prepare('SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC, id ASC').all(traceId) as any[])
    .map(rowToSpan);
}
