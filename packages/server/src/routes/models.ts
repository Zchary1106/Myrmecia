import { Router } from 'express';
import { z } from 'zod';
import { createOperatorAction } from '../db/models/operator-action.js';
import { actorFromRequest, HttpError, notFound, parseBody, parseQuery, requireOperatorRole, sendError } from './http.js';
import { getModel, listModelRoutes, listModels, recordModelHealth, updateModel, upsertModelRoute } from '../models/model-registry.js';

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
