import { z } from 'zod';
import type { Request } from 'express';
import { listTasks, getTask } from '../db/models/task.js';
import { getPipeline, listPipelines } from '../db/models/pipeline.js';
import { listNotifications } from '../db/models/notification.js';
import { getInboxEntry, listInboxEntries } from '../db/models/inbox.js';
import { countPlatformEvents, listPlatformEvents } from '../db/models/platform-event.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { listOperatorPreferences, upsertOperatorPreference } from '../db/models/operator-preference.js';
import { getDatabaseDiagnostics } from '../db/database.js';
import { isApiAuthEnabled } from '../auth/token-auth.js';
import { workspaceIdFromRequest } from '../auth/tenant.js';
import { actorFromRequest, requireOperatorRole } from './http.js';
import type {
  ObservabilitySummary,
  PipelineStatus,
  RuntimeDiagnostics,
  TaskStatus,
  WorkspaceRestoreAction,
  WorkspaceRestorePlan,
  WorkspaceRestoreResourceType,
  WorkspacePreferenceRestoreResult,
  WorkspaceSnapshot,
  WorkspaceSnapshotPreview,
} from '../types.js';

// ---------- Schemas ----------

export const preferenceNameSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._:-]+$/);

export const workspaceSnapshotSchema = z.object({
  version: z.number(),
  generatedAt: z.string().optional(),
  generatedBy: z.object({
    id: z.string(),
    role: z.enum(['admin', 'operator', 'viewer']),
    source: z.enum(['local', 'token', 'proxy']),
  }).optional(),
  data: z.object({
    tasks: z.array(z.unknown()).optional(),
    pipelines: z.array(z.unknown()).optional(),
    inboxEntries: z.array(z.unknown()).optional(),
    notifications: z.array(z.unknown()).optional(),
    platformEvents: z.array(z.unknown()).optional(),
    preferences: z.array(z.unknown()).optional(),
  }).optional(),
});
export const snapshotPreviewBodySchema = z.union([
  workspaceSnapshotSchema,
  z.object({ snapshot: workspaceSnapshotSchema }),
]);
export const preferenceRestoreBodySchema = z.object({
  snapshot: workspaceSnapshotSchema,
});

// ---------- Observability & diagnostics ----------

export function buildObservabilitySummary(workspaceId?: string): ObservabilitySummary {
  const tasks = listTasks({ workspaceId });
  const pipelines = listPipelines({ workspaceId });
  const errorEvents = listPlatformEvents({ severity: 'error', workspaceId, limit: 100 });
  const taskById = new Map(tasks.map(task => [task.id, task]));

  const failures = new Map<string, { taskId: string; title: string; count: number; lastFailureAt?: string }>();
  for (const event of errorEvents) {
    if (!event.taskId) continue;
    const task = taskById.get(event.taskId);
    const current = failures.get(event.taskId) || {
      taskId: event.taskId,
      title: task?.title || event.taskId,
      count: 0,
      lastFailureAt: event.createdAt,
    };
    current.count += 1;
    if (!current.lastFailureAt || event.createdAt > current.lastFailureAt) current.lastFailureAt = event.createdAt;
    failures.set(event.taskId, current);
  }

  const pipelineCounts = new Map<PipelineStatus, number>();
  for (const pipeline of pipelines) {
    pipelineCounts.set(pipeline.status, (pipelineCounts.get(pipeline.status) || 0) + 1);
  }

  return {
    totals: {
      events: countPlatformEvents(workspaceId),
      tasks: tasks.length,
      failedTasks: tasks.filter(task => task.status === 'failed').length,
      cancelledTasks: tasks.filter(task => task.status === 'cancelled').length,
      retriedTasks: tasks.filter(task => task.retryCount > 0).length,
      pipelines: pipelines.length,
      failedPipelines: pipelines.filter(pipeline => pipeline.status === 'failed').length,
    },
    failureHotspots: [...failures.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    retryHotspots: tasks
      .filter(task => task.retryCount > 0)
      .sort((a, b) => b.retryCount - a.retryCount)
      .slice(0, 5)
      .map(task => ({ taskId: task.id, title: task.title, retryCount: task.retryCount, status: task.status as TaskStatus })),
    pipelineHealth: [...pipelineCounts.entries()].map(([status, count]) => ({ status, count })),
    recentErrors: errorEvents.slice(0, 10),
  };
}

export function buildRuntimeDiagnostics(req: Request): RuntimeDiagnostics {
  const redisConfigured = !!process.env.REDIS_URL || !!process.env.REDIS_HOST;
  const authEnabled = isApiAuthEnabled();
  const actor = actorFromRequest(req);
  return {
    auth: {
      enabled: authEnabled,
      mode: authEnabled ? 'token' : 'local',
    },
    operator: {
      actor,
      permissions: {
        canControlRuntime: actor.role === 'admin' || actor.role === 'operator',
        canDeleteTasks: actor.role === 'admin',
      },
    },
    queue: {
      backend: redisConfigured ? 'redis' : 'memory',
      redisConfigured,
    },
    database: getDatabaseDiagnostics(),
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      pid: process.pid,
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    },
  };
}

