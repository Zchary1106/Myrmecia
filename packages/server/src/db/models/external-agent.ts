import { randomUUID } from 'crypto';
import type {
  ExternalAgent,
  ExternalAgentConfig,
  ExternalAgentRun,
  ExternalAgentRunStatus,
  ExternalAgentSchedule,
  ExternalAgentStatus,
  ExternalAgentTriggerType,
  ExternalAgentInvocationContext,
} from '@myrmecia/shared';
import { getDb } from '../database.js';

type Row = Record<string, unknown>;

function stringArray(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function jsonObject<T>(value: unknown, fallback: T): T {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function externalAgentFromRow(row: Row): ExternalAgent {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    description: String(row.description || ''),
    adapter: jsonObject<ExternalAgentConfig>(row.adapter_config, { kind: 'http', endpoint: '' }),
    status: row.status as ExternalAgentStatus,
    capabilities: stringArray(row.capabilities),
    allowedTools: stringArray(row.allowed_tools),
    defaultModelId: typeof row.default_model_id === 'string' ? row.default_model_id : undefined,
    lastHealthCheckAt: timestamp(row.last_health_check_at),
    lastHealthStatus: row.last_health_status as ExternalAgent['lastHealthStatus'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function externalAgentRunFromRow(row: Row): ExternalAgentRun {
  return {
    id: String(row.id),
    externalAgentId: String(row.external_agent_id),
    taskId: typeof row.task_id === 'string' ? row.task_id : undefined,
    workspaceId: String(row.workspace_id),
    triggerType: row.trigger_type as ExternalAgentTriggerType,
    status: row.status as ExternalAgentRunStatus,
    invocation: jsonObject<ExternalAgentInvocationContext>(row.invocation, { objective: '', constraints: [] }),
    outputSummary: typeof row.output_summary === 'string' ? row.output_summary : undefined,
    error: typeof row.error === 'string' ? row.error : undefined,
    artifactIds: stringArray(row.artifact_ids),
    startedAt: timestamp(row.started_at),
    completedAt: timestamp(row.completed_at),
    createdAt: String(row.created_at),
  };
}

function externalAgentScheduleFromRow(row: Row): ExternalAgentSchedule {
  return {
    id: String(row.id),
    externalAgentId: String(row.external_agent_id),
    workspaceId: String(row.workspace_id),
    triggerType: row.trigger_type as ExternalAgentSchedule['triggerType'],
    cron: typeof row.cron === 'string' ? row.cron : undefined,
    runAt: timestamp(row.run_at),
    timezone: typeof row.timezone === 'string' ? row.timezone : undefined,
    webhookSecretRef: jsonObject(row.webhook_secret_ref, undefined),
    eventType: typeof row.event_type === 'string' ? row.event_type : undefined,
    invocation: jsonObject(row.invocation, { objective: '', constraints: [] }),
    enabled: Boolean(row.enabled),
    lastRunAt: timestamp(row.last_run_at),
    nextRunAt: timestamp(row.next_run_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export interface CreateExternalAgentInput {
  workspaceId: string;
  name: string;
  description?: string;
  adapter: ExternalAgentConfig;
  status?: ExternalAgentStatus;
  capabilities?: string[];
  allowedTools?: string[];
  defaultModelId?: string;
}

export function createExternalAgent(input: CreateExternalAgentInput): ExternalAgent {
  const id = randomUUID();
  const db = getDb();
  db.run(`
    INSERT INTO external_agents (
      id, workspace_id, name, description, adapter_kind, adapter_config, status,
      capabilities, allowed_tools, default_model_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  id, input.workspaceId, input.name.trim(), input.description || '', input.adapter.kind,
  JSON.stringify(input.adapter), input.status || 'draft',
  JSON.stringify(input.capabilities || []), JSON.stringify(input.allowedTools || []),
  input.defaultModelId || null);
  return getExternalAgent(id, input.workspaceId)!;
}

export function getExternalAgent(id: string, workspaceId: string): ExternalAgent | undefined {
  const row = getDb().get<Row>('SELECT * FROM external_agents WHERE id = ? AND workspace_id = ?', id, workspaceId);
  return row ? externalAgentFromRow(row) : undefined;
}

export function listExternalAgents(filter: { workspaceId: string; status?: ExternalAgentStatus }): ExternalAgent[] {
  const conditions = ['workspace_id = ?'];
  const params: unknown[] = [filter.workspaceId];
  if (filter.status) { conditions.push('status = ?'); params.push(filter.status); }
  return getDb().all<Row>(`SELECT * FROM external_agents WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, name ASC`, ...params).map(externalAgentFromRow);
}

export function updateExternalAgent(
  id: string,
  workspaceId: string,
  updates: Partial<Omit<CreateExternalAgentInput, 'workspaceId'>> & Partial<Pick<ExternalAgent, 'lastHealthCheckAt' | 'lastHealthStatus'>>,
): ExternalAgent | undefined {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name.trim()); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.adapter !== undefined) {
    sets.push('adapter_kind = ?', 'adapter_config = ?');
    params.push(updates.adapter.kind, JSON.stringify(updates.adapter));
  }
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.capabilities !== undefined) { sets.push('capabilities = ?'); params.push(JSON.stringify(updates.capabilities)); }
  if (updates.allowedTools !== undefined) { sets.push('allowed_tools = ?'); params.push(JSON.stringify(updates.allowedTools)); }
  if (updates.defaultModelId !== undefined) { sets.push('default_model_id = ?'); params.push(updates.defaultModelId || null); }
  if (updates.lastHealthCheckAt !== undefined) { sets.push('last_health_check_at = ?'); params.push(updates.lastHealthCheckAt || null); }
  if (updates.lastHealthStatus !== undefined) { sets.push('last_health_status = ?'); params.push(updates.lastHealthStatus || null); }
  if (!sets.length) return getExternalAgent(id, workspaceId);
  sets.push("updated_at = datetime('now')");
  params.push(id, workspaceId);
  getDb().run(`UPDATE external_agents SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`, ...params);
  return getExternalAgent(id, workspaceId);
}

export function deleteExternalAgent(id: string, workspaceId: string): boolean {
  const db = getDb();
  const existing = getExternalAgent(id, workspaceId);
  if (!existing) return false;
  db.run('DELETE FROM external_agent_schedules WHERE external_agent_id = ? AND workspace_id = ?', id, workspaceId);
  db.run('DELETE FROM external_agent_runs WHERE external_agent_id = ? AND workspace_id = ?', id, workspaceId);
  return db.run('DELETE FROM external_agents WHERE id = ? AND workspace_id = ?', id, workspaceId).changes > 0;
}

export function createExternalAgentRun(input: Omit<ExternalAgentRun, 'id' | 'createdAt'>): ExternalAgentRun {
  const id = randomUUID();
  getDb().run(`
    INSERT INTO external_agent_runs (
      id, external_agent_id, task_id, workspace_id, trigger_type, status, invocation,
      output_summary, error, artifact_ids, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  id, input.externalAgentId, input.taskId || null, input.workspaceId || 'default',
  input.triggerType, input.status, JSON.stringify(input.invocation), input.outputSummary || null,
  input.error || null, JSON.stringify(input.artifactIds || []), input.startedAt || null, input.completedAt || null);
  return getExternalAgentRun(id, input.workspaceId || 'default')!;
}

export function getExternalAgentRun(id: string, workspaceId: string): ExternalAgentRun | undefined {
  const row = getDb().get<Row>('SELECT * FROM external_agent_runs WHERE id = ? AND workspace_id = ?', id, workspaceId);
  return row ? externalAgentRunFromRow(row) : undefined;
}

export function listExternalAgentRuns(filter: { workspaceId: string; externalAgentId?: string; limit?: number }): ExternalAgentRun[] {
  const conditions = ['workspace_id = ?'];
  const params: unknown[] = [filter.workspaceId];
  if (filter.externalAgentId) { conditions.push('external_agent_id = ?'); params.push(filter.externalAgentId); }
  params.push(Math.min(Math.max(filter.limit || 50, 1), 200));
  return getDb().all<Row>(`SELECT * FROM external_agent_runs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...params).map(externalAgentRunFromRow);
}

export function updateExternalAgentRun(
  id: string,
  workspaceId: string,
  updates: Partial<Pick<ExternalAgentRun, 'status' | 'outputSummary' | 'error' | 'artifactIds' | 'startedAt' | 'completedAt'>>,
): ExternalAgentRun | undefined {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.outputSummary !== undefined) { sets.push('output_summary = ?'); params.push(updates.outputSummary || null); }
  if (updates.error !== undefined) { sets.push('error = ?'); params.push(updates.error || null); }
  if (updates.artifactIds !== undefined) { sets.push('artifact_ids = ?'); params.push(JSON.stringify(updates.artifactIds)); }
  if (updates.startedAt !== undefined) { sets.push('started_at = ?'); params.push(updates.startedAt || null); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt || null); }
  if (!sets.length) return getExternalAgentRun(id, workspaceId);
  params.push(id, workspaceId);
  getDb().run(`UPDATE external_agent_runs SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`, ...params);
  return getExternalAgentRun(id, workspaceId);
}

export function createExternalAgentSchedule(input: Omit<ExternalAgentSchedule, 'id' | 'createdAt' | 'updatedAt'>): ExternalAgentSchedule {
  const id = randomUUID();
  getDb().run(`
    INSERT INTO external_agent_schedules (
      id, external_agent_id, workspace_id, trigger_type, cron, run_at, timezone,
      webhook_secret_ref, event_type, invocation, enabled, last_run_at, next_run_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  id, input.externalAgentId, input.workspaceId || 'default', input.triggerType,
  input.cron || null, input.runAt || null, input.timezone || null,
  input.webhookSecretRef ? JSON.stringify(input.webhookSecretRef) : null, input.eventType || null,
  JSON.stringify(input.invocation), input.enabled ? 1 : 0, input.lastRunAt || null, input.nextRunAt || null);
  return getExternalAgentSchedule(id, input.workspaceId || 'default')!;
}

export function getExternalAgentSchedule(id: string, workspaceId: string): ExternalAgentSchedule | undefined {
  const row = getDb().get<Row>('SELECT * FROM external_agent_schedules WHERE id = ? AND workspace_id = ?', id, workspaceId);
  return row ? externalAgentScheduleFromRow(row) : undefined;
}

export function listExternalAgentSchedules(filter: { workspaceId?: string; externalAgentId?: string; enabled?: boolean }): ExternalAgentSchedule[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (filter.externalAgentId) { conditions.push('external_agent_id = ?'); params.push(filter.externalAgentId); }
  if (filter.enabled !== undefined) { conditions.push('enabled = ?'); params.push(filter.enabled ? 1 : 0); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return getDb().all<Row>(`SELECT * FROM external_agent_schedules${where} ORDER BY next_run_at ASC, created_at DESC`, ...params).map(externalAgentScheduleFromRow);
}

export function updateExternalAgentSchedule(
  id: string,
  workspaceId: string,
  updates: Partial<Omit<ExternalAgentSchedule, 'id' | 'externalAgentId' | 'workspaceId' | 'createdAt' | 'updatedAt'>>,
): ExternalAgentSchedule | undefined {
  const mapping: Array<[keyof typeof updates, string, (value: any) => unknown]> = [
    ['cron', 'cron', value => value || null],
    ['runAt', 'run_at', value => value || null],
    ['timezone', 'timezone', value => value || null],
    ['webhookSecretRef', 'webhook_secret_ref', value => value ? JSON.stringify(value) : null],
    ['eventType', 'event_type', value => value || null],
    ['invocation', 'invocation', value => JSON.stringify(value)],
    ['enabled', 'enabled', value => value ? 1 : 0],
    ['lastRunAt', 'last_run_at', value => value || null],
    ['nextRunAt', 'next_run_at', value => value || null],
  ];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column, convert] of mapping) {
    if (updates[key] !== undefined) { sets.push(`${column} = ?`); params.push(convert(updates[key])); }
  }
  if (!sets.length) return getExternalAgentSchedule(id, workspaceId);
  sets.push("updated_at = datetime('now')");
  params.push(id, workspaceId);
  getDb().run(`UPDATE external_agent_schedules SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`, ...params);
  return getExternalAgentSchedule(id, workspaceId);
}

/**
 * Atomically claim one due schedule before dispatching it. A second worker
 * cannot claim the same schedule once next_run_at has advanced.
 */
export function claimExternalAgentSchedule(
  id: string,
  workspaceId: string,
  dueAt: string,
  nextRunAt: string | undefined,
  keepEnabled: boolean,
): boolean {
  const result = getDb().run(`
    UPDATE external_agent_schedules
    SET last_run_at = ?, next_run_at = ?, enabled = ?, updated_at = datetime('now')
    WHERE id = ? AND workspace_id = ? AND enabled = 1
      AND next_run_at IS NOT NULL AND next_run_at <= ?
  `,
  dueAt, nextRunAt || null, keepEnabled ? 1 : 0, id, workspaceId, dueAt);
  return result.changes > 0;
}

export function deleteExternalAgentSchedule(id: string, workspaceId: string): boolean {
  return getDb().run('DELETE FROM external_agent_schedules WHERE id = ? AND workspace_id = ?', id, workspaceId).changes > 0;
}
