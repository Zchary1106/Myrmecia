import { getModelGateway } from './gateway.js';
import { isModelSelectable, syncProviderModels } from './model-registry.js';
import type { ProviderModelOption } from '../types.js';

/** A successful live snapshot is authoritative; never append cached or builtin models. */
export async function discoverCopilotModels(): Promise<ProviderModelOption[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const discovered = await Promise.race([
    getModelGateway().listProviderModels('copilot'),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Copilot model discovery timed out. Refresh the model list to retry.')), 15_000);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (discovered.length === 0) throw new Error('Copilot returned no models. Refresh the account model list before starting work.');
  const registered = syncProviderModels('copilot', discovered.map(model => ({
    ...model,
    supportsReasoningEffort: Boolean(model.supportedReasoningEfforts?.length),
  })));
  return discovered.map(model => ({
    id: model.id,
    name: model.name,
    supportsReasoningEffort: Boolean(model.supportedReasoningEfforts?.length),
    supportedReasoningEfforts: model.supportedReasoningEfforts as ProviderModelOption['supportedReasoningEfforts'],
    maxTokens: model.maxTokens,
    source: 'provider' as const,
    policyState: model.policy?.state,
    policyTerms: model.policy?.terms,
    billingMultiplier: model.billing?.multiplier,
    selectable: registered.some(entry => entry.id === model.id && isModelSelectable(entry)),
  }));
}
