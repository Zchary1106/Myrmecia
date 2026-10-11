export interface AgentBudgetLimits {
  maxTurns: number;
  timeoutSeconds: number;
  maxConcurrent: number;
  period: 'utc_day' | 'lifetime';
  maxTokens?: number;
  maxToolCalls?: number;
  maxCostUSD?: number;
}
export interface BudgetUsageSummary {
  scope: 'workspace' | 'agent' | 'task';
  scopeId: string;
  period: 'utc_day' | 'lifetime';
  periodStart: string | null;
  periodEnd: string | null;
  limits: { tokens?: number; toolCalls?: number; runtimeMs?: number; costUSD?: number };
  observed: { tokens: number; toolCalls: number; runtimeMs: number; costUSD: number };
  reserved: { tokens: number; toolCalls: number; runtimeMs: number; costUSD: number };
  remaining: { tokens: number | null; toolCalls: number | null; runtimeMs: number | null; costUSD: number | null };
  unknownTokens: number;
  unknownCost: number;
  estimatedCost: boolean;
}
export interface AgentBudgetState {
  revision: number;
  limits: AgentBudgetLimits | null;
  usage: BudgetUsageSummary[];
}
export type AgentControlOperation = 'pause' | 'resume' | 'cancel' | 'followup' | 'rerun' | 'accept';
export interface TaskControlCapabilities {
  taskId: string;
  executionId: string | null;
  state: string;
  operations: Record<AgentControlOperation, { allowed: boolean; reason: string }>;
}
