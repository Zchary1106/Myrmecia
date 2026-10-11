import { createHash } from 'node:crypto';
import type { ModelCostType, BudgetUsageSummary } from '../types.js';
import { getDb } from '../db/database.js';
import { fencedRunWrite } from './run-coordinator.js';

export interface BudgetPolicy {
  workspaceId: string; scope: 'workspace' | 'agent' | 'task'; scopeId: string;
  period: 'utc_day' | 'lifetime'; maxTokens?: number; maxToolCalls?: number; maxRuntimeMs?: number; maxCostUSD?: number;
  /** Existing USD defaults cover metered providers; explicit hard caps can still include subscriptions. */
  subscriptionExempt?: boolean;
  maxModelRequests?: number;
}
export interface BudgetReservation {
  workspaceId: string; taskId: string; agentId: string; key: string;
  kind: 'model' | 'tool'; tokens: number; toolCalls: number; runtimeMs: number;
  costType: ModelCostType; costUSD: number | null;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function amount(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

export function setBudgetPolicy(policy: BudgetPolicy): void {
  if (!policy.workspaceId || !policy.scopeId || !['workspace', 'agent', 'task'].includes(policy.scope)
    || !['utc_day', 'lifetime'].includes(policy.period)
    || [policy.maxTokens, policy.maxToolCalls, policy.maxRuntimeMs, policy.maxCostUSD].some(value => value !== undefined && !amount(value))) {
    throw new Error('BUDGET_POLICY_INVALID');
  }
  if (policy.maxModelRequests !== undefined && (!Number.isSafeInteger(policy.maxModelRequests) || policy.maxModelRequests < 1)) throw new Error('BUDGET_POLICY_INVALID');
  getDb().run(`INSERT INTO agent_budget_policies(workspace_id, scope, scope_id, policy)
    VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, scope, scope_id) DO UPDATE SET policy = excluded.policy`,
    policy.workspaceId, policy.scope, policy.scopeId, JSON.stringify(policy));
}
export function ensureBudgetPolicy(policy: BudgetPolicy): void {
  if (!getDb().get('SELECT policy FROM agent_budget_policies WHERE workspace_id = ? AND scope = ? AND scope_id = ?',
    policy.workspaceId, policy.scope, policy.scopeId)) setBudgetPolicy(policy);
}
export function reserveBudget(data: BudgetReservation, nowMs = Date.now()): void {
  if (!data.key || !data.taskId || !data.agentId || !data.workspaceId
    || ![data.tokens, data.toolCalls, data.runtimeMs].every(amount) || (data.costUSD !== null && !amount(data.costUSD))
    || !['model', 'tool'].includes(data.kind)) throw new Error('BUDGET_RESERVATION_INVALID');
  const fingerprint = hash(data);
  const period = new Date(nowMs).toISOString().slice(0, 10);
  fencedRunWrite(data.taskId, () => getDb().transaction(() => {
    getDb().run(`INSERT INTO agent_budget_reservations
      (workspace_id, reservation_key, task_id, agent_id, period, kind, fingerprint, tokens, tool_calls, runtime_ms, cost_type, cost_usd, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')
      ON CONFLICT(workspace_id, reservation_key) DO NOTHING`,
      data.workspaceId, data.key, data.taskId, data.agentId, period, data.kind, fingerprint,
      data.tokens, data.toolCalls, data.runtimeMs, data.costType, data.costUSD);
    const existing = getDb().get<any>('SELECT fingerprint, status FROM agent_budget_reservations WHERE workspace_id = ? AND reservation_key = ?',
      data.workspaceId, data.key);
    if (existing?.fingerprint !== fingerprint) throw new Error('BUDGET_IDEMPOTENCY_CONFLICT');
    if (existing?.status === 'released') throw new Error('BUDGET_RESERVATION_RELEASED');
    const policies = getDb().all<any>(
      `SELECT policy FROM agent_budget_policies WHERE workspace_id = ?
        AND ((scope = 'workspace') OR (scope = 'agent' AND scope_id = ?) OR (scope = 'task' AND scope_id = ?))`,
      data.workspaceId, data.agentId, data.taskId).map(row => JSON.parse(row.policy) as BudgetPolicy);
    for (const policy of policies) {
      const scope = policy.scope === 'workspace' ? '' : ` AND ${policy.scope === 'task' ? 'task_id' : 'agent_id'} = ?`;
      const periods = policy.period === 'lifetime' ? '' : ' AND period = ?';
      const parameters = [data.workspaceId, ...(policy.scope === 'workspace' ? [] : [policy.scopeId]), ...(periods ? [period] : [])];
      const total = getDb().get<any>(`SELECT
        COALESCE(SUM(COALESCE(observed_tokens, tokens)), 0) AS tokens,
        COALESCE(SUM(tool_calls), 0) AS tool_calls,
        COALESCE(SUM(COALESCE(observed_runtime_ms, runtime_ms)), 0) AS runtime_ms,
        COALESCE(SUM(COALESCE(observed_cost_usd, cost_usd)), 0) AS cost_usd,
        SUM(CASE WHEN kind = 'model' THEN 1 ELSE 0 END) AS model_requests,
        SUM(CASE WHEN kind = 'model' AND cost_usd IS NULL AND observed_cost_usd IS NULL
          ${policy.subscriptionExempt ? "AND cost_type <> 'subscription'" : ''} THEN 1 ELSE 0 END) AS unknown_cost
        FROM agent_budget_reservations WHERE workspace_id = ? AND status <> 'released'${scope}${periods}`, ...parameters);
      if (policy.maxCostUSD !== undefined && (data.kind === 'model' && data.costUSD === null
        && !(policy.subscriptionExempt && data.costType === 'subscription') || total.unknown_cost > 0)) {
        throw new Error('BUDGET_UNCERTAIN: hard USD cap cannot authorize unpriced/unknown usage');
      }
      if ((policy.maxTokens !== undefined && total.tokens > policy.maxTokens)
        || (policy.maxModelRequests !== undefined && total.model_requests > policy.maxModelRequests)
        || (policy.maxToolCalls !== undefined && total.tool_calls > policy.maxToolCalls)
        || (policy.maxRuntimeMs !== undefined && total.runtime_ms > policy.maxRuntimeMs)
        || (policy.maxCostUSD !== undefined && total.cost_usd > policy.maxCostUSD)) throw new Error('BUDGET_EXHAUSTED');
    }
  }));
}
/** A receipt can report incremental or cumulative usage. Duplicate receipts never spend twice. */
export function settleUsage(data: {
  workspaceId: string; key: string; eventKey: string; mode?: 'delta' | 'cumulative';
  tokens: number | null; runtimeMs?: number; costUSD: number | null; costType: ModelCostType;
}): void {
  if (!data.eventKey || (data.tokens !== null && !amount(data.tokens)) || (data.costUSD !== null && !amount(data.costUSD))
    || (data.runtimeMs !== undefined && !amount(data.runtimeMs))) throw new Error('BUDGET_USAGE_INVALID');
  const db = getDb();
  const reservation = db.get<any>('SELECT * FROM agent_budget_reservations WHERE workspace_id = ? AND reservation_key = ?', data.workspaceId, data.key);
  if (!reservation) throw new Error('BUDGET_RESERVATION_MISSING');
  fencedRunWrite(reservation.task_id, () => db.transaction(() => {
    const created = db.run(`INSERT INTO agent_budget_receipts(workspace_id, reservation_key, event_key, fingerprint)
      VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, reservation_key, event_key) DO NOTHING`,
      data.workspaceId, data.key, data.eventKey, hash(data));
    if (created.changes !== 1) {
      const prior = db.get<any>('SELECT fingerprint FROM agent_budget_receipts WHERE workspace_id = ? AND reservation_key = ? AND event_key = ?',
        data.workspaceId, data.key, data.eventKey);
      if (prior?.fingerprint !== hash(data)) throw new Error('BUDGET_USAGE_IDEMPOTENCY_CONFLICT');
      return;
    }
    const current = db.get<any>('SELECT * FROM agent_budget_reservations WHERE workspace_id = ? AND reservation_key = ?', data.workspaceId, data.key)!;
    const merge = (prior: number | null, next: number | null) => next === null ? prior
      : data.mode === 'delta' ? (prior || 0) + next : Math.max(prior ?? 0, next);
    db.run(`UPDATE agent_budget_reservations SET observed_tokens = ?, observed_cost_usd = ?,
      observed_runtime_ms = ?, cost_type = ?, status = 'settled' WHERE workspace_id = ? AND reservation_key = ?`,
      merge(current.observed_tokens, data.tokens), merge(current.observed_cost_usd, data.costUSD),
      data.runtimeMs ?? current.observed_runtime_ms, data.costType, data.workspaceId, data.key);
  }));
}
export function releaseUndispatchedBudget(workspaceId: string, key: string): void {
  getDb().run(`UPDATE agent_budget_reservations SET status = 'released' WHERE workspace_id = ? AND reservation_key = ? AND status = 'reserved'`, workspaceId, key);
}

export function markBudgetDispatched(workspaceId: string, key: string): void {
  const row = getDb().get<any>('SELECT task_id, status FROM agent_budget_reservations WHERE workspace_id = ? AND reservation_key = ?', workspaceId, key);
  if (!row) throw new Error('BUDGET_RESERVATION_MISSING');
  if (row.status !== 'reserved') throw new Error('BUDGET_DISPATCH_REPLAY_BLOCKED');
  fencedRunWrite(row.task_id, () => {
    const claimed = getDb().run(`UPDATE agent_budget_reservations SET status = 'dispatched'
      WHERE workspace_id = ? AND reservation_key = ? AND status = 'reserved'`, workspaceId, key);
    // Another process may have claimed between the read and this atomic update.
    if (claimed.changes !== 1) throw new Error('BUDGET_DISPATCH_REPLAY_BLOCKED');
  });
}

/** Read accounting without turning conservative reservations into measured usage. */
export function budgetUsage(workspaceId: string, agentId?: string, taskId?: string, nowMs = Date.now()): BudgetUsageSummary[] {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const policies = getDb().all<{ policy: string }>(`SELECT policy FROM agent_budget_policies WHERE workspace_id = ?
    AND (scope = 'workspace' OR (scope = 'agent' AND scope_id = ?) OR (scope = 'task' AND scope_id = ?))`,
  workspaceId, agentId || '', taskId || '').map(row => JSON.parse(row.policy) as BudgetPolicy);
  return policies.map(policy => {
    const clauses = ['workspace_id = ?', "status <> 'released'"];
    const args: unknown[] = [workspaceId];
    if (policy.scope !== 'workspace') { clauses.push(`${policy.scope === 'agent' ? 'agent_id' : 'task_id'} = ?`); args.push(policy.scopeId); }
    if (policy.period === 'utc_day') { clauses.push('period = ?'); args.push(day); }
    const rows = getDb().all<any>(`SELECT * FROM agent_budget_reservations WHERE ${clauses.join(' AND ')}`, ...args);
    const observed = { tokens: 0, toolCalls: 0, runtimeMs: 0, costUSD: 0 };
    const reserved = { tokens: 0, toolCalls: 0, runtimeMs: 0, costUSD: 0 };
    let unknownTokens = 0, unknownCost = 0, estimatedCost = false;
    for (const row of rows) {
      if (row.observed_tokens !== null) observed.tokens += row.observed_tokens;
      else { reserved.tokens += row.tokens; if (row.kind === 'model' && row.status !== 'reserved') unknownTokens++; }
      if (row.status === 'reserved') reserved.toolCalls += row.tool_calls;
      else observed.toolCalls += row.tool_calls;
      if (row.observed_runtime_ms !== null) observed.runtimeMs += row.observed_runtime_ms;
      else reserved.runtimeMs += row.runtime_ms;
      if (row.observed_cost_usd !== null) observed.costUSD += row.observed_cost_usd;
      else reserved.costUSD += row.cost_usd || 0;
      if (row.kind === 'model' && row.observed_cost_usd === null && row.cost_usd === null) unknownCost++;
      if (row.cost_type === 'estimated') estimatedCost = true;
    }
    const left = (max: number | undefined, used: number, held: number) => max === undefined ? null : Math.max(0, max - used - held);
    return { scope: policy.scope, scopeId: policy.scopeId, period: policy.period,
      periodStart: policy.period === 'utc_day' ? `${day}T00:00:00.000Z` : null,
      periodEnd: policy.period === 'utc_day' ? new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString() : null,
      limits: { tokens: policy.maxTokens, toolCalls: policy.maxToolCalls, runtimeMs: policy.maxRuntimeMs, costUSD: policy.maxCostUSD },
      observed, reserved, remaining: { tokens: left(policy.maxTokens, observed.tokens, reserved.tokens),
        toolCalls: left(policy.maxToolCalls, observed.toolCalls, reserved.toolCalls),
        runtimeMs: left(policy.maxRuntimeMs, observed.runtimeMs, reserved.runtimeMs),
        costUSD: left(policy.maxCostUSD, observed.costUSD, reserved.costUSD) },
      unknownTokens, unknownCost, estimatedCost };
  });
}

/** Size the next request from every remaining quota; reservation is still the atomic authority. */
export function boundedModelOutput(workspaceId: string, agentId: string, taskId: string, input: number, requested: number): number {
  const summaries = budgetUsage(workspaceId, agentId, taskId);
  const bounds = summaries.map(item => item.remaining.tokens).filter((value): value is number => value !== null);
  const result = Math.floor(Math.min(requested, ...bounds.map(value => value - input)));
  if (result < 1) throw new Error('BUDGET_EXHAUSTED: no token allowance remains for this request');
  return result;
}

export function hasHardBudget(workspaceId: string, agentId: string, taskId: string): boolean {
  return budgetUsage(workspaceId, agentId, taskId).some(item =>
    Object.values(item.limits).some(value => value !== undefined));
}
