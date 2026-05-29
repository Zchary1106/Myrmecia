import type { AgentDefinition, ModelSelection } from '../types.js';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface RuntimeLimits {
  maxExecutionTokens: number;
  maxModelResponseTokens: number;
  maxOutputChars: number;
  maxToolCallsPerExecution: number;
  maxToolCallTimeoutMs: number;
  maxToolRuntimeMsPerStep: number;
  maxToolRuntimeMsPerExecution: number;
  maxAgentExecutionsPerWindow: number;
  agentRateWindowMs: number;
  maxExecutionWallClockMs: number;
  crewMemoryMB: number;
  crewCpuSeconds: number;
  crewMaxStdoutBytes: number;
  crewMaxStderrBytes: number;
}

export function getRuntimeLimits(): RuntimeLimits {
  return {
    maxExecutionTokens: parsePositiveInt(process.env.AGENT_MAX_EXECUTION_TOKENS, 120_000),
    maxModelResponseTokens: parsePositiveInt(process.env.AGENT_MAX_RESPONSE_TOKENS, 4_096),
    maxOutputChars: parsePositiveInt(process.env.AGENT_MAX_OUTPUT_CHARS, 120_000),
    maxToolCallsPerExecution: parsePositiveInt(process.env.AGENT_MAX_TOOL_CALLS, 80),
    maxToolCallTimeoutMs: parsePositiveInt(process.env.AGENT_TOOL_TIMEOUT_MS, 60_000),
    maxToolRuntimeMsPerStep: parsePositiveInt(process.env.AGENT_STEP_TOOL_RUNTIME_MS, 120_000),
    maxToolRuntimeMsPerExecution: parsePositiveInt(process.env.AGENT_EXECUTION_TOOL_RUNTIME_MS, 300_000),
    maxAgentExecutionsPerWindow: parsePositiveInt(process.env.AGENT_RATE_LIMIT_MAX, 30),
    agentRateWindowMs: parsePositiveInt(process.env.AGENT_RATE_LIMIT_WINDOW_MS, 60_000),
    maxExecutionWallClockMs: parsePositiveInt(process.env.AGENT_MAX_WALL_CLOCK_MS, 300_000),
    crewMemoryMB: parsePositiveInt(process.env.AGENT_CREW_MEMORY_MB, 2_048),
    crewCpuSeconds: parsePositiveInt(process.env.AGENT_CREW_CPU_SECONDS, 300),
    crewMaxStdoutBytes: parsePositiveInt(process.env.AGENT_CREW_MAX_STDOUT_BYTES, 1_048_576),
    crewMaxStderrBytes: parsePositiveInt(process.env.AGENT_CREW_MAX_STDERR_BYTES, 262_144),
  };
}

function minPositive(globalValue: number, policyValue: number | undefined): number {
  return policyValue && policyValue > 0 ? Math.min(globalValue, policyValue) : globalValue;
}

export function resolveAgentRuntimeLimits(agent: AgentDefinition, modelSelection?: ModelSelection): RuntimeLimits {
  const limits = getRuntimeLimits();
  const policy = modelSelection?.budget || agent.config.modelPolicy || {};
  return {
    ...limits,
    maxExecutionTokens: minPositive(limits.maxExecutionTokens, policy.maxTokens),
    maxModelResponseTokens: minPositive(limits.maxModelResponseTokens, policy.maxResponseTokens),
    maxToolCallsPerExecution: minPositive(limits.maxToolCallsPerExecution, policy.maxToolCalls),
    maxExecutionWallClockMs: minPositive(limits.maxExecutionWallClockMs, policy.maxWallClockMs),
  };
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function enforceOutputLength(text: string, label = 'agent output'): string {
  const { maxOutputChars } = getRuntimeLimits();
  if (text.length > maxOutputChars) {
    throw new Error(`${label} exceeded max output length (${text.length}/${maxOutputChars} chars)`);
  }
  return text;
}

export function assertExecutionTokenBudget(
  inputTokens: number,
  outputTokens: number,
  outputText = '',
  label = 'agent execution',
  limits = getRuntimeLimits(),
): void {
  const measuredTokens = inputTokens + outputTokens;
  const estimatedTokens = measuredTokens > 0 ? measuredTokens : estimateTokenCount(outputText);
  if (estimatedTokens > limits.maxExecutionTokens) {
    throw new Error(`${label} exceeded token budget (${estimatedTokens}/${limits.maxExecutionTokens})`);
  }
}

export function remainingResponseTokens(inputTokens: number, outputTokens: number, limits = getRuntimeLimits()): number {
  const remaining = limits.maxExecutionTokens - inputTokens - outputTokens;
  if (remaining <= 0) {
    throw new Error(`agent execution exceeded token budget (${inputTokens + outputTokens}/${limits.maxExecutionTokens})`);
  }
  return Math.min(limits.maxModelResponseTokens, remaining);
}
