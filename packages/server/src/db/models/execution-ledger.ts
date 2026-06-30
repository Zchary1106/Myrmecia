/**
 * Execution Ledger — a durable, ordered record of the key decisions a runtime
 * makes during a single execution: which runtime/model was selected, which
 * tools were allowed or blocked, approvals requested, retries, and the final
 * outcome. It is the foundation for replay, audit, and debugging an agent run.
 *
 * The ledger is intentionally append-only and best-effort: recording must never
 * break an execution, so writes are wrapped by the caller in try/catch via
 * `recordLedgerEntry` (which itself swallows failures).
 */
import { getDb } from '../database.js';
import { logger } from '../../lib/logger.js';

export type LedgerEntryType =
  | 'runtime.selected'
  | 'model.selected'
  | 'tool.policy'
  | 'tool.allowed'
  | 'tool.blocked'
  | 'tool.executed'
  | 'approval.requested'
  | 'memory.injected'
  | 'domain.applied'
  | 'budget.checked'
  | 'retry'
  | 'execution.completed'
  | 'execution.failed';

export interface LedgerEntry {
  id: number;
  executionId: string;
  taskId?: string;
  agentId?: string;
  workspaceId: string;
  seq: number;
  type: LedgerEntryType | string;
  decision?: string;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rowToLedgerEntry(row: any): LedgerEntry {
  return {
    id: row.id,
    executionId: row.execution_id,
    taskId: row.task_id || undefined,
    agentId: row.agent_id || undefined,
    workspaceId: row.workspace_id || 'default',
    seq: row.seq,
    type: row.type,
    decision: row.decision || undefined,
    summary: row.summary || '',
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
  };
}

export function recordLedgerEntry(data: {
  executionId: string;
  taskId?: string;
  agentId?: string;
  workspaceId?: string;
  type: LedgerEntryType | string;
  decision?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}): LedgerEntry | undefined {
  try {
    const db = getDb();
    const seqRow = db.get(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM execution_ledger WHERE execution_id = ?',
      data.executionId,
    ) as { next: number } | undefined;
    const seq = seqRow?.next ?? 1;
    const result = db.run(`
      INSERT INTO execution_ledger (
        execution_id, task_id, agent_id, workspace_id, seq, type, decision, summary, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      data.executionId,
      data.taskId || null,
      data.agentId || null,
      data.workspaceId || 'default',
      seq,
      data.type,
      data.decision || null,
      (data.summary || '').slice(0, 2000),
      JSON.stringify(data.metadata || {}),
    );
    return getLedgerEntry(Number(result.lastInsertRowid));
  } catch (err: any) {
    // Ledger recording is best-effort and must never break an execution.
    logger.debug({ err: err?.message, executionId: data.executionId, type: data.type }, 'execution ledger write skipped');
    return undefined;
  }
}

export function getLedgerEntry(id: number): LedgerEntry | undefined {
  const row = getDb().get('SELECT * FROM execution_ledger WHERE id = ?', id) as any;
  return row ? rowToLedgerEntry(row) : undefined;
}

export function listLedgerEntries(filter: {
  executionId?: string;
  taskId?: string;
  workspaceId?: string;
  limit?: number;
}): LedgerEntry[] {
  const db = getDb();
  let sql = 'SELECT * FROM execution_ledger';
  const params: any[] = [];
  const conditions: string[] = [];
  if (filter.executionId) { conditions.push('execution_id = ?'); params.push(filter.executionId); }
  if (filter.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY execution_id ASC, seq ASC';
  if (filter.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
  return (db.all(sql, ...params) as any[]).map(rowToLedgerEntry);
}
