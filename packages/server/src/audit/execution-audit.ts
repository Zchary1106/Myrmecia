import { getDb } from '../db/database.js';

export type ExecutionAuditSeverity = 'info' | 'warn' | 'block' | 'error';

export interface ExecutionAuditEvent {
  type: string;
  severity: ExecutionAuditSeverity;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface ExecutionAuditReport {
  executionId: string;
  taskId: string;
  agentId: string;
  workspaceId: string;
  policySnapshot: Record<string, unknown>;
  events: ExecutionAuditEvent[];
  createdAt: string;
  updatedAt: string;
}

function parseJsonObject(value: string | undefined | null): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function parseJsonArray(value: string | undefined | null): ExecutionAuditEvent[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed as ExecutionAuditEvent[] : [];
}

function rowToAuditReport(row: any): ExecutionAuditReport {
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    workspaceId: row.workspace_id || 'default',
    policySnapshot: parseJsonObject(row.policy_snapshot),
    events: parseJsonArray(row.events),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function recordExecutionPolicySnapshot(data: {
  executionId: string;
  taskId: string;
  agentId: string;
  workspaceId?: string;
  policySnapshot: Record<string, unknown>;
}): ExecutionAuditReport {
  const db = getDb();
  db.run(`
    INSERT INTO execution_audit_reports (
      execution_id, task_id, agent_id, workspace_id, policy_snapshot, events
    )
    VALUES (?, ?, ?, ?, ?, '[]')
    ON CONFLICT(execution_id) DO UPDATE SET
      task_id = excluded.task_id,
      agent_id = excluded.agent_id,
      workspace_id = excluded.workspace_id,
      policy_snapshot = excluded.policy_snapshot,
      updated_at = CURRENT_TIMESTAMP
  `,
    data.executionId,
    data.taskId,
    data.agentId,
    data.workspaceId || 'default',
    JSON.stringify(data.policySnapshot),
  );
  return getExecutionAuditReport(data.executionId)!;
}

export function appendExecutionAuditEvent(executionId: string, event: ExecutionAuditEvent): ExecutionAuditReport | undefined {
  const db = getDb();
  const existing = getExecutionAuditReport(executionId);
  if (!existing) return undefined;
  const events = [
    ...existing.events,
    { ...event, createdAt: event.createdAt || new Date().toISOString() },
  ];
  db.run(`
    UPDATE execution_audit_reports
    SET events = ?, updated_at = CURRENT_TIMESTAMP
    WHERE execution_id = ?
  `, JSON.stringify(events), executionId);
  return getExecutionAuditReport(executionId);
}

export function getExecutionAuditReport(executionId: string): ExecutionAuditReport | undefined {
  const row = getDb().get('SELECT * FROM execution_audit_reports WHERE execution_id = ?', executionId) as any;
  return row ? rowToAuditReport(row) : undefined;
}

export function listExecutionAuditReports(filter?: { taskId?: string; workspaceId?: string; limit?: number }): ExecutionAuditReport[] {
  let sql = 'SELECT * FROM execution_audit_reports';
  const params: any[] = [];
  const conditions: string[] = [];
  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter?.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY updated_at DESC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
  return (getDb().all(sql, ...params) as any[]).map(rowToAuditReport);
}