// ---------- Workspace snapshot ----------

function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const lower = key.toLowerCase();
    if (lower.includes('token') || lower.includes('secret') || lower.includes('password') || lower.includes('authorization') || lower.includes('apikey') || lower.includes('api_key')) {
      return [key, '[REDACTED]'];
    }
    return [key, redactSensitiveValue(item)];
  }));
}

export function buildWorkspaceSnapshot(req: Request): WorkspaceSnapshot {
  const actor = actorFromRequest(req);
  const workspaceId = workspaceIdFromRequest(req) || 'default';
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: actor,
    redaction: {
      secrets: 'excluded',
      diagnostics: 'sanitized',
    },
    data: {
      tasks: listTasks({ workspaceId, limit: 500 }),
      pipelines: listPipelines({ workspaceId }),
      inboxEntries: listInboxEntries({ workspaceId, limit: 500 }),
      notifications: listNotifications({ workspaceId, limit: 500 }),
      platformEvents: listPlatformEvents({ workspaceId, limit: 500 }),
      observability: buildObservabilitySummary(workspaceId),
      preferences: listOperatorPreferences(actor).map(preference => ({
        ...preference,
        value: redactSensitiveValue(preference.value),
      })),
    },
  };
}

function countSnapshotArray(snapshot: z.infer<typeof workspaceSnapshotSchema>, key: keyof NonNullable<typeof snapshot.data>): number {
  const value = snapshot.data?.[key];
  return Array.isArray(value) ? value.length : 0;
}

export function buildSnapshotPreview(snapshot: z.infer<typeof workspaceSnapshotSchema>): WorkspaceSnapshotPreview {
  const warnings: string[] = [];
  if (snapshot.version !== 1) warnings.push(`Snapshot version ${snapshot.version} may not be fully supported.`);
  if (!snapshot.data) warnings.push('Snapshot has no data section.');
  if (!snapshot.generatedAt) warnings.push('Snapshot has no generatedAt timestamp.');
  return {
    valid: warnings.length === 0 || snapshot.version === 1,
    version: snapshot.version,
    generatedAt: snapshot.generatedAt,
    generatedBy: snapshot.generatedBy,
    counts: {
      tasks: countSnapshotArray(snapshot, 'tasks'),
      pipelines: countSnapshotArray(snapshot, 'pipelines'),
      inboxEntries: countSnapshotArray(snapshot, 'inboxEntries'),
      notifications: countSnapshotArray(snapshot, 'notifications'),
      platformEvents: countSnapshotArray(snapshot, 'platformEvents'),
      preferences: countSnapshotArray(snapshot, 'preferences'),
    },
    warnings,
  };
}

export function snapshotFromBody(body: z.infer<typeof snapshotPreviewBodySchema>): z.infer<typeof workspaceSnapshotSchema> {
  return 'snapshot' in body ? body.snapshot : body;
}

// ---------- Restore plan ----------

function objectId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}

function arrayField(value: unknown, field: string): string[] {
  if (!value || typeof value !== 'object') return [];
  const fieldValue = (value as Record<string, unknown>)[field];
  return Array.isArray(fieldValue) ? fieldValue.filter((item): item is string => typeof item === 'string') : [];
}

function preferenceId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const namespace = typeof item.namespace === 'string' ? item.namespace : undefined;
  const key = typeof item.key === 'string' ? item.key : undefined;
  return namespace && key ? `${namespace}/${key}` : undefined;
}

function containsRedactedValue(value: unknown): boolean {
  if (value === '[REDACTED]') return true;
  if (Array.isArray(value)) return value.some(containsRedactedValue);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some(containsRedactedValue);
}

