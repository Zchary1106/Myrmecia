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
  /** No runtime activity for this long is treated as a stalled execution. */
  maxExecutionIdleMs: number;
  /** Task-log heartbeat cadence for long-running executions. */
  executionHeartbeatMs: number;
  maxAgentExecutionsPerWindow: number;
  agentRateWindowMs: number;
  maxExecutionWallClockMs: number;
  pythonRuntimeMemoryMB: number;
  pythonRuntimeCpuSeconds: number;
  pythonRuntimeMaxStdoutBytes: number;
  pythonRuntimeMaxStderrBytes: number;
}

export function getRuntimeLimits(): RuntimeLimits {
  return {
    maxExecutionTokens: parsePositiveInt(process.env.AGENT_MAX_EXECUTION_TOKENS, 200_000),
    maxModelResponseTokens: parsePositiveInt(process.env.AGENT_MAX_RESPONSE_TOKENS, 8_192),
    maxOutputChars: parsePositiveInt(process.env.AGENT_MAX_OUTPUT_CHARS, 120_000),
    maxToolCallsPerExecution: parsePositiveInt(process.env.AGENT_MAX_TOOL_CALLS, 80),
    maxToolCallTimeoutMs: parsePositiveInt(process.env.AGENT_TOOL_TIMEOUT_MS, 120_000),
    maxToolRuntimeMsPerStep: parsePositiveInt(process.env.AGENT_STEP_TOOL_RUNTIME_MS, 600_000),
    maxToolRuntimeMsPerExecution: parsePositiveInt(process.env.AGENT_EXECUTION_TOOL_RUNTIME_MS, 1_500_000),
    maxExecutionIdleMs: parsePositiveInt(process.env.AGENT_IDLE_TIMEOUT_MS, 300_000),
    executionHeartbeatMs: parsePositiveInt(process.env.AGENT_HEARTBEAT_MS, 30_000),
    maxAgentExecutionsPerWindow: parsePositiveInt(process.env.AGENT_RATE_LIMIT_MAX, 30),
    agentRateWindowMs: parsePositiveInt(process.env.AGENT_RATE_LIMIT_WINDOW_MS, 60_000),
    maxExecutionWallClockMs: parsePositiveInt(process.env.AGENT_MAX_WALL_CLOCK_MS, 1_800_000),
    pythonRuntimeMemoryMB: parsePositiveInt(process.env.AGENT_FACTORY_PYTHON_MEMORY_MB, 2_048),
    pythonRuntimeCpuSeconds: parsePositiveInt(process.env.AGENT_FACTORY_PYTHON_CPU_SECONDS, 1_800),
    pythonRuntimeMaxStdoutBytes: parsePositiveInt(process.env.AGENT_FACTORY_PYTHON_MAX_STDOUT_BYTES, 1_048_576),
    pythonRuntimeMaxStderrBytes: parsePositiveInt(process.env.AGENT_FACTORY_PYTHON_MAX_STDERR_BYTES, 262_144),
  };
}

function minPositive(globalValue: number, policyValue: number | undefined): number {
  return policyValue && policyValue > 0 ? Math.min(globalValue, policyValue) : globalValue;
}

export function resolveAgentRuntimeLimits(agent: AgentDefinition, modelSelection?: ModelSelection, requestedContextLength?: number): RuntimeLimits {
  const limits = getRuntimeLimits();
  const policy = modelSelection?.budget || agent.config.modelPolicy || {};
  const maxExecutionTokens = requestedContextLength && requestedContextLength > 0
    ? Math.min(limits.maxExecutionTokens, requestedContextLength)
    : limits.maxExecutionTokens;
  return {
    ...limits,
    maxExecutionTokens: minPositive(maxExecutionTokens, policy.maxTokens),
    maxModelResponseTokens: minPositive(limits.maxModelResponseTokens, policy.maxResponseTokens),
    maxToolCallsPerExecution: minPositive(limits.maxToolCallsPerExecution, policy.maxToolCalls),
    maxExecutionWallClockMs: minPositive(limits.maxExecutionWallClockMs, policy.maxWallClockMs),
    // Keep the liveness monitor meaningful even when a deployment configures a
    // heartbeat that is longer than its idle budget.
    executionHeartbeatMs: Math.min(limits.executionHeartbeatMs, limits.maxExecutionIdleMs),
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
