import { Router } from 'express';
import { agentBudgetState, saveAgentBudget, saveAgentBudgetSchema } from '../agents/agent-budget.js';
import { workspaceIdFromRequest } from '../auth/tenant.js';
import { parseBody, requireOperatorRole, sendError } from './http.js';
import { createOperatorAction } from '../db/models/operator-action.js';
export function createAgentBudgetRoutes(): Router {
  const router = Router({ mergeParams: true });
  router.use((req, res, next) => {
    try {
      res.locals.actor = requireOperatorRole(req, 'agent.budget', ['admin', 'operator']);
      res.locals.agentId = String((req.params as Record<string, string>).id);
      res.locals.workspaceId = workspaceIdFromRequest(req) || 'default';
      res.setHeader('Cache-Control', 'no-store'); next();
    } catch (error) { sendError(res, error); }
  });
  router.get('/', (req, res) => {
    try { res.json(agentBudgetState(res.locals.agentId, res.locals.workspaceId)); } catch (error) { sendError(res, error); }
  });
  router.put('/', (req, res) => {
    try {
      const input = parseBody(saveAgentBudgetSchema, req);
      const state = saveAgentBudget(res.locals.agentId, res.locals.workspaceId, input.expectedRevision, input.limits);
      createOperatorAction({ actor: res.locals.actor, action: 'agent.budget.save', targetType: 'agent',
        targetId: res.locals.agentId, metadata: { revision: state.revision, limits: state.limits } });
      res.json(state);
    } catch (error) { sendError(res, error); }
  });
  return router;
}
