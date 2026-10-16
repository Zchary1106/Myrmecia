import type { ModelDefinition, ModelProviderSettings } from '@myrmecia/shared';

/** The registry is inventory, not evidence that the current account can execute a model. */
export function currentAccountModels(models: ModelDefinition[], settings: ModelProviderSettings | null): ModelDefinition[] {
  if (settings?.source !== 'provider') return [];
  const selectableIds = new Set(settings.models.filter(model => model.selectable).map(model => model.id));
  return models.filter(model => model.provider === settings.provider && selectableIds.has(model.id) && model.enabled);
}
