import { describe, it, expect } from 'vitest';
import type { InboxEntry, Notification } from '@myrmecia/shared';
import {
  filterNotifications,
  notificationScope,
  buildNotificationGroups,
  notificationTarget,
  relatedNotificationsForInbox,
} from '../src/lib/notificationTriage';

function notif(o: Partial<Notification> = {}): Notification {
  return {
    id: 'n1',
    type: 'task_complete',
    title: 'Title',
    message: 'Body',
    read: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...o,
  };
}

describe('notificationScope', () => {
  it('routes needs_input to inbox regardless of ids', () => {
    expect(notificationScope(notif({ type: 'needs_input', taskId: 't1' }))).toBe('inbox');
  });
  it('prefers pipeline over task', () => {
    expect(notificationScope(notif({ taskId: 't1', pipelineId: 'p1' }))).toBe('pipelines');
  });
  it('falls back to tasks then system', () => {
    expect(notificationScope(notif({ taskId: 't1' }))).toBe('tasks');
    expect(notificationScope(notif({}))).toBe('system');
  });
});

describe('filterNotifications', () => {
  const items = [
    notif({ id: 'a', type: 'task_failed', read: false, taskId: 't1' }),
    notif({ id: 'b', type: 'task_complete', read: true, taskId: 't2' }),
    notif({ id: 'c', type: 'pipeline_stage', read: false, pipelineId: 'p1' }),
    notif({ id: 'd', type: 'needs_input', read: false, title: 'Approve deploy' }),
  ];

  it('filters by unread status', () => {
    const out = filterNotifications(items, { query: '', status: 'unread', scope: 'all', type: 'all' });
    expect(out.map(n => n.id)).toEqual(['a', 'c', 'd']);
  });
  it('filters by read status', () => {
    const out = filterNotifications(items, { query: '', status: 'read', scope: 'all', type: 'all' });
    expect(out.map(n => n.id)).toEqual(['b']);
  });
  it('filters by type', () => {
    const out = filterNotifications(items, { query: '', status: 'all', scope: 'all', type: 'task_failed' });
    expect(out.map(n => n.id)).toEqual(['a']);
  });
  it('filters by scope', () => {
    expect(filterNotifications(items, { query: '', status: 'all', scope: 'pipelines', type: 'all' }).map(n => n.id)).toEqual(['c']);
    expect(filterNotifications(items, { query: '', status: 'all', scope: 'tasks', type: 'all' }).map(n => n.id)).toEqual(['a', 'b']);
  });
  it('matches a case-insensitive query against title/message/ids', () => {
    expect(filterNotifications(items, { query: 'approve', status: 'all', scope: 'all', type: 'all' }).map(n => n.id)).toEqual(['d']);
    expect(filterNotifications(items, { query: 't1', status: 'all', scope: 'all', type: 'all' }).map(n => n.id)).toEqual(['a']);
  });
});

describe('buildNotificationGroups', () => {
  it('groups by category, counts unread, and drops empty groups', () => {
    const groups = buildNotificationGroups([
      notif({ id: 'a', type: 'task_failed', read: false }),
      notif({ id: 'b', type: 'agent_error', read: true }),
      notif({ id: 'c', type: 'needs_input', read: false }),
      notif({ id: 'd', type: 'task_complete', read: false }),
    ]);
    const byId = Object.fromEntries(groups.map(g => [g.id, g]));
    expect(byId.failures.notifications.map(n => n.id)).toEqual(['a', 'b']);
    expect(byId.failures.unreadCount).toBe(1);
    expect(byId.input).toBeDefined();
    expect(byId.completed).toBeDefined();
    // No pipeline_stage notifications → that group is omitted.
    expect(byId.pipelines).toBeUndefined();
  });

  it('returns an empty array when there are no notifications', () => {
    expect(buildNotificationGroups([])).toEqual([]);
  });
});

describe('notificationTarget', () => {
  it('maps to inbox / task / pipeline / observability', () => {
    expect(notificationTarget(notif({ type: 'needs_input', taskId: 't1' }))).toEqual({ kind: 'inbox' });
    expect(notificationTarget(notif({ taskId: 't1' }))).toEqual({ kind: 'task', taskId: 't1' });
    expect(notificationTarget(notif({ pipelineId: 'p1' }))).toEqual({ kind: 'pipeline', pipelineId: 'p1' });
    expect(notificationTarget(notif({}))).toEqual({ kind: 'observability' });
  });
});

describe('relatedNotificationsForInbox', () => {
  const entry = { id: 'e1', taskId: 't1', title: 'Approve', message: 'Please approve' } as InboxEntry;
  it('matches needs_input notifications by task id', () => {
    const out = relatedNotificationsForInbox(entry, [
      notif({ id: 'a', type: 'needs_input', taskId: 't1' }),
      notif({ id: 'b', type: 'needs_input', taskId: 't2' }),
      notif({ id: 'c', type: 'task_complete', taskId: 't1' }),
    ]);
    expect(out.map(n => n.id)).toEqual(['a']);
  });
});
