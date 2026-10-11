import type { RuntimeCapabilities, RuntimeRequest, RuntimeResponse, RuntimeToolCall } from '@myrmecia/shared';
import type { ToolSchedulerOptions } from './tool-scheduler.js';

export interface CoreProvider {
  capabilities: RuntimeCapabilities;
  complete(request: RuntimeRequest, signal: AbortSignal): Promise<RuntimeResponse>;
}

export interface TurnHookContext {
  turn: number;
  signal: AbortSignal;
}

export interface TurnHooks {
  prepareRequest?: (request: RuntimeRequest, context: TurnHookContext) => RuntimeRequest | Promise<RuntimeRequest>;
  transformContext?: (request: RuntimeRequest, context: TurnHookContext) => RuntimeRequest | Promise<RuntimeRequest>;
  /** Additional hooks can reject, but cannot replace the authoritative tool executor. */
  beforeToolCall?: (tool: RuntimeToolCall, context: TurnHookContext) => void | Promise<void>;
  afterToolCall?: (tool: RuntimeToolCall, output: string, context: TurnHookContext) => void | Promise<void>;
  finishTurn?: (response: RuntimeResponse, context: TurnHookContext) => void | Promise<void>;
  prepareNextTurn?: (request: RuntimeRequest, context: TurnHookContext) => RuntimeRequest | Promise<RuntimeRequest>;
}

export interface AgentCoreDependencies {
  provider: CoreProvider;
  signal: AbortSignal;
  maxTurns: number;
  initialTurn?: number;
  hooks?: TurnHooks;
  executeTool: (call: RuntimeToolCall, context: TurnHookContext) => Promise<string>;
  toolScheduler?: Omit<ToolSchedulerOptions, 'signal' | 'execute'>;
  /** Business code can declare a clarification/final outcome but cannot continue beyond budgets. */
  shouldFinish?: (response: RuntimeResponse, context: TurnHookContext) => boolean | Promise<boolean>;
}

export interface AgentCoreResult {
  response: RuntimeResponse;
  request: RuntimeRequest;
  turns: number;
}

/** Incremental adapter: the Harness owns governance/business, Core owns turn bounds. */
export interface GovernedTurnAdapter {
  signal: AbortSignal;
  maxTurns: number;
  initialTurn?: number;
  executeTurn: (turn: number) => Promise<boolean>;
  onExhausted?: () => never;
}
