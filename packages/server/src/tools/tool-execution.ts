import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database.js';
import type { ToolExecution, ToolExecutionStatus } from '../types.js';

function rowToToolExecution(row: any): ToolExecution {
  return {
    id: row.id,
    toolId: row.tool_id,
    toolVersionId: row.tool_version_id || undefined,
    taskId: row.task_id || undefined,
    executionId: row.execution_id || undefined,
    agentId: row.agent_id || undefined,
    status: row.status,
    inputSummary: row.input_summary || undefined,
    inputHash: row.input_hash || undefined,
    outputSummary: row.output_summary || undefined,
    error: row.error || undefined,
    durationMs: row.duration_ms ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
  };
}

function stableStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? {});
}

export function summarizeToolPayload(value: unknown, limit = 1200): string {
  const text = stableStringify(value)
    .replace(/(authorization|api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?[^"',}\s]+/gi, '$1:[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function hashToolInput(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function createToolExecution(data: {
  id?: string;
  toolId: string;
  toolVersionId?: string;
  taskId?: string;
  executionId?: string;
  agentId?: string;
  status?: ToolExecutionStatus;
  input?: unknown;
  inputSummary?: string;
  inputHash?: string;
  startedAt?: string;
}): ToolExecution {
  const db = getDb();
  const id = data.id || `tool_${uuid().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO tool_executions (
      id, tool_id, tool_version_id, task_id, execution_id, agent_id,
      status, input_summary, input_hash, started_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).run(
    id,
    data.toolId,
    data.toolVersionId || null,
    data.taskId || null,
    data.executionId || null,
    data.agentId || null,
    data.status || 'running',
    data.inputSummary || summarizeToolPayload(data.input),
    data.inputHash || hashToolInput(data.input),
    data.startedAt || null,
  );
  return getToolExecution(id)!;
}

export function completeToolExecution(id: string, updates: {
  status: Exclude<ToolExecutionStatus, 'running'>;
  output?: unknown;
  outputSummary?: string;
  error?: string;
  durationMs?: number;
  completedAt?: string;
}): ToolExecution | undefined {
  const db = getDb();
  db.prepare(`
    UPDATE tool_executions
    SET status = ?,
        output_summary = ?,
        error = ?,
        duration_ms = ?,
        completed_at = COALESCE(?, CURRENT_TIMESTAMP)
    WHERE id = ?
  `).run(
    updates.status,
    updates.outputSummary || summarizeToolPayload(updates.output),
    updates.error || null,
    updates.durationMs ?? null,
    updates.completedAt || null,
    id,
  );
  return getToolExecution(id);
}

export function getToolExecution(id: string): ToolExecution | undefined {
  const row = getDb().prepare('SELECT * FROM tool_executions WHERE id = ?').get(id) as any;
  return row ? rowToToolExecution(row) : undefined;
}

export function listToolExecutions(filter?: {
  toolId?: string;
  taskId?: string;
  executionId?: string;
  agentId?: string;
  status?: ToolExecutionStatus;
  limit?: number;
}): ToolExecution[] {
  const db = getDb();
  let sql = 'SELECT * FROM tool_executions';
  const params: any[] = [];
  const conditions: string[] = [];

  if (filter?.toolId) { conditions.push('tool_id = ?'); params.push(filter.toolId); }
  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter?.executionId) { conditions.push('execution_id = ?'); params.push(filter.executionId); }
  if (filter?.agentId) { conditions.push('agent_id = ?'); params.push(filter.agentId); }
  if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY started_at DESC, id DESC LIMIT ?';
  params.push(filter?.limit || 100);

  return (db.prepare(sql).all(...params) as any[]).map(rowToToolExecution);
}
