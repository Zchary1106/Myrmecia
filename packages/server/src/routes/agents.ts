import { Router } from 'express';
import { z } from 'zod';
import { listAgents, getAgent, createAgent, updateAgent } from '../db/models/agent.js';
import { listExecutions, getActiveExecutionCount } from '../db/models/execution.js';
import { agentRuntime } from '../agents/agent-runtime.js';
import { forkExecutor } from '../agents/fork-executor.js';
import { createTask, getTask } from '../db/models/task.js';
import type { AgentDefinition } from '../types.js';
import type { TaskQueue } from '../queue/task-queue.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { eventBus } from '../events/event-bus.js';
import { HttpError, notFound, parseBody, requireOperatorRole, sendError } from './http.js';

const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
const stringListSchema = z.array(z.string().trim().min(1));
const agentConfigSchema = z.object({
  model: z.string().trim().min(1).optional(),
  maxConcurrent: z.number().int().min(1).optional(),
  timeout: z.number().int().min(1).optional(),
  workdir: z.string().trim().min(1).optional(),
  maxTurns: z.number().int().min(1).optional(),
  allowedTools: stringListSchema.optional(),
}).passthrough();

const createAgentSchema = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  emoji: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  whenToUse: z.string().optional(),
  skillPath: z.string().optional(),
  config: agentConfigSchema.optional(),
  capabilities: stringListSchema.optional(),
  triggers: stringListSchema.optional(),
  allowedTools: stringListSchema.optional(),
  disallowedTools: stringListSchema.optional(),
  model: z.string().trim().min(1).optional(),
  maxTurns: z.number().int().min(1).optional(),
});

const updateAgentSchema = createAgentSchema.partial()
  .refine(data => Object.keys(data).length > 0, { message: 'At least one field must be provided' });

const executeAgentSchema = z.object({
  prompt: z.string().trim().min(1),
  workdir: z.string().trim().min(1).optional(),
  priority: prioritySchema.optional(),
  parentExecutionId: z.string().trim().min(1).optional(),
});

function agentAuditSnapshot(agent: AgentDefinition) {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    whenToUse: agent.whenToUse,
    skillPath: agent.skillPath,
    capabilities: agent.capabilities,
    triggers: agent.triggers,
    allowedTools: agent.allowedTools || agent.config.allowedTools || [],
    disallowedTools: agent.disallowedTools || [],
    model: agent.model || agent.config.model,
    maxTurns: agent.maxTurns || agent.config.maxTurns,
    timeout: agent.config.timeout,
  };
}

