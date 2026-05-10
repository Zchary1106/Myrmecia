import { Router } from 'express';
import { z } from 'zod';
import { createOperatorAction } from '../db/models/operator-action.js';
import { getAgent } from '../db/models/agent.js';
import { eventBus } from '../events/event-bus.js';
import { HttpError, notFound, parseBody, parseQuery, requireOperatorRole, sendError } from './http.js';
import { getTool, listTools, listToolPermissions, setToolPermission, updateToolPolicy } from '../tools/tool-registry.js';
import { listToolExecutions } from '../tools/tool-execution.js';

const toolExecutionStatusSchema = z.enum(['running', 'done', 'failed', 'blocked']);

const listToolsQuerySchema = z.object({
  enabled: z.enum(['true', 'false']).optional(),
  category: z.string().trim().min(1).optional(),
});

const updateToolSchema = z.object({
  enabled: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field must be provided' });

const permissionSchema = z.object({
  enabled: z.boolean(),
  approvalRequired: z.boolean().optional(),
});

const executionsQuerySchema = z.object({
  toolId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  executionId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  status: toolExecutionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function createToolRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    try {
      const query = parseQuery(listToolsQuerySchema, req);
      res.json(listTools({
        enabled: query.enabled === undefined ? undefined : query.enabled === 'true',
        category: query.category,
      }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/executions', (req, res) => {
    try {
      res.json(listToolExecutions(parseQuery(executionsQuerySchema, req)));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id', (req, res) => {
    try {
      const tool = getTool(req.params.id);
      if (!tool) notFound('TOOL_NOT_FOUND', 'Tool not found');
      res.json({
        ...tool,
        permissions: listToolPermissions({ toolId: req.params.id }),
        recentExecutions: listToolExecutions({ toolId: req.params.id, limit: 20 }),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.patch('/:id', (req, res) => {
    try {
      const existing = getTool(req.params.id);
      if (!existing) notFound('TOOL_NOT_FOUND', 'Tool not found');
      const actor = requireOperatorRole(req, 'tool.update', ['admin', 'operator']);
      const updates = parseBody(updateToolSchema, req);
      const tool = updateToolPolicy(req.params.id, updates);
      if (!tool) throw new HttpError(404, 'TOOL_NOT_FOUND', 'Tool not found');

      createOperatorAction({
        action: 'tool.update',
        actor,
        targetType: 'tool',
        targetId: req.params.id,
        metadata: {
          previous: { enabled: existing.enabled, approvalRequired: existing.approvalRequired },
          next: { enabled: tool.enabled, approvalRequired: tool.approvalRequired },
        },
      });
      eventBus.emit('tool:updated', {
        toolId: req.params.id,
        policy: { enabled: tool.enabled, approvalRequired: tool.approvalRequired },
      });
      res.json(tool);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id/executions', (req, res) => {
    try {
      if (!getTool(req.params.id)) notFound('TOOL_NOT_FOUND', 'Tool not found');
      const query = parseQuery(executionsQuerySchema.omit({ toolId: true }), req);
      res.json(listToolExecutions({ ...query, toolId: req.params.id }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/:id/permissions/:agentId', (req, res) => {
    try {
      const tool = getTool(req.params.id);
      if (!tool) notFound('TOOL_NOT_FOUND', 'Tool not found');
      const agent = getAgent(req.params.agentId);
      if (!agent) notFound('AGENT_NOT_FOUND', 'Agent not found');
      const actor = requireOperatorRole(req, 'tool.permission.update', ['admin', 'operator']);
      const body = parseBody(permissionSchema, req);
      const permission = setToolPermission({
        toolId: req.params.id,
        agentId: req.params.agentId,
        enabled: body.enabled,
        approvalRequired: body.approvalRequired,
      });
      createOperatorAction({
        action: 'tool.permission.update',
        actor,
        targetType: 'tool',
        targetId: req.params.id,
        metadata: { agentId: req.params.agentId, enabled: permission.enabled, approvalRequired: permission.approvalRequired },
      });
      res.json(permission);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
