import { z } from 'zod';
import type { AgentBudgetLimits, AgentBudgetState, AgentDefinition, Task } from '../types.js';
import { getDb } from '../db/database.js';
import { getAgent, updateAgent } from '../db/models/agent.js';
import { assertKnowledgeAgent } from '../db/models/agent-knowledge.js';
import { HttpError } from '../routes/http.js';
import { budgetUsage, ensureBudgetPolicy, setBudgetPolicy } from './budget-service.js';
import { getAgentSetupSnapshot } from './agent-setup-snapshot.js';
import type { RuntimeLimits } from './runtime-limits.js';
import { runtimeV2Enabled } from './runtime-version.js';
import { guardrails } from './safety-guardrails.js';

export const agentBudgetLimitsSchema = z.object({
  maxTurns: z.number().int().min(1).max(200), timeoutSeconds: z.number().int().min(10).max(3600),
  maxConcurrent: z.number().int().min(1).max(8), period: z.enum(['utc_day', 'lifetime']),
  maxTokens: z.number().int().positive().max(1_000_000_000).optional(),
  maxToolCalls: z.number().int().positive().max(1_000_000).optional(),
  maxCostUSD: z.number().positive().max(1_000_000).optional(),
}).strict();
export const saveAgentBudgetSchema = z.object({ expectedRevision: z.number().int().nonnegative(), limits: agentBudgetLimitsSchema }).strict();
export function agentBudgetState(agentId: string, workspaceId: string): AgentBudgetState {
  assertKnowledgeAgent(agentId, workspaceId);
  const row = getDb().get<{ revision: number; limits: string }>('SELECT revision, limits FROM agent_governance_budgets WHERE workspace_id = ? AND agent_id = ?', workspaceId, agentId);
  const configured = getAgent(agentId)!.config;
  return { revision: row?.revision || 0, limits: row ? JSON.parse(row.limits) : configured.governanceBudget || {
    maxTurns: getAgent(agentId)!.maxTurns || configured.maxTurns || 50,
    timeoutSeconds: configured.timeout || 300, maxConcurrent: configured.maxConcurrent || 1, period: 'lifetime',
  }, usage: budgetUsage(workspaceId, agentId) };
}
export function saveAgentBudget(agentId: string, workspaceId: string, expectedRevision: number, limits: AgentBudgetLimits): AgentBudgetState {
  agentBudgetLimitsSchema.parse(limits);
  return getDb().transaction(() => {
    const current = agentBudgetState(agentId, workspaceId);
    if (current.revision !== expectedRevision) {
      if (JSON.stringify(current.limits) === JSON.stringify(limits) && current.revision === expectedRevision + 1) return current;
      throw new HttpError(409, 'BUDGET_REVISION_CONFLICT', 'Budget changed; reload before saving');
    }
    const agent = getAgent(agentId)!;
    getDb().run(`INSERT INTO agent_governance_budgets(workspace_id,agent_id,revision,limits) VALUES (?,?,?,?)
      ON CONFLICT(workspace_id,agent_id) DO UPDATE SET revision=excluded.revision,limits=excluded.limits`,
    workspaceId, agentId, current.revision + 1, JSON.stringify(limits));
    updateAgent(agentId, { maxTurns: limits.maxTurns, config: { ...agent.config,
      maxTurns: limits.maxTurns, timeout: limits.timeoutSeconds, maxConcurrent: limits.maxConcurrent, governanceBudget: limits } });
    setBudgetPolicy({ workspaceId, scope: 'agent', scopeId: agentId, period: limits.period,
      maxTokens: limits.maxTokens, maxToolCalls: limits.maxToolCalls, maxCostUSD: limits.maxCostUSD });
    return agentBudgetState(agentId, workspaceId);
  });
}
export function prepareTaskBudget(agent: AgentDefinition, task: Task, limits: RuntimeLimits): void {
  const workspaceId = task.workspaceId || 'default';
  const pinned = getAgentSetupSnapshot(task.id)?.completeConfig?.config.governanceBudget || agent.config.governanceBudget;
  const current = getAgent(agent.id)?.config.governanceBudget;
  if (current) ensureBudgetPolicy({ workspaceId, scope: 'agent', scopeId: agent.id, period: current.period,
    maxTokens: current.maxTokens, maxToolCalls: current.maxToolCalls, maxCostUSD: current.maxCostUSD });
  ensureBudgetPolicy({ workspaceId, scope: 'task', scopeId: task.id, period: 'lifetime',
    maxModelRequests: pinned?.maxTurns,
    maxTokens: Math.min(limits.maxExecutionTokens, pinned?.maxTokens || Infinity),
    maxToolCalls: Math.min(limits.maxToolCallsPerExecution, pinned?.maxToolCalls || Infinity),
    maxRuntimeMs: limits.maxToolRuntimeMsPerExecution,
    maxCostUSD: pinned?.maxCostUSD ?? (runtimeV2Enabled() ? guardrails.getConfig().maxCostPerTask : undefined),
    subscriptionExempt: pinned?.maxCostUSD === undefined });
  if (process.env.AGENT_HARD_DAILY_COST_USD !== undefined) {
    const cap = Number(process.env.AGENT_HARD_DAILY_COST_USD);
    if (!Number.isFinite(cap) || cap <= 0) throw new Error('BUDGET_POLICY_INVALID: daily USD ceiling must be positive');
    ensureBudgetPolicy({ workspaceId, scope: 'workspace', scopeId: workspaceId, period: 'utc_day',
      maxCostUSD: cap, subscriptionExempt: false });
  }
}
