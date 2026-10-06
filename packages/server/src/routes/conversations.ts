import { Router } from 'express';
import { z } from 'zod';
import { workspaceIdFromRequest } from '../auth/tenant.js';
import { listConversationStates, manageConversations } from '../db/models/conversation.js';
import { parseBody, requireConfirmation, requireOperatorRole, sendError } from './http.js';
import { eventBus } from '../events/event-bus.js';
import { getPipeline } from '../db/models/pipeline.js';

const schema = z.object({
  taskIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  action: z.enum(['archive', 'restore', 'delete']),
  confirm: z.boolean().optional(),
  stopWorkflow: z.boolean().optional(),
});

export function createConversationRoutes(): Router {
  const router = Router();
  router.get('/', (req, res) => {
    try { res.json(listConversationStates(workspaceIdFromRequest(req))); }
    catch (error) { sendError(res, error); }
  });
  router.post('/manage', (req, res) => {
    try {
      const body = parseBody(schema, req);
      const actor = requireOperatorRole(req, `conversation.${body.action}`, body.action === 'delete' ? ['admin'] : ['admin', 'operator']);
      if (body.action === 'delete') requireConfirmation(req, 'conversation.delete');
      const result = manageConversations([...new Set(body.taskIds)], body.action, actor, workspaceIdFromRequest(req), { stopWorkflow: body.stopWorkflow });
      for (const pipelineId of result.stoppedPipelineIds) {
        eventBus.emit('pipeline:failed', { pipelineId, workspaceId: getPipeline(pipelineId)?.workspaceId, error: '用户确认结束流程并删除会话。' });
      }
      res.json(result);
    } catch (error) { sendError(res, error); }
  });
  return router;
}
