import type { TurnHooks } from './types.js';

/** Ordered, awaited middleware composition. Exceptions stop the chain. */
export function composeTurnHooks(hooks: readonly TurnHooks[]): TurnHooks {
  return {
    async prepareRequest(request, context) {
      for (const hook of hooks) request = await hook.prepareRequest?.(request, context) ?? request;
      return request;
    },
    async transformContext(request, context) {
      for (const hook of hooks) request = await hook.transformContext?.(request, context) ?? request;
      return request;
    },
    async beforeToolCall(tool, context) { for (const hook of hooks) await hook.beforeToolCall?.(tool, context); },
    async afterToolCall(tool, output, context) { for (const hook of hooks) await hook.afterToolCall?.(tool, output, context); },
    async finishTurn(response, context) { for (const hook of hooks) await hook.finishTurn?.(response, context); },
    async prepareNextTurn(request, context) {
      for (const hook of hooks) request = await hook.prepareNextTurn?.(request, context) ?? request;
      return request;
    },
  };
}