export function createAgentRoutes(taskQueue?: TaskQueue): Router {
  const router = Router();

  // GET /api/agents — list agent definitions (capability templates)
  router.get('/', (req, res) => {
    const { role } = req.query;
    const agents = listAgents({ role: role as string });

    // Enrich with runtime info (active execution count)
    const enriched = agents.map(agent => ({
      ...agent,
      activeExecutions: getActiveExecutionCount(agent.id),
    }));

    res.json(enriched);
  });

  // GET /api/agents/:id — single agent definition
  router.get('/:id', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });
    res.json({
      ...agent,
      activeExecutions: getActiveExecutionCount(agent.id),
    });
  });

  // POST /api/agents — register a new agent definition
  router.post('/', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'agent.create', ['admin', 'operator']);
      const body = parseBody(createAgentSchema, req);
      const agent = createAgent(body);
      createOperatorAction({
        action: 'agent.create',
        actor,
        targetType: 'agent',
        targetId: agent.id,
        metadata: { next: agentAuditSnapshot(agent) },
      });
      eventBus.emit('agent:status', { agentId: agent.id, agent });
      res.status(201).json(agent);
    } catch (err) {
      sendError(res, err);
    }
  });

  // PATCH /api/agents/:id — update agent definition
  router.patch('/:id', (req, res) => {
    try {
      const agent = getAgent(req.params.id);
      if (!agent) notFound('AGENT_NOT_FOUND', 'Agent not found');
      const actor = requireOperatorRole(req, 'agent.update', ['admin', 'operator']);
      const updated = updateAgent(req.params.id, parseBody(updateAgentSchema, req));
      if (!updated) throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent not found');
      createOperatorAction({
        action: 'agent.update',
        actor,
        targetType: 'agent',
        targetId: req.params.id,
        metadata: {
          previous: agentAuditSnapshot(agent),
          next: agentAuditSnapshot(updated),
        },
      });
      eventBus.emit('agent:status', { agentId: updated.id, agent: updated });
      res.json(updated);
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/agents/:id/execute — create a new execution (async, returns immediately)
  router.post('/:id/execute', async (req, res) => {
    try {
      const agent = getAgent(req.params.id);
      if (!agent) notFound('AGENT_NOT_FOUND', 'Agent not found');
      const actor = requireOperatorRole(req, 'agent.execute', ['admin', 'operator']);

      const { prompt, workdir, priority, parentExecutionId } = parseBody(executeAgentSchema, req);

      // Check concurrency limit
      const activeCount = getActiveExecutionCount(agent.id);
      const maxConcurrent = agent.config.maxConcurrent || 1;
      if (activeCount >= maxConcurrent) {
        throw new HttpError(429, 'AGENT_CONCURRENCY_LIMIT', `Agent ${agent.name} is at max concurrency (${maxConcurrent})`);
      }

      let taskId: string;
      if (parentExecutionId) {
        // Fork mode: still async but we fire-and-forget
        const task = await (taskQueue
          ? taskQueue.enqueue({
              title: prompt.slice(0, 80),
              description: prompt,
              mode: 'direct',
              priority: priority || 'normal',
              assigneeId: agent.id,
              input: prompt,
              parentTaskId: parentExecutionId,
              workdir,
            })
          : Promise.resolve(createTask({
              title: prompt.slice(0, 80),
              description: prompt,
              mode: 'direct' as any,
              priority: priority || 'normal',
              assigneeId: agent.id,
              input: prompt,
              workdir,
              createdBy: 'user',
            }))
        );

        // Fire-and-forget if no queue (queue handles execution internally)
        if (!taskQueue) {
          forkExecutor.fork(parentExecutionId, prompt, agent.id).catch(err => {
            console.error(`[execute] Fork failed for ${agent.id}:`, err.message);
          });
        }

        taskId = task.id;
      } else {
        // Spawn mode: enqueue to task queue (returns immediately)
        if (taskQueue) {
          const task = await taskQueue.enqueue({
            title: prompt.slice(0, 80),
            description: prompt,
            mode: 'direct',
            priority: priority || 'normal',
            assigneeId: agent.id,
            input: prompt,
              workdir,
          });
          taskId = task.id;
        } else {
          // No queue: create task and fire-and-forget
          const task = createTask({
            title: prompt.slice(0, 80),
            description: prompt,
            mode: 'direct' as any,
            priority: priority || 'normal',
            assigneeId: agent.id,
            input: prompt,
            workdir,
            createdBy: 'user',
          });
          forkExecutor.spawn(agent.id, prompt, { workdir, priority }).catch(err => {
            console.error(`[execute] Spawn failed for ${agent.id}:`, err.message);
          });
          taskId = task.id;
        }
      }
      createOperatorAction({
        action: 'agent.execute',
        actor,
        targetType: 'agent',
        targetId: agent.id,
        taskId,
        metadata: { priority: priority || 'normal', parentExecutionId, promptChars: prompt.length },
      });
      res.json({ taskId, status: 'started' });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/agents/:id/executions — execution history for this agent
  router.get('/:id/executions', (req, res) => {
    const { status, limit } = req.query;
    const executions = listExecutions({
      agentDefId: req.params.id,
      status: status as any,
      limit: limit ? Number(limit) : 20,
    });
    res.json(executions);
  });

  // Legacy compatibility endpoints (no-op, agents are always "on")
  router.post('/:id/start', (_req, res) => res.json({ success: true, message: 'Agents are always available as capability templates' }));
  router.post('/:id/stop', (_req, res) => res.json({ success: true, message: 'Use execution cancel instead' }));

  return router;
}
