import type { InboxEntry, Notification } from '@myrmecia/shared';

export type NotificationStatusFilter = 'all' | 'unread' | 'read';
export type NotificationScopeFilter = 'all' | 'tasks' | 'pipelines' | 'inbox' | 'system';
export type NotificationTypeFilter = 'all' | Notification['type'];

export interface NotificationFilters {
  query: string;
  status: NotificationStatusFilter;
  scope: NotificationScopeFilter;
  type: NotificationTypeFilter;
}

export interface NotificationGroup {
  id: string;
  label: string;
  description: string;
  icon: string;
  tone: 'red' | 'yellow' | 'purple' | 'blue' | 'green';
  notifications: Notification[];
  unreadCount: number;
}

export type NotificationTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'pipeline'; pipelineId: string }
  | { kind: 'inbox' }
  | { kind: 'observability' };

export const notificationTypeLabels: Record<Notification['type'], string> = {
  task_complete: 'Task complete',
  task_failed: 'Task failed',
  pipeline_stage: 'Pipeline stage',
  needs_input: 'Needs input',
  agent_error: 'Agent error',
};

export const defaultNotificationFilters: NotificationFilters = {
  query: '',
  status: 'unread',
  scope: 'all',
  type: 'all',
};

function matchesQuery(notification: Notification, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    notification.title,
    notification.message,
    notification.type,
    notification.taskId,
    notification.pipelineId,
  ].some(value => value?.toLowerCase().includes(normalized));
}

export function notificationScope(notification: Notification): Exclude<NotificationScopeFilter, 'all'> {
  if (notification.type === 'needs_input') return 'inbox';
  if (notification.pipelineId) return 'pipelines';
  if (notification.taskId) return 'tasks';
  return 'system';
}

function matchesScope(notification: Notification, scope: NotificationScopeFilter): boolean {
  if (scope === 'all') return true;
  if (scope === 'tasks') return Boolean(notification.taskId);
  if (scope === 'pipelines') return Boolean(notification.pipelineId);
  return notificationScope(notification) === scope;
}

export function filterNotifications(notifications: Notification[], filters: NotificationFilters): Notification[] {
  return notifications.filter(notification => {
    if (filters.status === 'unread' && notification.read) return false;
    if (filters.status === 'read' && !notification.read) return false;
    if (filters.type !== 'all' && notification.type !== filters.type) return false;
    if (!matchesScope(notification, filters.scope)) return false;
    return matchesQuery(notification, filters.query);
  });
}

function group(
  id: string,
  label: string,
  description: string,
  icon: string,
  tone: NotificationGroup['tone'],
  notifications: Notification[],
): NotificationGroup | null {
  if (notifications.length === 0) return null;
  return {
    id,
    label,
    description,
    icon,
    tone,
    notifications,
    unreadCount: notifications.filter(notification => !notification.read).length,
  };
}

export function buildNotificationGroups(notifications: Notification[]): NotificationGroup[] {
  return [
    group(
      'failures',
      'Failures',
      'Failed tasks and agent errors that likely need intervention.',
      '⚠️',
      'red',
      notifications.filter(notification => notification.type === 'task_failed' || notification.type === 'agent_error'),
    ),
    group(
      'input',
      'Needs input',
      'Human-in-the-loop approvals, questions, and input requests.',
      '📥',
      'purple',
      notifications.filter(notification => notification.type === 'needs_input'),
    ),
    group(
      'pipelines',
      'Pipelines',
      'Pipeline stage changes and gated orchestration updates.',
      '🔗',
      'yellow',
      notifications.filter(notification => notification.type === 'pipeline_stage'),
    ),
    group(
      'completed',
      'Completed',
      'Finished tasks that are ready for review or handoff.',
      '✅',
      'green',
      notifications.filter(notification => notification.type === 'task_complete'),
    ),
    group(
      'other',
      'Other',
      'General system notifications without a task or pipeline scope.',
      '•',
      'blue',
      notifications.filter(notification => !['task_failed', 'agent_error', 'needs_input', 'pipeline_stage', 'task_complete'].includes(notification.type)),
    ),
  ].filter((item): item is NotificationGroup => item !== null);
}

export function notificationTarget(notification: Notification): NotificationTarget {
  if (notification.type === 'needs_input') return { kind: 'inbox' };
  if (notification.taskId) return { kind: 'task', taskId: notification.taskId };
  if (notification.pipelineId) return { kind: 'pipeline', pipelineId: notification.pipelineId };
  return { kind: 'observability' };
}

export function relatedNotificationsForInbox(entry: InboxEntry, notifications: Notification[]): Notification[] {
  return notifications.filter(notification => {
    if (notification.type !== 'needs_input') return false;
    if (entry.taskId && notification.taskId === entry.taskId) return true;
    if (entry.pipelineId && notification.pipelineId === entry.pipelineId) return true;
    if (!entry.taskId && !entry.pipelineId) {
      return notification.title.includes(entry.title) || notification.message === entry.message;
    }
    return false;
  });
}
