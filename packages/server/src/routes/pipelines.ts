import { Router } from 'express';
import { z } from 'zod';
import { existsSync, readdirSync, realpathSync, statSync } from 'fs';
import { basename, extname, relative, resolve } from 'path';
import { listPipelines, getPipeline } from '../db/models/pipeline.js';
import {
  PipelineEngine,
  PublishConfirmationRequiredError,
  PublishStageSkipForbiddenError,
} from '../pipelines/pipeline-engine.js';
import { workspaceManager } from '../workspace/workspace-manager.js';
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
  confirmAutonomousPublish: z.boolean().optional(),
  domainId: z.string().trim().min(1).optional(),
});
const listPipelinesQuerySchema = z.object({
  status: pipelineStatusSchema.optional(),
});
const approvePipelineSchema = z.object({
  confirmPublish: z.boolean().optional(),
  note: z.string().trim().max(2000).optional(),
}).default({});

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

function listFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files;
}

function resolvePipelineArtifact(pipelineId: string, requestedPath: string): string {
  const workspace = workspaceManager.getWorkspaceInfo(pipelineId, 'pipeline');
  if (!workspace) throw new Error('Pipeline workspace not found');
  const root = realpathSync(resolve(workspace.path));
  const artifactPath = resolve(root, requestedPath);
  const rel = relative(root, artifactPath);
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== artifactPath) {
    throw new Error('Artifact path is outside the pipeline workspace');
  }
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    throw new Error('Artifact not found');
  }
  const realArtifactPath = realpathSync(artifactPath);
  const realRel = relative(root, realArtifactPath);
  if (!realRel || realRel.startsWith('..')) {
    throw new Error('Artifact target is outside the pipeline workspace');
  }
  return realArtifactPath;
}

export function createPipelineRoutes(pipelineEngine: PipelineEngine): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'pipeline.create', ['admin', 'operator']);
      const { name, templateId, input, gateMode, confirmAutonomousPublish, domainId } = parseBody(createPipelineSchema, req);
      const pipeline = await pipelineEngine.create({
        name,
        templateId,
        input,
        gateMode,
        confirmAutonomousPublish,
        domainId,
        workspaceId: workspaceIdFromRequest(req),
      });
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

  router.get('/:id/artifacts', (req, res) => {
    try {
      getAccessiblePipeline(req, req.params.id);
      const workspace = workspaceManager.getWorkspaceInfo(req.params.id, 'pipeline');
      if (!workspace) return res.json([]);
      const files = listFiles(workspace.path)
        .filter(path => ['.png', '.jpg', '.jpeg', '.webp', '.md', '.json'].includes(extname(path).toLowerCase()))
        .map(path => ({
          id: path,
          name: basename(path),
          path,
          kind: ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(path).toLowerCase()) ? 'image' : 'document',
          url: `/api/v1/pipelines/${encodeURIComponent(req.params.id)}/artifacts/file?path=${encodeURIComponent(path)}`,
        }));
      res.json(files);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id/artifacts/file', (req, res) => {
    try {
      getAccessiblePipeline(req, req.params.id);
      const path = z.string().trim().min(1).parse(req.query.path);
      // Pipeline workspaces intentionally live below `.agent-factory`. The
      // resolver above already realpath-checks that the requested file stays
      // inside that workspace, so denying every hidden path segment blocks all
      // legitimate generated images.
      res.sendFile(resolvePipelineArtifact(req.params.id, path), { dotfiles: 'allow' });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/approve', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'pipeline.approve', ['admin', 'operator']);
      assertPipelineAccess(req, req.params.id);
      const { confirmPublish, note } = parseBody(approvePipelineSchema, req) ?? {};
      await pipelineEngine.approveGate(req.params.id, confirmPublish === true, actor, note);
      createOperatorAction({
        action: 'pipeline.approve',
        actor,
        targetType: 'pipeline',
        targetId: req.params.id,
        pipelineId: req.params.id,
      });
      res.json({ success: true });
    } catch (err) {
      if (err instanceof PublishConfirmationRequiredError) {
        return res.status(409).json({
          error: {
            code: 'PUBLISH_CONFIRMATION_REQUIRED',
            message: err.message,
            details: { required: { confirmPublish: true } },
          },
        });
      }
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
      if (err instanceof PublishStageSkipForbiddenError) {
        return res.status(409).json({
          error: {
            code: 'PUBLISH_STAGE_SKIP_FORBIDDEN',
            message: err.message,
          },
        });
      }
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
      const { confirmPublish } = parseBody(approvePipelineSchema, req) ?? {};
      const pipeline = await pipelineEngine.resume(req.params.id, confirmPublish === true);
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
      if (err instanceof PublishConfirmationRequiredError) {
        return res.status(409).json({
          error: {
            code: 'PUBLISH_CONFIRMATION_REQUIRED',
            message: err.message,
            details: { required: { confirmPublish: true } },
          },
        });
      }
      sendError(res, err);
    }
  });

  router.post('/:id/stages/:index/retry', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'pipeline.stage.retry', ['admin', 'operator']);
      const stageIndex = parseInt(req.params.index, 10);
      assertPipelineAccess(req, req.params.id);
      const { confirmPublish } = parseBody(approvePipelineSchema, req) ?? {};
      await pipelineEngine.retryStage(req.params.id, stageIndex, confirmPublish === true);
      createOperatorAction({
        action: 'pipeline.stage.retry',
        actor,
        targetType: 'pipeline',
        targetId: req.params.id,
        pipelineId: req.params.id,
        metadata: { stageIndex, confirmPublish: confirmPublish === true },
      });
      res.json({ success: true, message: `Stage ${stageIndex} retry initiated` });
    } catch (err) {
      if (err instanceof PublishConfirmationRequiredError) {
        return res.status(409).json({
          error: {
            code: 'PUBLISH_CONFIRMATION_REQUIRED',
            message: err.message,
            details: { required: { confirmPublish: true } },
          },
        });
      }
      sendError(res, err);
    }
  });

  router.post('/:id/stages/:index/rerun', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'pipeline.stage.rerun', ['admin', 'operator']);
      const stageIndex = parseInt(req.params.index, 10);
      assertPipelineAccess(req, req.params.id);
      await pipelineEngine.rerunStage(req.params.id, stageIndex);
      createOperatorAction({
        action: 'pipeline.stage.rerun',
        actor,
        targetType: 'pipeline',
        targetId: req.params.id,
        pipelineId: req.params.id,
        metadata: { stageIndex },
      });
      res.json({ success: true, message: `Stage ${stageIndex} re-run initiated` });
    } catch (err) {
      if (err instanceof PublishConfirmationRequiredError) {
        return res.status(409).json({
          error: { code: 'PUBLISH_CONFIRMATION_REQUIRED', message: err.message },
        });
      }
      sendError(res, err);
    }
  });

  return router;
}
