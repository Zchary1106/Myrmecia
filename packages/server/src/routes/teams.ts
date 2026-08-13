import { Router } from 'express';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { listTeams, getTeam, resolveTeamAgents, suggestTeam, createTeam, updateTeam, deleteTeam } from '../agents/team-registry.js';
import type { TeamCoordinator } from '../agents/team-coordinator.js';
import { HttpError, notFound, parseBody, sendError } from './http.js';
import { requestCanAccessWorkspace, workspaceIdFromRequest } from '../auth/tenant.js';
import { workflowGraphContractSchema } from '../contracts/team-composer-contracts.js';
import {
  archiveTeamTemplateVersion,
  createTeamTemplateVersion,
  getPublishedTeamTemplate,
  getTeamTemplateVersion,
  listTeamTemplateVersions,
  publishTeamTemplateVersion,
} from '../db/models/team-template-version.js';
import { createGraphWorkflow } from '../agents/graph-workflow.js';

const dispatchSchema = z.object({
  goal: z.string().trim().min(1, 'goal is required'),
  workspaceId: z.string().trim().optional(),
  workdir: z.string().trim().min(1).max(16_384).optional(),
});

function validateWorkdir(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!isAbsolute(value)) throw new HttpError(400, 'INVALID_WORKDIR', 'Workspace path must be absolute');
  const workdir = resolve(value);
  if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
    throw new HttpError(400, 'INVALID_WORKDIR', 'Workspace directory does not exist');
  }
  return workdir;
}

const messageSchema = z.object({
  to: z.string().trim().min(1, 'to is required'),       // taskId | agentId | role | 'all'
  content: z.string().trim().min(1, 'content is required'),
  redirect: z.boolean().optional(),
});

const teamSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(1, 'name is required'),
  emoji: z.string().trim().optional(),
  lead: z.string().trim().optional(),
  members: z.array(z.string().trim().min(1)).min(1, 'at least one member role'),
  template: z.string().trim().optional(),
  triggers: z.array(z.string().trim()).optional(),
  blurb: z.string().trim().optional(),
});
const teamPatchSchema = teamSchema.partial().refine(d => Object.keys(d).length > 0, { message: 'no fields to update' });
const teamTemplateVersionSchema = z.object({
  graph: workflowGraphContractSchema,
  changeNote: z.string().trim().max(2_000).optional(),
});
const instantiateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  input: z.string().optional(),
  versionId: z.string().trim().min(1).optional(),
});

