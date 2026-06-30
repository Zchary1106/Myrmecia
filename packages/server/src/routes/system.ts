import { Router } from 'express';
import { z } from 'zod';
import { listAgents } from '../db/models/agent.js';
import { getActiveExecutionCount } from '../db/models/execution.js';
import { listTasks } from '../db/models/task.js';
import { listPipelines } from '../db/models/pipeline.js';
import { listNotifications, markNotificationRead, markAllNotificationsRead } from '../db/models/notification.js';
import { createInboxEntry, getInboxEntry, listInboxEntries, respondToInboxEntry } from '../db/models/inbox.js';
import { createNotification } from '../db/models/notification.js';
import { listPlatformEvents } from '../db/models/platform-event.js';
import { listOperatorActions, createOperatorAction } from '../db/models/operator-action.js';
import {
  deleteOperatorPreference,
  getOperatorPreference,
  listOperatorPreferences,
  upsertOperatorPreference,
} from '../db/models/operator-preference.js';
import { eventBus } from '../events/event-bus.js';
import { actorFromRequest, HttpError, notFound, parseBody, parseQuery, requireConfirmation, requireOperatorRole, sendError } from './http.js';
import { requestCanAccessWorkspace, workspaceIdFromRequest } from '../auth/tenant.js';
import {
  buildObservabilitySummary,
  buildRuntimeDiagnostics,
  buildWorkspaceSnapshot,
  buildSnapshotPreview,
  buildRestorePlan,
  restorePreferencesFromSnapshot,
  snapshotFromBody,
  snapshotPreviewBodySchema,
  preferenceRestoreBodySchema,
  preferenceNameSchema,
} from './system-introspection.js';