function preferenceParts(value: unknown): { namespace: string; key: string; value: unknown } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const namespace = typeof item.namespace === 'string' ? item.namespace : undefined;
  const key = typeof item.key === 'string' ? item.key : undefined;
  if (!namespace || !key || !preferenceNameSchema.safeParse(namespace).success || !preferenceNameSchema.safeParse(key).success) return undefined;
  return { namespace, key, value: item.value };
}

function addCollectionActions(input: {
  actions: WorkspaceRestoreAction[];
  warnings: string[];
  items: unknown[];
  resourceType: Exclude<WorkspaceRestoreResourceType, 'preference'>;
  exists: (id: string) => boolean;
  dependencyCheck?: (item: unknown) => string[];
}) {
  const seen = new Set<string>();
  for (const item of input.items) {
    const id = objectId(item);
    if (!id) {
      input.warnings.push(`Skipped ${input.resourceType} without an id.`);
      continue;
    }
    if (seen.has(id)) {
      input.actions.push({
        type: 'conflict',
        resourceType: input.resourceType,
        resourceId: id,
        reason: 'Duplicate id appears more than once in the imported snapshot.',
      });
      continue;
    }
    seen.add(id);
    const missing = input.dependencyCheck?.(item) || [];
    if (input.exists(id)) {
      input.actions.push({
        type: 'skip',
        resourceType: input.resourceType,
        resourceId: id,
        reason: 'A resource with this id already exists in the current workspace.',
        dependencies: missing,
      });
    } else if (missing.length > 0) {
      input.actions.push({
        type: 'conflict',
        resourceType: input.resourceType,
        resourceId: id,
        reason: 'Imported resource references missing dependencies.',
        dependencies: missing,
      });
    } else {
      input.actions.push({
        type: 'create',
        resourceType: input.resourceType,
        resourceId: id,
        reason: 'Resource id is not present in the current workspace.',
      });
    }
  }
}

export function buildRestorePlan(req: Request, snapshot: z.infer<typeof workspaceSnapshotSchema>): WorkspaceRestorePlan {
  const preview = buildSnapshotPreview(snapshot);
  const actions: WorkspaceRestoreAction[] = [];
  const warnings = [...preview.warnings];
  const data = snapshot.data || {};
  const workspaceId = workspaceIdFromRequest(req) || 'default';
  const snapshotPipelineIds = new Set((data.pipelines || []).map(objectId).filter((id): id is string => Boolean(id)));
  const snapshotTaskIds = new Set((data.tasks || []).map(objectId).filter((id): id is string => Boolean(id)));

  addCollectionActions({
    actions,
    warnings,
    items: data.tasks || [],
    resourceType: 'task',
    exists: id => Boolean(getTask(id)),
    dependencyCheck: item => {
      const missing: string[] = [];
      const pipelineId = stringField(item, 'pipelineId');
      const parentTaskId = stringField(item, 'parentTaskId');
      const dependsOn = arrayField(item, 'dependsOn');
      if (pipelineId && !getPipeline(pipelineId) && !snapshotPipelineIds.has(pipelineId)) missing.push(`pipeline:${pipelineId}`);
      if (parentTaskId && !getTask(parentTaskId) && !snapshotTaskIds.has(parentTaskId)) missing.push(`task:${parentTaskId}`);
      for (const dep of dependsOn) {
        if (!getTask(dep) && !snapshotTaskIds.has(dep)) missing.push(`task:${dep}`);
      }
      return missing;
    },
  });
  addCollectionActions({
    actions,
    warnings,
    items: data.pipelines || [],
    resourceType: 'pipeline',
    exists: id => Boolean(getPipeline(id)),
    dependencyCheck: item => {
      const stages = Array.isArray((item as any)?.stages) ? (item as any).stages as unknown[] : [];
      return stages
        .map(stage => stringField(stage, 'taskId'))
        .filter((taskId): taskId is string => Boolean(taskId))
        .filter(taskId => !getTask(taskId) && !snapshotTaskIds.has(taskId))
        .map(taskId => `task:${taskId}`);
    },
  });
  addCollectionActions({
    actions,
    warnings,
    items: data.inboxEntries || [],
    resourceType: 'inboxEntry',
    exists: id => Boolean(getInboxEntry(id)),
    dependencyCheck: item => {
      const missing: string[] = [];
      const taskId = stringField(item, 'taskId');
      const pipelineId = stringField(item, 'pipelineId');
      if (taskId && !getTask(taskId) && !snapshotTaskIds.has(taskId)) missing.push(`task:${taskId}`);
      if (pipelineId && !getPipeline(pipelineId) && !snapshotPipelineIds.has(pipelineId)) missing.push(`pipeline:${pipelineId}`);
      return missing;
    },
  });

  const currentNotificationIds = new Set(listNotifications({ workspaceId, limit: 10000 }).map(notification => notification.id));
  addCollectionActions({
    actions,
    warnings,
    items: data.notifications || [],
    resourceType: 'notification',
    exists: id => currentNotificationIds.has(id),
  });

  const currentEventIds = new Set(listPlatformEvents({ workspaceId, limit: 10000 }).map(event => String(event.id)));
  addCollectionActions({
    actions,
    warnings,
    items: data.platformEvents || [],
    resourceType: 'platformEvent',
    exists: id => currentEventIds.has(id),
  });

  const currentPreferenceIds = new Set(listOperatorPreferences(actorFromRequest(req)).map(preference => `${preference.namespace}/${preference.key}`));
  const seenPreferences = new Set<string>();
  for (const preference of data.preferences || []) {
    const id = preferenceId(preference);
    if (!id) {
      warnings.push('Skipped preference without namespace/key.');
      continue;
    }
    if (seenPreferences.has(id)) {
      actions.push({
        type: 'conflict',
        resourceType: 'preference',
        resourceId: id,
        reason: 'Duplicate preference appears more than once in the imported snapshot.',
      });
      continue;
    }
    seenPreferences.add(id);
    actions.push({
      type: currentPreferenceIds.has(id) ? 'skip' : 'create',
      resourceType: 'preference',
      resourceId: id,
      reason: currentPreferenceIds.has(id)
        ? 'A preference with this namespace/key already exists for the current operator.'
        : 'Preference is not present for the current operator.',
    });
  }

  const summary = {
    create: actions.filter(action => action.type === 'create').length,
    skip: actions.filter(action => action.type === 'skip').length,
    conflict: actions.filter(action => action.type === 'conflict').length,
    warnings: warnings.length,
  };
  return {
    valid: preview.valid && summary.conflict === 0,
    preview,
    summary,
    actions,
    warnings,
  };
}

