import { discoverCopilotModels } from '../models/provider-model-discovery.js';
import { getModel, getModelRoute, isCopilotAccountModel, isModelSelectable } from '../models/model-registry.js';
import { HttpError } from './http.js';

export function validateModelId(value: string | undefined): string | undefined {
  if (!value || value === 'auto') return undefined;
  const model = getModel(value);
  if (!model || !isModelSelectable(model)
    || (process.env.MYRMECIA_MODEL_PROVIDER?.trim().toLowerCase() === 'copilot' && !isCopilotAccountModel(model))) {
    throw new HttpError(400, 'INVALID_MODEL', 'Selected model is not available for the current provider. Refresh the model list and choose an available model.');
  }
  return model.id;
}

/** Recheck the effective Copilot choice immediately before accepting new work. */
export async function validateRequestedModelId(value: string | undefined): Promise<string | undefined> {
  if (process.env.MYRMECIA_MODEL_PROVIDER?.trim().toLowerCase() === 'copilot') {
    let models;
    try {
      models = await discoverCopilotModels();
    } catch {
      throw new HttpError(503, 'MODEL_DISCOVERY_UNAVAILABLE', 'Unable to verify the current Copilot account models. Refresh the model list and retry.');
    }
    const effectiveId = value && value !== 'auto' ? value
      : getModelRoute('provider:copilot')?.defaultModelId || process.env.MYRMECIA_MODEL || process.env.AGENT_FACTORY_MODEL || 'auto';
    if (!models.some(model => model.id === effectiveId && model.selectable)) {
      throw new HttpError(400, 'INVALID_MODEL', 'Selected model is not available for the current Copilot account. Refresh the model list and choose an available model.');
    }
  }
  return validateModelId(value);
}
