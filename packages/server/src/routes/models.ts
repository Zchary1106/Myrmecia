import { Router } from 'express';
import { z } from 'zod';
import { createOperatorAction } from '../db/models/operator-action.js';
import { actorFromRequest, HttpError, notFound, parseBody, parseQuery, requireOperatorRole, sendError } from './http.js';
import {
  getModel,
  getModelRoute,
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
  }));
  syncProviderModels('copilot', discovered.map(model => ({
    ...model,
    supportsReasoningEffort: Boolean(model.supportedReasoningEfforts?.length),
  })));
  return models;
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
    const models = await discoverCopilotModels();
    return {
      provider,
      selectedModelId: models.some(model => model.id === selectedModelId)
        ? selectedModelId
        : models[0]?.id || selectedModelId,
      models,
    };
  } catch (err) {
    const fallbackModels = listModels({ enabled: true })
      .filter(model => model.provider === 'copilot')
      .map(model => ({
        id: model.id,
        name: model.displayName,
        supportsReasoningEffort: model.capabilityTags.includes('reasoning-effort'),
      }));
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
      const models = await discoverCopilotModels();
      const selected = models.find(model => model.id === modelId);
      if (!selected) notFound('MODEL_NOT_FOUND', 'Model is not available for the signed-in Copilot account');

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
      res.json({ provider: 'copilot', selectedModelId: selected.id, models } satisfies ModelProviderSettings);
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

  router.post('/:id/health-check', (req, res) => {
    try {
      const model = getModel(req.params.id);
      if (!model) notFound('MODEL_NOT_FOUND', 'Model not found');
      const actor = actorFromRequest(req);
      const checked = recordModelHealth({
        modelId: req.params.id,
        status: model.enabled ? 'healthy' : 'disabled',
        latencyMs: 0,
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
