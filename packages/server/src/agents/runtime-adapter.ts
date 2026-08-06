/**
 * Runtime Adapter — a uniform contract for "the thing that actually runs an
 * agent turn loop". Today there are two built-in adapters (the TypeScript agent
 * loop and the Python runtime); this interface lets new runtimes (Claude Code,
 * Codex CLI, Gemini CLI, OpenCode, a remote worker, …) be plugged in without
 * touching the orchestration, governance, ledger, or trace plumbing around them.
 *
 * An adapter only owns: prepare → execute → cancel → collect. Everything else
 * (workspace, execution row, trace, ledger, cost guardrails, DLP) stays in the
 * AgentRuntime so every runtime is governed and observed identically.
 */
import type {
  AgentDefinition,
  Task,
  ProgressTracker,
  SkillDefinition,
  SkillVersion,
} from '../types.js';
import { isMcpTool } from '../tools/mcp-manager.js';

export interface RuntimeExecutionContext {
  agent: AgentDefinition;
  task: Task;
  abortController: AbortController;
  executionId: string;
  traceId: string;
  spanId: string;
  tracker: ProgressTracker;
  runtimeSkill?: { skill: SkillDefinition; version: SkillVersion; source: 'assignment' | 'skillPath' };
}

export interface RuntimeAdapterResult {
  output: string;
  costUSD: number | null;
  costType?: 'exact' | 'estimated' | 'subscription' | 'unavailable';
  provider?: string;
  actualModelId?: string;
  aiUnits?: number;
  billingMultiplier?: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  numTurns: number;
}

export interface RuntimeAdapter {
  /** Stable identifier, e.g. 'ts-agent-loop', 'python-runtime', 'claude-code'. */
  readonly name: string;
  /** Whether this adapter is able to run the given agent. */
  canHandle(agent: AgentDefinition): boolean;
  /** Run the agent's turn loop and return a normalized result. */
  execute(ctx: RuntimeExecutionContext): Promise<RuntimeAdapterResult>;
}

/** Map the AGENT_EXECUTOR override to a concrete adapter name. */
function aliasForOverride(value: string): string {
  if (value === 'ts') return 'ts-agent-loop';
  if (value === 'python') return 'python-runtime';
  return value;
}

/**
 * Pick the adapter for an agent.
 *
 * Precedence:
 *   1. AGENT_EXECUTOR override (by alias or exact adapter name)
 *   2. The first registered adapter whose `canHandle(agent)` returns true
 *
 * Adapters should be supplied in priority order (more specific first, a
 * catch-all fallback last).
 */
export function selectRuntimeAdapter(
  agent: AgentDefinition,
  adapters: RuntimeAdapter[],
): RuntimeAdapter | undefined {
  const forced = process.env.AGENT_EXECUTOR;
  if (forced) {
    const alias = aliasForOverride(forced);
    const match = adapters.find(adapter => adapter.name === alias);
    if (match) return match;
  }
  return adapters.find(adapter => adapter.canHandle(agent));
}

/** True when an agent declares no tools (the TS loop default). */
export function agentHasNoTools(agent: AgentDefinition): boolean {
  const tools = agent.allowedTools || agent.config.allowedTools || [];
  return tools.length === 0;
}

/**
 * Copilot tool calls are bridged into the TypeScript loop's existing validated
 * sandbox/audit path. Select that loop before the Python catch-all whenever
 * the server-side provider switch explicitly selects Copilot.
 */
export function shouldUseTsAgentLoop(agent: AgentDefinition): boolean {
  const tools = agent.allowedTools || agent.config.allowedTools || [];
  return agentHasNoTools(agent)
    || tools.some(isMcpTool)
    || process.env.MYRMECIA_MODEL_PROVIDER?.trim().toLowerCase() === 'copilot';
}