export function restorePreferencesFromSnapshot(req: Request, snapshot: z.infer<typeof workspaceSnapshotSchema>): WorkspacePreferenceRestoreResult {
  const actor = requireOperatorRole(req, 'workspace.restore.preferences', ['admin', 'operator', 'viewer']);
  const items: WorkspacePreferenceRestoreResult['items'] = [];
  const seen = new Set<string>();

  for (const preference of snapshot.data?.preferences || []) {
    const parsed = preferenceParts(preference);
    if (!parsed) {
      items.push({
        namespace: 'unknown',
        key: 'unknown',
        status: 'skipped',
        reason: 'Preference is missing a valid namespace/key.',
      });
      continue;
    }
    const id = `${parsed.namespace}/${parsed.key}`;
    if (seen.has(id)) {
      items.push({
        namespace: parsed.namespace,
        key: parsed.key,
        status: 'skipped',
        reason: 'Duplicate preference in snapshot; first occurrence was used.',
      });
      continue;
    }
    seen.add(id);
    if (containsRedactedValue(parsed.value)) {
      items.push({
        namespace: parsed.namespace,
        key: parsed.key,
        status: 'skipped',
        reason: 'Preference contains redacted values and will not overwrite local state.',
      });
      continue;
    }
    try {
      upsertOperatorPreference(actor, parsed.namespace, parsed.key, parsed.value);
      items.push({
        namespace: parsed.namespace,
        key: parsed.key,
        status: 'restored',
        reason: 'Preference restored for the current operator.',
      });
    } catch (err) {
      items.push({
        namespace: parsed.namespace,
        key: parsed.key,
        status: 'failed',
        reason: err instanceof Error ? err.message : 'Failed to restore preference.',
      });
    }
  }

  const result = {
    actor,
    restored: items.filter(item => item.status === 'restored').length,
    skipped: items.filter(item => item.status === 'skipped').length,
    failed: items.filter(item => item.status === 'failed').length,
    items,
  };
  const action = createOperatorAction({
    action: 'workspace.restore.preferences',
    actor,
    targetType: 'system',
    targetId: 'workspace-snapshot',
    status: result.failed > 0 ? 'failed' : 'success',
    metadata: {
      restored: result.restored,
      skipped: result.skipped,
      failed: result.failed,
      snapshotVersion: snapshot.version,
      snapshotGeneratedAt: snapshot.generatedAt,
    },
  });

  return { ...result, auditActionId: action.id };
}
