import { Router } from 'express';
import { z } from 'zod';
import { listTeams, getTeam, resolveTeamAgents, suggestTeam, createTeam, updateTeam, deleteTeam } from '../agents/team-registry.js';
import type { TeamCoordinator } from '../agents/team-coordinator.js';
import { notFound, parseBody, sendError } from './http.js';

const dispatchSchema = z.object({
  goal: z.string().trim().min(1, 'goal is required'),
  workspaceId: z.string().trim().optional(),
});

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

export function createTeamRoutes(coordinator: TeamCoordinator): Router {
  const router = Router();

  // GET /teams — list all teams with their resolved roster
  router.get('/', (_req, res) => {
    res.json({ teams: listTeams().map(t => ({ ...t, roster: resolveTeamAgents(t) })) });
  });

  // POST /teams — create a custom team
  router.post('/', (req, res) => {
    try {
      const body = parseBody(teamSchema, req);
      const team = createTeam(body);
      res.status(201).json({ ...team, roster: resolveTeamAgents(team) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /teams/suggest?goal=... — keyword hint for a free-text goal
  router.get('/suggest', (req, res) => {
    const team = suggestTeam(String(req.query.goal || ''));
    res.json({ team: team ? team.id : null, name: team?.name || null });
  });

  // GET /teams/runs — recent runs (optionally ?teamId=)
  router.get('/runs', (req, res) => {
    const teamId = req.query.teamId ? String(req.query.teamId) : undefined;
    res.json({ runs: coordinator.listRuns(teamId) });
  });

  // GET /teams/runs/:runId — a run + its shared task board
  router.get('/runs/:runId', (req, res) => {
    try {
      const run = coordinator.getRun(req.params.runId);
      if (!run) notFound('TEAM_RUN_NOT_FOUND', 'Team run not found');
      res.json({ run, board: coordinator.board(run!.id) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /teams/runs/:runId/message — message or redirect a teammate
  router.post('/runs/:runId/message', async (req, res) => {
    try {
      const run = coordinator.getRun(req.params.runId);
      if (!run) notFound('TEAM_RUN_NOT_FOUND', 'Team run not found');
      const body = parseBody(messageSchema, req);
      const result = await coordinator.messageTeammate(run!.id, body.to, body.content, { redirect: body.redirect });
      res.status(202).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /teams/:id — one team
  router.get('/:id', (req, res) => {
    try {
      const team = getTeam(req.params.id);
      if (!team) notFound('TEAM_NOT_FOUND', 'Team not found');
      res.json({ ...team!, roster: resolveTeamAgents(team!) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // PATCH /teams/:id — edit a team (built-ins are materialized as a custom override)
  router.patch('/:id', (req, res) => {
    try {
      const team = getTeam(req.params.id);
      if (!team) notFound('TEAM_NOT_FOUND', 'Team not found');
      const body = parseBody(teamPatchSchema, req);
      const updated = updateTeam(req.params.id, body);
      res.json({ ...updated, roster: resolveTeamAgents(updated) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // DELETE /teams/:id — delete a custom team (or revert a built-in override)
  router.delete('/:id', (req, res) => {
    try {
      const result = deleteTeam(req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /teams/:id/dispatch — put the team to work on a goal (parallel board)
  router.post('/:id/dispatch', async (req, res) => {
    try {
      const team = getTeam(req.params.id);
      if (!team) notFound('TEAM_NOT_FOUND', 'Team not found');
      const body = parseBody(dispatchSchema, req);
      const result = await coordinator.dispatch(team!.id, body.goal, body.workspaceId || 'default');
      res.status(201).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
