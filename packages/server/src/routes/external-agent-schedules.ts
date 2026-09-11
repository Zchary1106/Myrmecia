import { Router } from 'express';
import { z } from 'zod';
import type { ExternalAgentSchedule } from '@myrmecia/shared';
import { workspaceIdFromRequest } from '../auth/tenant.js';
import { getExternalAgent } from '../db/models/external-agent.js';
import {
  createExternalAgentSchedule,
  deleteExternalAgentSchedule,
  getExternalAgentSchedule,
  listExternalAgentSchedules,
  updateExternalAgentSchedule,
} from '../db/models/external-agent.js';
import { nextExternalAgentRunAt } from '../workers/external-agent-scheduler.js';
import { HttpError, parseBody, parseQuery, requireOperatorRole, sendError } from './http.js';

const invocationSchema = z.object({
  objective: z.string().trim().min(1).max(50_000),
  constraints: z.array(z.string().max(4_000)).max(100).default([]),
  workdir: z.string().max(4_000).optional(),
  provider: z.string().max(200).optional(),
  modelId: z.string().max(500).optional(),
  reasoningEffort: z.string().max(100).optional(),
  contextLength: z.number().int().positive().max(10_000_000).optional(),
  artifactIds: z.array(z.string().max(500)).max(100).optional(),
});

const createScheduleSchema = z.object({
  externalAgentId: z.string().min(1).max(500),
  triggerType: z.enum(['cron', 'once', 'webhook', 'task_event']),
  cron: z.string().trim().min(1).max(200).optional(),
  runAt: z.string().datetime().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  eventType: z.string().trim().min(1).max(200).optional(),
  invocation: invocationSchema,
});

const updateScheduleSchema = z.object({
  enabled: z.boolean().optional(),
  cron: z.string().trim().min(1).max(200).optional(),
  runAt: z.string().datetime().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  eventType: z.string().trim().min(1).max(200).optional(),
  invocation: invocationSchema.optional(),
});

const listQuerySchema = z.object({
  externalAgentId: z.string().min(1).optional(),
  enabled: z.coerce.boolean().optional(),
});

const taskEventTypes = new Set(['task:started', 'task:done', 'task:failed', 'task:cancelled']);

function invalidInput(message: string): never {
  throw new HttpError(400, 'INVALID_INPUT', message);
}

function workspace(req: any): string {
  return workspaceIdFromRequest(req) || 'default';
}

function scheduleNextRun(
  input: Pick<ExternalAgentSchedule, 'triggerType' | 'cron' | 'runAt' | 'timezone'>,
  now = new Date(),
): string | undefined {
  if (input.triggerType === 'once') {
    const date = input.runAt ? new Date(input.runAt) : undefined;
    if (!date || !Number.isFinite(date.getTime()) || date <= now) invalidInput('runAt must be a future ISO-8601 time.');
  }
  try {
    return nextExternalAgentRunAt(input, now);
  } catch (error) {
    invalidInput(error instanceof Error ? error.message : 'Invalid schedule configuration.');
  }
}

export function createExternalAgentScheduleRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    try {
      const query = parseQuery(listQuerySchema, req);
      res.json(listExternalAgentSchedules({ workspaceId: workspace(req), ...query }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/', (req, res) => {
    try {
      requireOperatorRole(req, 'external-agent.schedule.create', ['admin', 'operator']);
      const body = parseBody(createScheduleSchema, req);
      const workspaceId = workspace(req);
      if (!getExternalAgent(body.externalAgentId, workspaceId)) throw new HttpError(404, 'NOT_FOUND', 'External Agent not found in this workspace.');
      if (body.triggerType === 'cron' && !body.cron) invalidInput('cron is required for a cron schedule.');
      if (body.triggerType === 'once' && !body.runAt) invalidInput('runAt is required for a one-time schedule.');
      if (body.triggerType === 'webhook') invalidInput('Webhook triggers are not enabled yet. Use cron, once, or task_event.');
      if (body.triggerType === 'task_event' && !taskEventTypes.has(body.eventType || '')) {
        invalidInput('task_event requires eventType: task:started, task:done, task:failed, or task:cancelled.');
      }
      const nextRunAt = scheduleNextRun(body);
      const schedule = createExternalAgentSchedule({
        externalAgentId: body.externalAgentId,
        workspaceId,
        triggerType: body.triggerType,
        cron: body.cron,
        runAt: body.runAt,
        timezone: body.timezone,
        eventType: body.eventType,
        invocation: { ...body.invocation, constraints: body.invocation.constraints || [] },
        enabled: body.triggerType === 'task_event' ? true : Boolean(nextRunAt),
        nextRunAt,
      });
      res.status(201).json(schedule);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/:id', (req, res) => {
    try {
      requireOperatorRole(req, 'external-agent.schedule.update', ['admin', 'operator']);
      const workspaceId = workspace(req);
      const current = getExternalAgentSchedule(req.params.id, workspaceId);
      if (!current) return res.status(404).json({ error: { message: 'External Agent schedule not found.' } });
      const update = parseBody(updateScheduleSchema, req);
      const next = { ...current, ...update };
      const nextRunAt = update.enabled === false
        ? current.nextRunAt
        : (update.cron !== undefined || update.runAt !== undefined || update.timezone !== undefined || (update.enabled === true && !current.nextRunAt))
          ? scheduleNextRun(next)
          : current.nextRunAt;
      const { invocation: requestedInvocation, ...otherUpdates } = update;
      const schedule = updateExternalAgentSchedule(current.id, workspaceId, {
        ...otherUpdates,
        ...(requestedInvocation ? { invocation: { ...requestedInvocation, constraints: requestedInvocation.constraints || [] } } : {}),
        nextRunAt,
      });
      return res.json(schedule);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      requireOperatorRole(req, 'external-agent.schedule.delete', ['admin', 'operator']);
      if (!deleteExternalAgentSchedule(req.params.id, workspace(req))) return res.status(404).json({ error: { message: 'External Agent schedule not found.' } });
      return res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
