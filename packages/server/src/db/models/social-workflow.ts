import { v4 as uuid } from 'uuid';
import { getDb } from '../database.js';
import type { SocialMonitorJob, SocialPublishSchedule } from '../../types.js';

function rowToSchedule(row: any): SocialPublishSchedule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contentId: row.content_id,
    platform: row.platform,
    accountId: row.account_id,
    scheduleAt: row.schedule_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMonitorJob(row: any): SocialMonitorJob {
  let result: unknown;
  try {
    result = row.result ? JSON.parse(row.result) : undefined;
  } catch {
    result = row.result;
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contentId: row.content_id,
    platform: row.platform,
    publishId: row.publish_id,
    windowHours: row.window_hours,
    dueAt: row.due_at,
    status: row.status,
    taskId: row.task_id || undefined,
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSocialSchedule(data: {
  workspaceId?: string;
  contentId: string;
  platform: SocialPublishSchedule['platform'];
  accountId: string;
  scheduleAt: string;
  status?: SocialPublishSchedule['status'];
}): SocialPublishSchedule {
  const id = `social_sched_${uuid().slice(0, 8)}`;
  getDb().run(`
    INSERT INTO social_publish_schedules (
      id, workspace_id, content_id, platform, account_id, schedule_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, id, data.workspaceId || 'default', data.contentId, data.platform, data.accountId, data.scheduleAt, data.status || 'draft');
  return getSocialSchedule(id)!;
}

export function getSocialSchedule(id: string): SocialPublishSchedule | undefined {
  const row = getDb().get('SELECT * FROM social_publish_schedules WHERE id = ?', id);
  return row ? rowToSchedule(row) : undefined;
}

export function listSocialSchedules(filter: {
  workspaceId?: string;
  platform?: SocialPublishSchedule['platform'];
  accountId?: string;
  status?: SocialPublishSchedule['status'];
} = {}): SocialPublishSchedule[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (filter.platform) { conditions.push('platform = ?'); params.push(filter.platform); }
  if (filter.accountId) { conditions.push('account_id = ?'); params.push(filter.accountId); }
  if (filter.status) { conditions.push('status = ?'); params.push(filter.status); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return getDb().all(`SELECT * FROM social_publish_schedules${where} ORDER BY schedule_at`, ...params).map(rowToSchedule);
}

export function findSocialScheduleConflicts(data: {
  workspaceId?: string;
  platform: SocialPublishSchedule['platform'];
  accountId: string;
  scheduleAt: string;
  windowMinutes?: number;
  excludeContentId?: string;
}): SocialPublishSchedule[] {
  const target = Date.parse(data.scheduleAt);
  if (!Number.isFinite(target)) throw new Error('scheduleAt must be a valid ISO-8601 timestamp');
  const windowMs = (data.windowMinutes ?? 30) * 60_000;
  return listSocialSchedules({
    workspaceId: data.workspaceId || 'default',
    platform: data.platform,
    accountId: data.accountId,
  }).filter(schedule => {
    if (schedule.status === 'cancelled' || schedule.status === 'published') return false;
    if (data.excludeContentId && schedule.contentId === data.excludeContentId) return false;
    return Math.abs(Date.parse(schedule.scheduleAt) - target) <= windowMs;
  });
}

export function updateSocialScheduleStatus(
  id: string,
  status: SocialPublishSchedule['status'],
): SocialPublishSchedule | undefined {
  getDb().run(
    'UPDATE social_publish_schedules SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    status,
    id,
  );
  return getSocialSchedule(id);
}

export function createSocialMonitorJobs(data: {
  workspaceId?: string;
  contentId: string;
  platform: SocialMonitorJob['platform'];
  publishId: string;
  publishedAt: string;
}): SocialMonitorJob[] {
  const publishedAt = Date.parse(data.publishedAt);
  if (!Number.isFinite(publishedAt)) throw new Error('publishedAt must be a valid ISO-8601 timestamp');
  const jobs: SocialMonitorJob[] = [];
  for (const windowHours of [48, 72, 168] as const) {
    const id = `social_mon_${uuid().slice(0, 8)}`;
    const dueAt = new Date(publishedAt + windowHours * 60 * 60 * 1000).toISOString();
    getDb().run(`
      INSERT INTO social_monitor_jobs (
        id, workspace_id, content_id, platform, publish_id, window_hours, due_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, platform, publish_id, window_hours) DO NOTHING
    `, id, data.workspaceId || 'default', data.contentId, data.platform, data.publishId, windowHours, dueAt);
  }
  return listSocialMonitorJobs({
    workspaceId: data.workspaceId || 'default',
    platform: data.platform,
    publishId: data.publishId,
  });
}

export function listSocialMonitorJobs(filter: {
  workspaceId?: string;
  platform?: SocialMonitorJob['platform'];
  publishId?: string;
  status?: SocialMonitorJob['status'];
  dueBefore?: string;
} = {}): SocialMonitorJob[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (filter.platform) { conditions.push('platform = ?'); params.push(filter.platform); }
  if (filter.publishId) { conditions.push('publish_id = ?'); params.push(filter.publishId); }
  if (filter.status) { conditions.push('status = ?'); params.push(filter.status); }
  if (filter.dueBefore) { conditions.push('due_at <= ?'); params.push(filter.dueBefore); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return getDb().all(`SELECT * FROM social_monitor_jobs${where} ORDER BY due_at`, ...params).map(rowToMonitorJob);
}

export function updateSocialMonitorJob(
  id: string,
  updates: { status?: SocialMonitorJob['status']; taskId?: string; result?: unknown },
): SocialMonitorJob | undefined {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.taskId !== undefined) { sets.push('task_id = ?'); params.push(updates.taskId); }
  if (updates.result !== undefined) { sets.push('result = ?'); params.push(JSON.stringify(updates.result)); }
  if (sets.length === 0) return undefined;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  getDb().run(`UPDATE social_monitor_jobs SET ${sets.join(', ')} WHERE id = ?`, ...params);
  const row = getDb().get('SELECT * FROM social_monitor_jobs WHERE id = ?', id);
  return row ? rowToMonitorJob(row) : undefined;
}

export function getSocialMonitorJobByTaskId(taskId: string): SocialMonitorJob | undefined {
  const row = getDb().get('SELECT * FROM social_monitor_jobs WHERE task_id = ?', taskId);
  return row ? rowToMonitorJob(row) : undefined;
}

export function getActiveSocialComplianceRulebook(workspaceId = 'default'):
  { id: string; workspaceId: string; version: number; yaml: string; createdBy: string; createdAt: string } | undefined {
  const row = getDb().get(`
    SELECT * FROM social_compliance_rulebooks
    WHERE workspace_id = ? AND active = 1
    ORDER BY version DESC LIMIT 1
  `, workspaceId) as any;
  return row ? {
    id: row.id,
    workspaceId: row.workspace_id,
    version: row.version,
    yaml: row.yaml,
    createdBy: row.created_by,
    createdAt: row.created_at,
  } : undefined;
}

export function saveSocialComplianceRulebook(data: {
  workspaceId?: string;
  yaml: string;
  createdBy: string;
}) {
  const workspaceId = data.workspaceId || 'default';
  const row = getDb().get(
    'SELECT COALESCE(MAX(version), 0) AS version FROM social_compliance_rulebooks WHERE workspace_id = ?',
    workspaceId,
  ) as any;
  const version = Number(row?.version || 0) + 1;
  const id = `social_rules_${uuid().slice(0, 8)}`;
  getDb().transaction(() => {
    getDb().run('UPDATE social_compliance_rulebooks SET active = 0 WHERE workspace_id = ?', workspaceId);
    getDb().run(`
      INSERT INTO social_compliance_rulebooks (
        id, workspace_id, version, yaml, created_by, active
      ) VALUES (?, ?, ?, ?, ?, 1)
    `, id, workspaceId, version, data.yaml, data.createdBy);
  });
  return getActiveSocialComplianceRulebook(workspaceId)!;
}
