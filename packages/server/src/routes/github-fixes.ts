import { Router } from 'express';
import { z } from 'zod';
import { createOperatorAction } from '../db/models/operator-action.js';
import { GitHubFixService } from '../github/github-fix-service.js';
import {
  notFound,
  parseBody,
  requireConfirmation,
  requireOperatorRole,
  sendError,
} from './http.js';
import { requestCanAccessWorkspace, workspaceIdFromRequest } from '../auth/tenant.js';

const createSchema = z.object({
  repository: z.string().trim().min(3).max(500),
  issue: z.string().trim().max(500).optional(),
  bugDescription: z.string().trim().max(20_000).optional(),
  baseBranch: z.string().trim().max(200).optional(),
  sparsePaths: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  teamId: z.string().trim().min(1).max(100).optional(),
}).refine(data => Boolean(data.issue || data.bugDescription), {
  message: 'Provide an issue or bug description',
});

const pullRequestSchema = z.object({
  confirm: z.literal(true),
  title: z.string().trim().min(1).max(240).optional(),
  body: z.string().trim().min(1).max(40_000).optional(),
  commitMessage: z.string().trim().min(1).max(300).optional(),
});

export function createGitHubFixRoutes(service: GitHubFixService): Router {
  const router = Router();

  const accessibleRun = (req: any, id: string) => {
    const run = service.get(id);
    if (!run || !requestCanAccessWorkspace(req, run.workspaceId)) {
      notFound('GITHUB_FIX_NOT_FOUND', 'GitHub fix run not found');
    }
    return run;
  };

  router.get('/status', async (_req, res) => {
    res.json(await service.connectionStatus());
  });

  router.get('/', (req, res) => {
    res.json(service.list(workspaceIdFromRequest(req) || 'default'));
  });

  router.post('/', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'github.fix.create', ['admin', 'operator']);
      const body = parseBody(createSchema, req);
      const run = await service.create({ ...body, workspaceId: workspaceIdFromRequest(req) || 'default' });
      createOperatorAction({
        action: 'github.fix.create',
        actor,
        targetType: 'system',
        targetId: run.id,
        taskId: run.taskId,
        metadata: {
          repository: run.repository,
          issueNumber: run.issueNumber,
          baseBranch: run.baseBranch,
          workBranch: run.workBranch,
        },
      });
      res.status(201).json(run);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:id', (req, res) => {
    try {
      accessibleRun(req, req.params.id);
      res.json(service.get(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:id/diff', async (req, res) => {
    try {
      accessibleRun(req, req.params.id);
      res.json(await service.diff(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/pull-request', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'github.fix.pull_request', ['admin', 'operator']);
      accessibleRun(req, req.params.id);
      requireConfirmation(req, 'github.fix.pull_request');
      const body = parseBody(pullRequestSchema, req);
      const run = await service.createPullRequest(req.params.id, body);
      createOperatorAction({
        action: 'github.fix.pull_request',
        actor,
        targetType: 'system',
        targetId: run.id,
        taskId: run.taskId,
        metadata: {
          repository: run.repository,
          workBranch: run.workBranch,
          forkRepository: run.forkRepository,
          prUrl: run.prUrl,
        },
      });
      res.json(run);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
