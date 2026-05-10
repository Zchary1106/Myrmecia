import { Router } from 'express';
import { z } from 'zod';
import { listPipelines, getPipeline } from '../db/models/pipeline.js';
import { PipelineEngine } from '../pipelines/pipeline-engine.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { notFound, parseBody, parseQuery, requireConfirmation, requireOperatorRole, sendError } from './http.js';

const pipelineStatusSchema = z.enum(['running', 'paused', 'blocked', 'done', 'failed']);
const createPipelineSchema = z.object({
  name: z.string().trim().min(1),
  templateId: z.string().trim().min(1),
  input: z.string().trim().min(1),
  gateMode: z.enum(['auto', 'manual']).optional(),
});
const listPipelinesQuerySchema = z.object({
  status: pipelineStatusSchema.optional(),
});

export function createPipelineRoutes(pipelineEngine: PipelineEngine): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'pipeline.create', ['admin', 'operator']);
      const { name, templateId, input, gateMode } = parseBody(createPipelineSchema, req);
      const pipeline = await pipelineEngine.create({ name, templateId, input, gateMode });
      createOperatorAction({
        action: 'pipeline.create',
        actor,
        targetType: 'pipeline',
        targetId: pipeline.id,
        pipelineId: pipeline.id,
        metadata: { templateId: pipeline.templateId, gateMode: pipeline.gateMode },
      });
      res.status(201).json(pipeline);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/', (req, res) => {
    try {
      const { status } = parseQuery(listPipelinesQuerySchema, req);
      res.json(listPipelines({ status }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id', (req, res) => {
    try {
      const pipeline = getPipeline(req.params.id);
      if (!pipeline) notFound('PIPELINE_NOT_FOUND', 'Pipeline not found');
      res.json(pipeline);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/approve', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'pipeline.approve', ['admin', 'operator']);
      await pipelineEngine.approveGate(req.params.id);
      createOperatorAction({
        action: 'pipeline.approve',
        actor,
        targetType: 'pipeline',
        targetId: req.params.id,
        pipelineId: req.params.id,
      });
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/skip', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'pipeline.skip', ['admin', 'operator']);
      await pipelineEngine.skipStage(req.params.id);
      createOperatorAction({
        action: 'pipeline.skip',
        actor,
        targetType: 'pipeline',
        targetId: req.params.id,
        pipelineId: req.params.id,
      });
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/cancel', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'pipeline.cancel', ['admin', 'operator']);
      requireConfirmation(req, 'pipeline.cancel');
      const pipeline = getPipeline(req.params.id);
      await pipelineEngine.cancel(req.params.id);
      createOperatorAction({
        action: 'pipeline.cancel',
        actor,
        targetType: 'pipeline',
        targetId: req.params.id,
        pipelineId: req.params.id,
        metadata: { previousStatus: pipeline?.status },
      });
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
