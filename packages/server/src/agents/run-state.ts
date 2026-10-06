import type { AgentRunPhase, AgentRunState, AgentStopReason } from '@myrmecia/shared';
import { getExecution, updateExecution } from '../db/models/execution.js';
import { eventBus } from '../events/event-bus.js';
import { lintDeterministicOutput } from '../pipelines/stage-output-validator.js';

const terminal = new Set<AgentRunPhase>(['completed', 'failed', 'cancelled', 'interrupted', 'waiting_for_user']);
const failures: AgentRunPhase[] = ['failed', 'cancelled', 'interrupted'];
const transitions: Record<AgentRunPhase, AgentRunPhase[]> = {
  starting: ['deciding', ...failures],
  deciding: ['acting', 'observing', 'validating', 'waiting_for_user', 'waiting_for_tool', ...failures],
  acting: ['observing', 'deciding', 'validating', 'waiting_for_user', 'waiting_for_tool', ...failures],
  observing: ['deciding', 'acting', 'validating', 'waiting_for_user', 'waiting_for_tool', ...failures],
  waiting_for_tool: ['acting', 'observing', 'deciding', 'waiting_for_user', ...failures],
  validating: ['completed', 'waiting_for_user', ...failures],
  waiting_for_user: [], completed: [], failed: [], cancelled: [], interrupted: [],
};

export function initialAgentRunState(): AgentRunState {
  return {
    schemaVersion: 1, phase: 'starting', turn: 0, toolCallCount: 0,
    acceptance: 'pending', updatedAt: new Date().toISOString(),
  };
}

export function transitionAgentRun(
  state: AgentRunState,
  phase: AgentRunPhase,
  patch: Partial<AgentRunState> = {},
): AgentRunState {
  if (terminal.has(state.phase) && phase !== state.phase) {
    throw new Error(`Cannot resume a settled Agent run: ${state.phase} -> ${phase}`);
  }
  if (state.phase !== phase && !transitions[state.phase].includes(phase)) {
    throw new Error(`Invalid Agent run transition: ${state.phase} -> ${phase}`);
  }
  if (patch.turn !== undefined && patch.turn < state.turn) throw new Error('Agent turn cannot move backwards');
  if (patch.toolCallCount !== undefined && patch.toolCallCount < state.toolCallCount) {
    throw new Error('Agent tool count cannot move backwards');
  }
  return { ...state, ...patch, ...(terminal.has(phase) ? { modelRequest: undefined } : {}),
    schemaVersion: 1, phase, updatedAt: new Date().toISOString() };
}

export function updateAgentRun(executionId: string, phase: AgentRunPhase, patch: Partial<AgentRunState> = {}): AgentRunState | undefined {
  const execution = getExecution(executionId);
  if (!execution) return undefined;
  const state = execution.runState || initialAgentRunState();
  // A cancelled/settled run must ignore a late model or tool completion.
  if (terminal.has(state.phase) && phase !== state.phase) return state;
  const runState = transitionAgentRun(state, phase, patch);
  updateExecution(executionId, { runState });
  eventBus.emit('execution:progress', {
    executionId, taskId: execution.taskId, agentDefId: execution.agentDefId,
    workspaceId: execution.workspaceId, runState, progress: execution.progress,
  });
  return runState;
}

/** Stop reasons must survive adapter boundaries without becoming "success". */
export class AgentRunStopped extends Error {
  constructor(public readonly reason: Exclude<AgentStopReason, 'completed'>, message: string, public readonly partialOutput = '') {
    super(message);
    this.name = 'AgentRunStopped';
  }
}

export function classifyAgentStop(error: unknown, cancelled = false): AgentStopReason {
  if (cancelled) return 'cancelled';
  if (error instanceof AgentRunStopped) return error.reason;
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:Request|Execution) aborted$|^Execution cancelled/i.test(message)) return 'cancelled';
  if (/^Budget exceeded:|daily budget|cost budget/i.test(message)) return 'cost_budget';
  if (/CONTEXT_BUDGET|token budget/i.test(message)) return 'token_budget';
  if (/timeout|TIMED_OUT|timed out|wall.clock budget|^STALLED:/i.test(message)) return 'deadline';
  return 'failed';
}

export function validateAgentOutput(output: string) {
  const checks = [
    { name: 'non_empty_output', passed: output.trim().length > 0, message: output.trim() ? undefined : 'No usable final output' },
    ...lintDeterministicOutput(output).map(message => ({ name: 'output_integrity', passed: false, message })),
  ];
  const passed = checks.every(check => check.passed);
  return {
    status: passed ? 'passed' as const : 'failed' as const,
    scope: 'output' as const,
    checks,
  };
}
