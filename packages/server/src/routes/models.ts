import { Router } from 'express';
import { z } from 'zod';
import { createOperatorAction } from '../db/models/operator-action.js';
import { actorFromRequest, HttpError, notFound, parseBody, parseQuery, requireOperatorRole, sendError } from './http.js';
import {
  getModel,
  getModelRoute,
  COPILOT_COMPATIBILITY_MODEL_IDS,
  listModelRoutes,
  listModels,
  recordModelHealth,
  syncProviderModels,
  updateModel,
  upsertModelRoute,
} from '../models/model-registry.js';
import { getModelGateway } from '../models/gateway.js';
import type { ModelProviderSettings, ProviderModelOption } from '../types.js';

const listModelsQuerySchema = z.object({
  enabled: z.enum(['true', 'false']).optional(),
});

const updateModelSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  fallbackGroup: z.string().trim().min(1).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field must be provided' });

const updateRouteSchema = z.object({
  routeKey: z.string().trim().min(1),
  defaultModelId: z.string().trim().min(1).optional(),
  fallbackGroup: z.string().trim().min(1).default('balanced'),
});

const providerModelSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
});

function configuredProvider(): string {
  return process.env.MYRMECIA_MODEL_PROVIDER?.trim().toLowerCase() || 'openai-compatible';
}

async function discoverCopilotModels(): Promise<ProviderModelOption[]> {
  const discovered = await getModelGateway().listProviderModels('copilot');
  const models = discovered.map(model => ({
    id: model.id,
    name: model.name,
    supportsReasoningEffort: Boolean(model.supportedReasoningEfforts?.length),
    policyState: model.policy?.state,
    policyTerms: model.policy?.terms,
    billingMultiplier: model.billing?.multiplier,
    selectable: model.policy?.state !== 'disabled',
  }));
  syncProviderModels('copilot', discovered.map(model => ({
    ...model,
    supportsReasoningEffort: Boolean(model.supportedReasoningEfforts?.length),
  })));
  return models;
}

function cachedCopilotModels(): ProviderModelOption[] {
  return listModels({ enabled: true })
    .filter(model => model.provider === 'copilot')
    .map(model => ({
      id: model.id,
      name: model.displayName,
      supportsReasoningEffort: model.capabilityTags.includes('reasoning-effort'),
      policyState: (model.costProfile.policy as { state?: ProviderModelOption['policyState'] } | undefined)?.state,
      policyTerms: (model.costProfile.policy as { terms?: string } | undefined)?.terms,
      billingMultiplier: (model.costProfile.billing as { multiplier?: number } | undefined)?.multiplier,
      selectable: (model.costProfile.policy as { state?: string } | undefined)?.state !== 'disabled',
    }));
}

function compatibilityCopilotModels(): ProviderModelOption[] {
  const ids = new Set<string>(COPILOT_COMPATIBILITY_MODEL_IDS);
  return listModels({ enabled: true })
    .filter(model => ids.has(model.id))
    .map(model => ({
      id: model.id,
      name: model.displayName,
      supportsReasoningEffort: model.capabilityTags.includes('reasoning') || model.capabilityTags.includes('reasoning-effort'),
      policyState: 'unconfigured' as const,
      policyTerms: 'Compatibility model. GitHub Copilot may remap the request when the account model catalog is temporarily unavailable.',
      selectable: true,
    }));
}

function mergeProviderModels(primary: ProviderModelOption[], fallback: ProviderModelOption[]): ProviderModelOption[] {
  const merged = new Map(fallback.map(model => [model.id, model]));
  for (const model of primary) merged.set(model.id, model);
  return [...merged.values()].sort((left, right) => {
    if (left.id === 'auto') return -1;
    if (right.id === 'auto') return 1;
    return left.name.localeCompare(right.name);
  });
}

async function availableCopilotModels(): Promise<{ models: ProviderModelOption[]; warning?: string }> {
  const liveModels = await discoverCopilotModels();
  const onlyAuto = liveModels.length === 1 && liveModels[0]?.id === 'auto';
  if (!onlyAuto) return { models: liveModels };

  const models = mergeProviderModels(
    liveModels,
    mergeProviderModels(cachedCopilotModels(), compatibilityCopilotModels()),
  );
  return {
    models,
    ...(models.length > liveModels.length
      ? { warning: 'Copilot model discovery temporarily returned only Auto; showing the last discovered account models.' }
      : {}),
  };
}

async function providerSettings(): Promise<ModelProviderSettings> {
  const provider = configuredProvider();
  if (provider !== 'copilot') {
    return {
      provider,
      selectedModelId: process.env.MYRMECIA_MODEL || process.env.AGENT_FACTORY_MODEL,
      models: [],
    };
  }

  const selectedModelId = getModelRoute('provider:copilot')?.defaultModelId
    || process.env.MYRMECIA_MODEL
    || process.env.AGENT_FACTORY_MODEL
    || 'auto';
  try {
    const { models, warning } = await availableCopilotModels();
    return {
      provider,
      selectedModelId: models.some(model => model.id === selectedModelId && model.selectable)
        ? selectedModelId
        : models.find(model => model.selectable)?.id || selectedModelId,
      models,
      ...(warning ? { error: warning } : {}),
    };
  } catch (err) {
    const fallbackModels = cachedCopilotModels();
    return {
      provider,
      selectedModelId,
      models: fallbackModels,
      error: err instanceof Error ? err.message : 'Unable to discover Copilot models.',
    };
  }
}

