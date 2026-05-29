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
    workspaceId: row.workspace_id || 'default',
    modelId: row.model_id || undefined,
    modelTier: row.model_tier || undefined,
    modelRouteSource: row.model_route_source || undefined,
    modelRouteReason: row.model_route_reason || undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
  };
}

export function createExecution(data: {
  taskId: string;
  agentDefId: string;
  skillVersionId?: string;
  parentExecutionId?: string;
  workspaceId?: string;
}): TaskExecution {
  const db = getDb();
  const id = `exec_${uuid().slice(0, 8)}`;
  db.run(
    'INSERT INTO task_executions (id, task_id, agent_def_id, skill_version_id, parent_execution_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?)',
    id, data.taskId, data.agentDefId, data.skillVersionId || null, data.parentExecutionId || null, data.workspaceId || 'default'
  );
  return getExecution(id)!;
}

export function getExecution(id: string): TaskExecution | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM task_executions WHERE id = ?', id);
  return row ? rowToExecution(row) : undefined;
}

export function listExecutions(filter?: {
  taskId?: string;
  agentDefId?: string;
  status?: ExecutionStatus;
  workspaceId?: string;
  limit?: number;
}): TaskExecution[] {
  const db = getDb();
  let sql = 'SELECT * FROM task_executions';
  const params: any[] = [];
  const conditions: string[] = [];

  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter?.agentDefId) { conditions.push('agent_def_id = ?'); params.push(filter.agentDefId); }
  if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
  if (filter?.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY started_at DESC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }

  return db.all(sql, ...params).map(rowToExecution);
}

export function updateExecution(id: string, updates: Partial<{
  status: ExecutionStatus;
  progress: AgentProgress;
  costUSD: number;
  tokenCount: number;
  completedAt: string;
  modelId: string;
  modelTier: string;
  modelRouteSource: string;
  modelRouteReason: string;
}>): TaskExecution | undefined {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.progress !== undefined) { sets.push('progress = ?'); params.push(JSON.stringify(updates.progress)); }
  if (updates.costUSD !== undefined) { sets.push('cost_usd = ?'); params.push(updates.costUSD); }
  if (updates.tokenCount !== undefined) { sets.push('token_count = ?'); params.push(updates.tokenCount); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt); }
  if (updates.modelId !== undefined) { sets.push('model_id = ?'); params.push(updates.modelId); }
  if (updates.modelTier !== undefined) { sets.push('model_tier = ?'); params.push(updates.modelTier); }
  if (updates.modelRouteSource !== undefined) { sets.push('model_route_source = ?'); params.push(updates.modelRouteSource); }
  if (updates.modelRouteReason !== undefined) { sets.push('model_route_reason = ?'); params.push(updates.modelRouteReason); }

  if (sets.length === 0) return getExecution(id);
  params.push(id);
  db.run(`UPDATE task_executions SET ${sets.join(', ')} WHERE id = ?`, ...params);
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
  const result = db.run(
    'INSERT INTO execution_messages (execution_id, type, content, tool_name) VALUES (?, ?, ?, ?)',
    data.executionId, data.type, data.content, data.toolName || null
  );

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

  return db.all(sql, ...params).map((row: any) => ({
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
  const row = db.get(
    'SELECT COUNT(*) as count FROM task_executions WHERE agent_def_id = ? AND status = ?',
    agentDefId, 'running'
  );
  return (row as any)?.count || 0;
}
