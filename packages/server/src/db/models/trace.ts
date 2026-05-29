import { v4 as uuid } from 'uuid';
import { getDb } from '../database.js';
import type { RunTrace, RunTraceStatus, TraceSpan, TraceSpanStatus } from '../../types.js';
import { otelSpanFromTrace, emitMetric } from '../../observability/telemetry.js';

// Track active OTel spans for later completion (with TTL cleanup)
const activeOTelSpans = new Map<string, { span: ReturnType<typeof otelSpanFromTrace>; createdAt: number }>();
const SPAN_TTL_MS = 60 * 60 * 1000; // 1 hour

function cleanupStaleSpans() {
  const now = Date.now();
  for (const [id, entry] of activeOTelSpans) {
    if (now - entry.createdAt > SPAN_TTL_MS) {
      try { entry.span.setStatus({ code: 2, message: 'Stale span cleanup' }); entry.span.end(); } catch {}
      activeOTelSpans.delete(id);
    }
  }
}
// Run cleanup every 10 minutes
setInterval(cleanupStaleSpans, 10 * 60 * 1000).unref();

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
  db.run(`
    INSERT INTO run_traces (id, task_id, execution_id, agent_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(execution_id) DO UPDATE SET
      status = 'running',
      summary = NULL,
      completed_at = NULL
  `, id, data.taskId, data.executionId, data.agentId);
  return getRunTraceByExecution(data.executionId)!;
}

export function completeRunTrace(id: string, updates: {
  status: RunTraceStatus;
  summary?: string;
  completedAt?: string;
}): RunTrace | undefined {
  const db = getDb();
  db.run(`
    UPDATE run_traces
    SET status = ?, summary = ?, completed_at = COALESCE(?, CURRENT_TIMESTAMP)
    WHERE id = ?
  `, updates.status, updates.summary || null, updates.completedAt || null, id);

  // Emit telemetry for agent success rate
  const trace = getRunTrace(id);
  if (trace) {
    emitMetric('agentSuccessRate', 1, {
      status: updates.status,
      agentId: trace.agentId,
    });
  }

  return trace || getRunTrace(id);
}

export function getRunTrace(id: string): RunTrace | undefined {
  const row = getDb().get('SELECT * FROM run_traces WHERE id = ?', id);
  return row ? rowToTrace(row, listTraceSpans(row.id)) : undefined;
}

export function getRunTraceByExecution(executionId: string): RunTrace | undefined {
  const row = getDb().get('SELECT * FROM run_traces WHERE execution_id = ?', executionId);
  return row ? rowToTrace(row, listTraceSpans(row.id)) : undefined;
}

export function getRunTraceByTask(taskId: string): RunTrace | undefined {
  const row = getDb().get('SELECT * FROM run_traces WHERE task_id = ? ORDER BY started_at DESC LIMIT 1', taskId);
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
  db.run(`
    INSERT INTO trace_spans (
      id, trace_id, parent_span_id, type, name, status, metadata, started_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `,
    id,
    data.traceId,
    data.parentSpanId || null,
    data.type,
    data.name,
    data.status || 'running',
    JSON.stringify(data.metadata || {}),
    data.startedAt || null,
  );
  // Also emit as OTel span
  try {
    const otelSpan = otelSpanFromTrace(data.name, {
      'trace.id': data.traceId,
      'span.type': data.type,
      ...Object.fromEntries(
        Object.entries(data.metadata || {}).map(([k, v]) => [k, String(v)])
      ),
    });
    activeOTelSpans.set(id, { span: otelSpan, createdAt: Date.now() });
  } catch {}

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
  getDb().run(`
    UPDATE trace_spans
    SET status = ?,
        metadata = ?,
        error = ?,
        duration_ms = ?,
        completed_at = COALESCE(?, CURRENT_TIMESTAMP)
    WHERE id = ?
  `,
    updates.status,
    JSON.stringify(metadata),
    updates.error || null,
    durationMs ?? null,
    updates.completedAt || null,
    id,
  );
  // Complete matching OTel span
  try {
    const entry = activeOTelSpans.get(id);
    if (entry) {
      const otelSpan = entry.span;
      if (updates.error) {
        otelSpan.setStatus({ code: 2, message: updates.error });
        otelSpan.recordException(new Error(updates.error));
      } else {
        otelSpan.setStatus({ code: 1 });
      }
      if (updates.metadata) {
        for (const [k, v] of Object.entries(updates.metadata)) {
          otelSpan.setAttribute(k, String(v));
        }
      }
      otelSpan.end();
      activeOTelSpans.delete(id);
    }
  } catch {}

  return getTraceSpan(id);
}

export function getTraceSpan(id: string): TraceSpan | undefined {
  const row = getDb().get('SELECT * FROM trace_spans WHERE id = ?', id);
  return row ? rowToSpan(row) : undefined;
}

export function listTraceSpans(traceId: string): TraceSpan[] {
  return getDb().all('SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC, id ASC', traceId)
    .map(rowToSpan);
}
