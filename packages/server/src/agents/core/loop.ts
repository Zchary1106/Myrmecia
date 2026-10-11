import type { RuntimeRequest, RuntimeResponse } from '@myrmecia/shared';
import type { AgentCoreDependencies, AgentCoreResult, CoreProvider, GovernedTurnAdapter, TurnHooks, TurnHookContext } from './types.js';
import { scheduleToolBatch } from './tool-scheduler.js';

export class AgentCoreStopped extends Error {
  constructor(readonly reason: 'cancelled' | 'max_turns' | 'empty_output' | 'model_truncated' | 'failed', message: string, readonly response?: RuntimeResponse) {
    super(message);
    this.name = 'AgentCoreStopped';
  }
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentCoreStopped('cancelled', 'Request aborted');
}

/** Database/SDK/business-free host loop. Provider-owned internal loops remain opaque. */
export async function runAgentRequest(request: RuntimeRequest, options: {
  provider: CoreProvider; context: TurnHookContext; hooks?: TurnHooks;
}): Promise<RuntimeResponse> {
  active(options.context.signal);
  request = await options.hooks?.prepareRequest?.(request, options.context) ?? request;
  active(options.context.signal);
  request = await options.hooks?.transformContext?.(request, options.context) ?? request;
  active(options.context.signal);
  const response = await options.provider.complete(request, options.context.signal);
  active(options.context.signal);
  return response;
}

async function runGovernedTurns(adapter: GovernedTurnAdapter): Promise<number> {
  if (!Number.isInteger(adapter.maxTurns) || adapter.maxTurns < 1 || !Number.isInteger(adapter.initialTurn ?? 0)
    || (adapter.initialTurn ?? 0) < 0) throw new Error('Invalid Agent Core turn budget');
  for (let turn = (adapter.initialTurn ?? 0) + 1; turn <= adapter.maxTurns; turn++) {
    active(adapter.signal);
    const completed = await adapter.executeTurn(turn);
    active(adapter.signal);
    if (completed) return turn;
  }
  if (adapter.onExhausted) return adapter.onExhausted();
  throw new AgentCoreStopped('max_turns', 'AGENT_MAX_TURNS');
}

export function runAgentCore(adapter: GovernedTurnAdapter): Promise<number>;
export function runAgentCore(initialRequest: RuntimeRequest, deps: AgentCoreDependencies): Promise<AgentCoreResult>;
export async function runAgentCore(input: RuntimeRequest | GovernedTurnAdapter, deps?: AgentCoreDependencies): Promise<AgentCoreResult | number> {
  if ('executeTurn' in input) return runGovernedTurns(input);
  if (!deps) throw new Error('Agent Core dependencies required');
  const initialRequest = input;
  if (!Number.isInteger(deps.maxTurns) || deps.maxTurns < 1 || !Number.isInteger(deps.initialTurn ?? 0)
    || (deps.initialTurn ?? 0) < 0) throw new Error('Invalid Agent Core turn budget');
  let request: RuntimeRequest = structuredClone(initialRequest);
  let response: RuntimeResponse | undefined;
  for (let turn = (deps.initialTurn ?? 0) + 1; turn <= deps.maxTurns; turn++) {
    const context: TurnHookContext = { turn, signal: deps.signal };
    response = await runAgentRequest(request, { provider: deps.provider, hooks: deps.hooks, context });
    if (response.stopReason === 'length') throw new AgentCoreStopped('model_truncated', 'AGENT_MODEL_TRUNCATED', response);
    if (response.stopReason === 'content_filter' || response.stopReason === 'unknown') {
      throw new AgentCoreStopped('failed', 'AGENT_MODEL_STOP_UNSUPPORTED', response);
    }
    if (deps.provider.capabilities.executionMode === 'provider_loop' && response.toolCalls.length) {
      throw new AgentCoreStopped('failed', 'PROVIDER_OWNED_TOOLS_CANNOT_BE_HOST_REPLAYED', response);
    }
    request.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls.length ? response.toolCalls : undefined });
    const outputs = await scheduleToolBatch(response.toolCalls, {
      ...deps.toolScheduler,
      signal: deps.signal, classify: deps.toolScheduler?.classify ?? (() => ({ effect: 'unknown', resources: [], basis: 'default conservative serial' })),
      execute: async tool => {
      active(deps.signal);
      await deps.hooks?.beforeToolCall?.(tool, context);
      active(deps.signal);
      const output = await deps.executeTool(tool, context);
      active(deps.signal);
      await deps.hooks?.afterToolCall?.(tool, output, context);
      active(deps.signal);
      return output;
      },
    });
    response.toolCalls.forEach((tool, index) => {
      request.messages.push({ role: 'tool', toolCallId: tool.id, content: [{ type: 'text', text: outputs[index] }] });
    });
    await deps.hooks?.finishTurn?.(response, context);
    active(deps.signal);
    const done = deps.shouldFinish ? await deps.shouldFinish(response, context) : response.toolCalls.length === 0;
    if (done) {
      if (!response.content.some(block => block.type === 'text' && block.text.trim())) {
        throw new AgentCoreStopped('empty_output', 'AGENT_EMPTY_OUTPUT', response);
      }
      return { response, request, turns: turn };
    }
    request = await deps.hooks?.prepareNextTurn?.(request, context) ?? request;
    active(deps.signal);
  }
  throw new AgentCoreStopped('max_turns', 'AGENT_MAX_TURNS', response);
}