export function createModelRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    try {
      const query = parseQuery(listModelsQuerySchema, req);
      res.json(listModels({ enabled: query.enabled === undefined ? undefined : query.enabled === 'true' }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/routes', (_req, res) => {
    res.json(listModelRoutes());
  });

  router.get('/provider-settings', async (_req, res) => {
    res.json(await providerSettings());
  });

  router.put('/provider-settings', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'model.provider.update', ['admin', 'operator']);
      if (configuredProvider() !== 'copilot') {
        throw new HttpError(409, 'PROVIDER_NOT_ACTIVE', 'GitHub Copilot is not the active model provider');
      }
      const { modelId } = parseBody(providerModelSchema, req);
      const { models, warning } = await availableCopilotModels();
      const selected = models.find(model => model.id === modelId);
      if (!selected) notFound('MODEL_NOT_FOUND', 'Model is not available for the signed-in Copilot account');
      if (!selected.selectable) {
        throw new HttpError(409, 'MODEL_DISABLED', 'Model is disabled by the current Copilot account or organization policy');
      }

      upsertModelRoute({
        routeKey: 'provider:copilot',
        defaultModelId: selected.id,
        fallbackGroup: 'copilot',
        modelTier: 'balanced',
      });
      createOperatorAction({
        action: 'model.provider.update',
        actor,
        targetType: 'model',
        targetId: selected.id,
        metadata: { provider: 'copilot', modelId: selected.id },
      });
      res.json({
        provider: 'copilot',
        selectedModelId: selected.id,
        models,
        ...(warning ? { error: warning } : {}),
      } satisfies ModelProviderSettings);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.patch('/routes', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'model.route.update', ['admin', 'operator']);
      const body = parseBody(updateRouteSchema, req);
      if (body.defaultModelId && !getModel(body.defaultModelId)) {
        notFound('MODEL_NOT_FOUND', 'Default model not found');
      }
      const route = upsertModelRoute({ ...body, fallbackGroup: body.fallbackGroup || 'balanced' });
      createOperatorAction({
        action: 'model.route.update',
        actor,
        targetType: 'model',
        targetId: route.routeKey,
        metadata: route as unknown as Record<string, unknown>,
      });
      res.json(route);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id', (req, res) => {
    const model = getModel(req.params.id);
    if (!model) return res.status(404).json({ error: { message: 'Model not found' } });
    res.json(model);
  });

  router.patch('/:id', (req, res) => {
    try {
      const existing = getModel(req.params.id);
      if (!existing) notFound('MODEL_NOT_FOUND', 'Model not found');
      const actor = requireOperatorRole(req, 'model.update', ['admin', 'operator']);
      const updates = parseBody(updateModelSchema, req);
      const model = updateModel(req.params.id, updates);
      if (!model) throw new HttpError(404, 'MODEL_NOT_FOUND', 'Model not found');
      createOperatorAction({
        action: 'model.update',
        actor,
        targetType: 'model',
        targetId: req.params.id,
        metadata: {
          previous: {
            enabled: existing.enabled,
            priority: existing.priority,
            fallbackGroup: existing.fallbackGroup,
          },
          next: {
            enabled: model.enabled,
            priority: model.priority,
            fallbackGroup: model.fallbackGroup,
          },
        },
      });
      res.json(model);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/health-check', async (req, res) => {
    try {
      const model = getModel(req.params.id);
      if (!model) notFound('MODEL_NOT_FOUND', 'Model not found');
      const actor = actorFromRequest(req);
      let status: 'healthy' | 'degraded' | 'disabled' = model.enabled ? 'healthy' : 'disabled';
      let error: string | undefined;
      const startedAt = Date.now();
      if (model.provider === 'copilot' && model.enabled) {
        try {
          const discovered = await getModelGateway().listProviderModels('copilot');
          const match = discovered.find(candidate => candidate.id === model.id);
          if (!match) {
            status = 'degraded';
            error = 'Model is not present in the latest authenticated Copilot catalog; cached compatibility entry only.';
          } else if (match.policy?.state === 'disabled') {
            status = 'disabled';
            error = match.policy.terms || 'Disabled by Copilot policy';
          }
        } catch (healthError) {
          status = 'degraded';
          error = healthError instanceof Error ? healthError.message : 'Copilot model discovery failed';
        }
      }
      const checked = recordModelHealth({
        modelId: req.params.id,
        status,
        latencyMs: Date.now() - startedAt,
        error,
      });
      createOperatorAction({
        action: 'model.health_check',
        actor,
        targetType: 'model',
        targetId: req.params.id,
        metadata: { status: checked?.healthStatus },
      });
      res.json(checked);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