const platformEventSeveritySchema = z.enum(['info', 'warn', 'error']);
const eventsQuerySchema = z.object({
  eventType: z.string().trim().min(1).optional(),
  severity: platformEventSeveritySchema.optional(),
  taskId: z.string().trim().min(1).optional(),
  pipelineId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const inboxStatusSchema = z.enum(['pending', 'approved', 'rejected', 'answered', 'cancelled']);
const inboxTypeSchema = z.enum(['approval', 'question', 'input', 'review']);
const inboxListQuerySchema = z.object({
  status: inboxStatusSchema.optional(),
  taskId: z.string().trim().min(1).optional(),
  pipelineId: z.string().trim().min(1).optional(),
  executionId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const createInboxSchema = z.object({
  type: inboxTypeSchema,
  title: z.string().trim().min(1),
  message: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).optional(),
  taskId: z.string().trim().min(1).optional(),
  pipelineId: z.string().trim().min(1).optional(),
  executionId: z.string().trim().min(1).optional(),
  createdBy: z.enum(['system', 'agent', 'user']).optional(),
});
const respondInboxSchema = z.object({
  status: z.enum(['approved', 'rejected', 'answered', 'cancelled']),
  response: z.string().optional(),
});
const operatorActionTargetSchema = z.enum(['task', 'pipeline', 'inbox', 'system', 'agent', 'tool', 'skill', 'model', 'template']);
const operatorActionsQuerySchema = z.object({
  action: z.string().trim().min(1).optional(),
  actorId: z.string().trim().min(1).optional(),
  targetType: operatorActionTargetSchema.optional(),
  taskId: z.string().trim().min(1).optional(),
  pipelineId: z.string().trim().min(1).optional(),
  inboxEntryId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const preferenceParamsSchema = z.object({
  namespace: preferenceNameSchema,
  key: preferenceNameSchema,
});
const preferenceListQuerySchema = z.object({
  namespace: preferenceNameSchema.optional(),
});
const preferenceBodySchema = z.object({
  value: z.unknown().refine(value => value !== undefined, 'Required'),
});

function parsePreferenceParams(params: unknown): z.infer<typeof preferenceParamsSchema> {
  const result = preferenceParamsSchema.safeParse(params);
  if (!result.success) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Preference parameters validation failed', result.error.issues);
  }
  return result.data;
}

export function createSystemRoutes(): Router {
  const router = Router();
  const ws = (req: any): string => workspaceIdFromRequest(req) || 'default';

  router.get('/health', (req, res) => {
    const workspaceId = ws(req);
    const agents = listAgents({ workspaceId });
    const tasks = listTasks({ workspaceId });
    const pipelines = listPipelines({ workspaceId });
    const activeAgents = agents.filter(a => getActiveExecutionCount(a.id) > 0).length;
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      agents: {
        total: agents.length,
        active: activeAgents,
        idle: agents.length - activeAgents,
      },
      tasks: {
        running: tasks.filter(t => t.status === 'running').length,
        queued: tasks.filter(t => t.status === 'queued' || t.status === 'pending').length,
      },
      pipelines: { active: pipelines.filter(p => p.status === 'running').length },
    });
  });

  router.get('/stats', (req, res) => {
    const tasks = listTasks({ workspaceId: ws(req) });
    res.json({
      totalTasks: tasks.length,
      completedTasks: tasks.filter(t => t.status === 'done').length,
      failedTasks: tasks.filter(t => t.status === 'failed').length,
      runningTasks: tasks.filter(t => t.status === 'running').length,
    });
  });

  router.get('/events', (req, res) => {
    try {
      const { eventType, severity, taskId, pipelineId, limit } = parseQuery(eventsQuerySchema, req);
      res.json(listPlatformEvents({
        eventType: eventType as any,
        severity,
        taskId,
        pipelineId,
        workspaceId: ws(req),
        limit,
      }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/observability', (req, res) => {
    res.json(buildObservabilitySummary(ws(req)));
  });

  router.get('/diagnostics', (req, res) => {
    res.json(buildRuntimeDiagnostics(req));
  });

  router.get('/workspace-snapshot', (req, res) => {
    res.json(buildWorkspaceSnapshot(req));
  });

  router.post('/workspace-snapshot/preview', (req, res) => {
    try {
      const body = parseBody(snapshotPreviewBodySchema, req);
      res.json(buildSnapshotPreview(snapshotFromBody(body)));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/workspace-snapshot/restore-plan', (req, res) => {
    try {
      const body = parseBody(snapshotPreviewBodySchema, req);
      res.json(buildRestorePlan(req, snapshotFromBody(body)));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/workspace-snapshot/restore-preferences', (req, res) => {
    try {
      requireConfirmation(req, 'workspace.restore.preferences');
      const { snapshot } = parseBody(preferenceRestoreBodySchema, req);
      res.json(restorePreferencesFromSnapshot(req, snapshot));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/operator-actions', (req, res) => {
    try {
      const { action, actorId, targetType, taskId, pipelineId, inboxEntryId, limit } = parseQuery(operatorActionsQuerySchema, req);
      res.json(listOperatorActions({ action, actorId, targetType, taskId, pipelineId, inboxEntryId, limit }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/operator-preferences', (req, res) => {
    try {
      const { namespace } = parseQuery(preferenceListQuerySchema, req);
      res.json(listOperatorPreferences(actorFromRequest(req), namespace));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/operator-preferences/:namespace/:key', (req, res) => {
    try {
      const { namespace, key } = parsePreferenceParams(req.params);
      const preference = getOperatorPreference(actorFromRequest(req), namespace, key);
      if (!preference) notFound('PREFERENCE_NOT_FOUND', 'Operator preference not found');
      res.json(preference);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/operator-preferences/:namespace/:key', (req, res) => {
    try {
      const { namespace, key } = parsePreferenceParams(req.params);
      const { value } = parseBody(preferenceBodySchema, req);
      res.json(upsertOperatorPreference(actorFromRequest(req), namespace, key, value));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/operator-preferences/:namespace/:key', (req, res) => {
    try {
      const { namespace, key } = parsePreferenceParams(req.params);
      const deleted = deleteOperatorPreference(actorFromRequest(req), namespace, key);
      res.json({ success: deleted });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Notifications
  router.get('/notifications', (req, res) => {
    const { unread } = req.query;
    res.json(listNotifications({ unreadOnly: unread === 'true', workspaceId: ws(req), limit: 50 }));
  });

  router.post('/notifications/:id/read', (req, res) => {
    markNotificationRead(req.params.id, ws(req));
    res.json({ success: true });
  });

  router.post('/notifications/read-all', (req, res) => {
    markAllNotificationsRead(ws(req));
    res.json({ success: true });
  });

  // Human-in-the-loop inbox
  router.get('/inbox', (req, res) => {
    try {
      const { status, taskId, pipelineId, executionId, limit } = parseQuery(inboxListQuerySchema, req);
      res.json(listInboxEntries({ status, taskId, pipelineId, executionId, workspaceId: ws(req), limit }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/inbox', (req, res) => {
    try {
      const { type, title, message, options, taskId, pipelineId, executionId, createdBy } = parseBody(createInboxSchema, req);
      const entry = createInboxEntry({
        type, title, message, options, taskId, pipelineId, executionId, workspaceId: ws(req), createdBy,
      });
      const notification = createNotification({
        type: 'needs_input',
        title: `Needs input: ${entry.title}`,
        message: entry.message,
        taskId: entry.taskId,
        pipelineId: entry.pipelineId,
        workspaceId: entry.workspaceId,
      });
      eventBus.emit('inbox:created', { inboxEntryId: entry.id, entry, workspaceId: entry.workspaceId });
      eventBus.emit('notification', { notification, workspaceId: notification.workspaceId });
      res.status(201).json(entry);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/inbox/:id', (req, res) => {
    try {
      const entry = getInboxEntry(req.params.id);
      if (!entry || !requestCanAccessWorkspace(req, entry.workspaceId || 'default')) notFound('INBOX_ENTRY_NOT_FOUND', 'Inbox entry not found');
      res.json(entry);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/inbox/:id/respond', (req, res) => {
    try {
      const entry = getInboxEntry(req.params.id);
      if (!entry || !requestCanAccessWorkspace(req, entry.workspaceId || 'default')) notFound('INBOX_ENTRY_NOT_FOUND', 'Inbox entry not found');
      if (entry.status !== 'pending') {
        throw new HttpError(400, 'INBOX_ENTRY_RESOLVED', 'Inbox entry is already resolved');
      }

      const actor = requireOperatorRole(req, 'inbox.respond', ['admin', 'operator']);
      const { status, response } = parseBody(respondInboxSchema, req);
      const updated = respondToInboxEntry(req.params.id, { status, response });
      createOperatorAction({
        action: `inbox.${status}`,
        actor,
        targetType: 'inbox',
        targetId: req.params.id,
        taskId: entry.taskId,
        pipelineId: entry.pipelineId,
        inboxEntryId: req.params.id,
        metadata: {
          type: entry.type,
          previousStatus: entry.status,
          hasResponse: !!response,
        },
      });
      eventBus.emit('inbox:updated', { inboxEntryId: req.params.id, entry: updated, workspaceId: entry.workspaceId });
      res.json(updated);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
