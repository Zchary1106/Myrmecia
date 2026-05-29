import { Router } from 'express';
import { z } from 'zod';
import { listPipelines, getPipeline } from '../db/models/pipeline.js';
import { PipelineEngine } from '../pipelines/pipeline-engine.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { notFound, parseBody, parseQuery, requireConfirmation, requireOperatorRole, sendError } from './http.js';
import { requestCanAccessWorkspace, workspaceIdFromRequest } from '../auth/tenant.js';
import type { Pipeline } from '../types.js';

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

function getAccessiblePipeline(req: any, pipelineId: string): Pipeline {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline || !requestCanAccessWorkspace(req, pipeline.workspaceId)) {
    notFound('PIPELINE_NOT_FOUND', 'Pipeline not found');
  }
  return pipeline;
}

function assertPipelineAccess(req: any, pipelineId: string): Pipeline | undefined {
  if (!workspaceIdFromRequest(req)) return getPipeline(pipelineId);
  return getAccessiblePipeline(req, pipelineId);
}

export function createPipelineRoutes(pipelineEngine: PipelineEngine): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'pipeline.create', ['admin', 'operator']);
      const { name, templateId, input, gateMode } = parseBody(createPipelineSchema, req);
      const pipeline = await pipelineEngine.create({ name, templateId, input, gateMode, workspaceId: workspaceIdFromRequest(req) });
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
      res.json(listPipelines({ status, workspaceId: workspaceIdFromRequest(req) }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id', (req, res) => {
    try {
      const pipeline = getAccessiblePipeline(req, req.params.id);
      res.json(pipeline);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/approve', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'pipeline.approve', ['admin', 'operator']);
      assertPipelineAccess(req, req.params.id);
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
      assertPipelineAccess(req, req.params.id);
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
      const pipeline = assertPipelineAccess(req, req.params.id);
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

  router.post('/:id/resume', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'pipeline.resume', ['admin', 'operator']);
      assertPipelineAccess(req, req.params.id);
      const pipeline = await pipelineEngine.resume(req.params.id);
      createOperatorAction({
        action: 'pipeline.resume',
        actor,
        targetType: 'pipeline',
        targetId: req.params.id,
        pipelineId: req.params.id,
        metadata: { stageCount: pipeline.stages.length },
      });
      res.json(pipeline);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/stages/:index/retry', async (req, res) => {
    try {
      const stageIndex = parseInt(req.params.index, 10);
      assertPipelineAccess(req, req.params.id);
      await pipelineEngine.retryStage(req.params.id, stageIndex);
      res.json({ success: true, message: `Stage ${stageIndex} retry initiated` });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
