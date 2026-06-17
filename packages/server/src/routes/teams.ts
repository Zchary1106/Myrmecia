import { Router } from 'express';
import { z } from 'zod';
import { listTeams, getTeam, resolveTeamAgents, suggestTeam } from '../agents/team-registry.js';
import type { TeamCoordinator } from '../agents/team-coordinator.js';
import { notFound, parseBody, sendError } from './http.js';

const dispatchSchema = z.object({
  goal: z.string().trim().min(1, 'goal is required'),
  workspaceId: z.string().trim().optional(),
});

export function createTeamRoutes(coordinator: TeamCoordinator): Router {
  const router = Router();

  // GET /teams — list all teams with their resolved roster
  router.get('/', (_req, res) => {
    res.json({ teams: listTeams().map(t => ({ ...t, roster: resolveTeamAgents(t) })) });
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