export function createTeamRoutes(coordinator: TeamCoordinator): Router {
  const router = Router();
  const ws = (req: any): string => workspaceIdFromRequest(req) || 'default';

  // GET /teams — list all teams with their resolved roster
  router.get('/', (req, res) => {
    res.json({ teams: listTeams(ws(req)).map(t => ({ ...t, roster: resolveTeamAgents(t) })) });
  });

  // POST /teams — create a custom team
  router.post('/', (req, res) => {
    try {
      const body = parseBody(teamSchema, req);
      const team = createTeam(body, ws(req));
      res.status(201).json({ ...team, roster: resolveTeamAgents(team) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /teams/suggest?goal=... — keyword hint for a free-text goal
  router.get('/suggest', (req, res) => {
    const team = suggestTeam(String(req.query.goal || ''), ws(req));
    res.json({ team: team ? team.id : null, name: team?.name || null });
  });

  // GET /teams/runs — recent runs (optionally ?teamId=)
  router.get('/runs', (req, res) => {
    const teamId = req.query.teamId ? String(req.query.teamId) : undefined;
    res.json({ runs: coordinator.listRuns(teamId, ws(req)) });
  });

  // GET /teams/runs/:runId — a run + its shared task board
  router.get('/runs/:runId', (req, res) => {
    try {
      const run = coordinator.getRun(req.params.runId);
      if (!run || !requestCanAccessWorkspace(req, run.workspaceId)) notFound('TEAM_RUN_NOT_FOUND', 'Team run not found');
      res.json({ run, board: coordinator.board(run!.id) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /teams/runs/:runId/message — message or redirect a teammate
  router.post('/runs/:runId/message', async (req, res) => {
    try {
      const run = coordinator.getRun(req.params.runId);
      if (!run || !requestCanAccessWorkspace(req, run.workspaceId)) notFound('TEAM_RUN_NOT_FOUND', 'Team run not found');
      const body = parseBody(messageSchema, req);
      const result = await coordinator.messageTeammate(run!.id, body.to, body.content, { redirect: body.redirect });
      res.status(202).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /teams/:id/versions — immutable workflow template history
  router.get('/:id/versions', (req, res) => {
    try {
      const team = getTeam(req.params.id, ws(req));
      if (!team) notFound('TEAM_NOT_FOUND', 'Team not found');
      res.json({
        versions: listTeamTemplateVersions(team!.id, ws(req)),
        published: getPublishedTeamTemplate(team!.id, ws(req)) || null,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /teams/:id/versions — create a new draft; published versions remain immutable
  router.post('/:id/versions', (req, res) => {
    try {
      const team = getTeam(req.params.id, ws(req));
      if (!team) notFound('TEAM_NOT_FOUND', 'Team not found');
      const body = parseBody(teamTemplateVersionSchema, req);
      const created = createTeamTemplateVersion({
        teamId: team!.id,
        workspaceId: ws(req),
        graph: body.graph,
        changeNote: body.changeNote,
        createdBy: String(req.headers['x-operator-id'] || req.headers['x-user-id'] || 'user'),
      });
      res.status(201).json(created);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/versions/:versionId/publish', (req, res) => {
    try {
      const team = getTeam(req.params.id, ws(req));
      if (!team) notFound('TEAM_NOT_FOUND', 'Team not found');
      const version = getTeamTemplateVersion(req.params.versionId, ws(req));
      if (!version || version.teamId !== team!.id) notFound('TEAM_TEMPLATE_NOT_FOUND', 'Team template version not found');
      res.json(publishTeamTemplateVersion(version!.id, ws(req)));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/versions/:versionId/archive', (req, res) => {
    try {
      const team = getTeam(req.params.id, ws(req));
      if (!team) notFound('TEAM_NOT_FOUND', 'Team not found');
      const version = getTeamTemplateVersion(req.params.versionId, ws(req));
      if (!version || version.teamId !== team!.id) notFound('TEAM_TEMPLATE_NOT_FOUND', 'Team template version not found');
      res.json(archiveTeamTemplateVersion(version!.id, ws(req)));
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /teams/:id/instantiate — create an executable graph from a published version
  router.post('/:id/instantiate', (req, res) => {
    try {
      const team = getTeam(req.params.id, ws(req));
      if (!team) notFound('TEAM_NOT_FOUND', 'Team not found');
      const body = parseBody(instantiateTemplateSchema, req);
      const version = body.versionId
        ? getTeamTemplateVersion(body.versionId, ws(req))
        : getPublishedTeamTemplate(team!.id, ws(req));
      if (!version || version.teamId !== team!.id) {
        notFound('TEAM_TEMPLATE_NOT_FOUND', 'Published team template version not found');
      }
      if (!body.versionId && version!.status !== 'published') {
        throw new HttpError(409, 'TEAM_TEMPLATE_NOT_PUBLISHED', 'Team template must be published before instantiation');
      }
      const workflow = createGraphWorkflow({
        name: body.name || `${team!.name} v${version!.version}`,
        description: `Instantiated from team ${team!.id} template v${version!.version}`,
        workspaceId: ws(req),
        graph: version!.graph,
        input: body.input,
      });
      res.status(201).json({ workflow, teamTemplateVersion: version });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /teams/:id — one team
  router.get('/:id', (req, res) => {
    try {
      const team = getTeam(req.params.id, ws(req));
      if (!team) notFound('TEAM_NOT_FOUND', 'Team not found');
      res.json({
        ...team!,
        roster: resolveTeamAgents(team!),
        publishedTemplate: getPublishedTeamTemplate(team!.id, ws(req)) || null,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // PATCH /teams/:id — edit a team (built-ins are materialized as a custom override)
  router.patch('/:id', (req, res) => {
    try {
      const team = getTeam(req.params.id, ws(req));
      if (!team) notFound('TEAM_NOT_FOUND', 'Team not found');
      const body = parseBody(teamPatchSchema, req);
      const updated = updateTeam(req.params.id, body, ws(req));
      res.json({ ...updated, roster: resolveTeamAgents(updated) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // DELETE /teams/:id — delete a custom team (or revert a built-in override)
  router.delete('/:id', (req, res) => {
    try {
      const result = deleteTeam(req.params.id, ws(req));
      res.json({ ok: true, ...result });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /teams/:id/dispatch — put the team to work on a goal (parallel board)
  router.post('/:id/dispatch', async (req, res) => {
    try {
      const team = getTeam(req.params.id, ws(req));
      if (!team) notFound('TEAM_NOT_FOUND', 'Team not found');
      const body = parseBody(dispatchSchema, req);
      const result = await coordinator.dispatch(team!.id, body.goal, ws(req), validateWorkdir(body.workdir));
      res.status(201).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
