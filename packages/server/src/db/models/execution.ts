import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { TaskExecution, ExecutionStatus, AgentProgress, ExecutionMessage, ExecutionMessageType } from '../../types.js';

const DEFAULT_PROGRESS: AgentProgress = {
  toolUseCount: 0,
  tokenCount: 0,
  recentActivities: [],
};

function rowToExecution(row: any): TaskExecution {
  return {
    id: row.id,
    taskId: row.task_id,
    agentDefId: row.agent_def_id,
    skillVersionId: row.skill_version_id || undefined,
    status: row.status,
    progress: JSON.parse(row.progress),
    costUSD: row.cost_usd,
    tokenCount: row.token_count,
    parentExecutionId: row.parent_execution_id || undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
  };
}

export function createExecution(data: {
  taskId: string;
  agentDefId: string;
  skillVersionId?: string;
  parentExecutionId?: string;
}): TaskExecution {
  const db = getDb();
  const id = `exec_${uuid().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO task_executions (id, task_id, agent_def_id, skill_version_id, parent_execution_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, data.taskId, data.agentDefId, data.skillVersionId || null, data.parentExecutionId || null);
  return getExecution(id)!;
}

export function getExecution(id: string): TaskExecution | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM task_executions WHERE id = ?').get(id) as any;
  return row ? rowToExecution(row) : undefined;
}

export function listExecutions(filter?: {
  taskId?: string;
  agentDefId?: string;
  status?: ExecutionStatus;
  limit?: number;
}): TaskExecution[] {
  const db = getDb();
  let sql = 'SELECT * FROM task_executions';
  const params: any[] = [];
  const conditions: string[] = [];

  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter?.agentDefId) { conditions.push('agent_def_id = ?'); params.push(filter.agentDefId); }
  if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY started_at DESC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }

  return (db.prepare(sql).all(...params) as any[]).map(rowToExecution);
}

export function updateExecution(id: string, updates: Partial<{
  status: ExecutionStatus;
  progress: AgentProgress;
  costUSD: number;
  tokenCount: number;
  completedAt: string;
}>): TaskExecution | undefined {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.progress !== undefined) { sets.push('progress = ?'); params.push(JSON.stringify(updates.progress)); }
  if (updates.costUSD !== undefined) { sets.push('cost_usd = ?'); params.push(updates.costUSD); }
  if (updates.tokenCount !== undefined) { sets.push('token_count = ?'); params.push(updates.tokenCount); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt); }

  if (sets.length === 0) return getExecution(id);
  params.push(id);
  db.prepare(`UPDATE task_executions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getExecution(id);
}

// Execution messages
export function addExecutionMessage(data: {
  executionId: string;
  type: ExecutionMessageType;
  content: string;
  toolName?: string;
}): ExecutionMessage {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO execution_messages (execution_id, type, content, tool_name)
    VALUES (?, ?, ?, ?)
  `).run(data.executionId, data.type, data.content, data.toolName || null);

  return {
    id: Number(result.lastInsertRowid),
    executionId: data.executionId,
    type: data.type,
    content: data.content,
    toolName: data.toolName,
    createdAt: new Date().toISOString(),
  };
}

export function listExecutionMessages(executionId: string, opts?: {
  afterId?: number;
  limit?: number;
}): ExecutionMessage[] {
  const db = getDb();
  let sql = 'SELECT * FROM execution_messages WHERE execution_id = ?';
  const params: any[] = [executionId];

  if (opts?.afterId) { sql += ' AND id > ?'; params.push(opts.afterId); }
  sql += ' ORDER BY id ASC';
  if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

  return (db.prepare(sql).all(...params) as any[]).map(row => ({
    id: row.id,
    executionId: row.execution_id,
    type: row.type,
    content: row.content,
    toolName: row.tool_name || undefined,
    createdAt: row.created_at,
  }));
}

// Active executions for an agent (running count)
export function getActiveExecutionCount(agentDefId: string): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM task_executions WHERE agent_def_id = ? AND status = ?'
  ).get(agentDefId, 'running') as any;
  return row?.count || 0;
}
