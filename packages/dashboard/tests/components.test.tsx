import { describe, it, expect } from 'vitest';
import { api } from '../src/lib/api';
import {
  filterNotifications,
  buildNotificationGroups,
  notificationScope,
  notificationTarget,
  defaultNotificationFilters,
  notificationTypeLabels,
} from '../src/lib/notificationTriage';
import {
  runtimeControlsAllowed,
  taskDeleteAllowed,
  operatorRoleLabel,
  readOnlyControlMessage,
} from '../src/lib/permissions';
import { createSavedView, savedViewScope } from '../src/lib/savedViews';
import { buildActivitySummary, handoffTotal } from '../src/lib/activitySummary';

// ─── API module structure ────────────────────────────────────────────────────

describe('api module structure', () => {
  it('exports tasks namespace with expected methods', () => {
    expect(api.tasks).toBeDefined();
    expect(api.tasks.list).toBeTypeOf('function');
    expect(api.tasks.get).toBeTypeOf('function');
    expect(api.tasks.create).toBeTypeOf('function');
    expect(api.tasks.cancel).toBeTypeOf('function');
    expect(api.tasks.retry).toBeTypeOf('function');
    expect(api.tasks.delete).toBeTypeOf('function');
  });

  it('exports agents namespace with expected methods', () => {
    expect(api.agents).toBeDefined();
    expect(api.agents.list).toBeTypeOf('function');
    expect(api.agents.get).toBeTypeOf('function');
    expect(api.agents.execute).toBeTypeOf('function');
    expect(api.agents.executions).toBeTypeOf('function');
  });

  it('exports pipelines namespace', () => {
    expect(api.pipelines).toBeDefined();
    expect(api.pipelines.list).toBeTypeOf('function');
    expect(api.pipelines.create).toBeTypeOf('function');
    expect(api.pipelines.approve).toBeTypeOf('function');
  });

  it('exports tools namespace', () => {
    expect(api.tools).toBeDefined();
    expect(api.tools.list).toBeTypeOf('function');
    expect(api.tools.executions).toBeTypeOf('function');
  });

  it('exports models namespace', () => {
    expect(api.models).toBeDefined();
    expect(api.models.list).toBeTypeOf('function');
    expect(api.models.routes).toBeTypeOf('function');
  });

  it('exports executions namespace', () => {
    expect(api.executions).toBeDefined();
    expect(api.executions.list).toBeTypeOf('function');
    expect(api.executions.messages).toBeTypeOf('function');
    expect(api.executions.trace).toBeTypeOf('function');
  });

  it('exports preferences namespace', () => {
    expect(api.preferences).toBeDefined();
    expect(api.preferences.list).toBeTypeOf('function');
    expect(api.preferences.get).toBeTypeOf('function');
    expect(api.preferences.put).toBeTypeOf('function');
    expect(api.preferences.delete).toBeTypeOf('function');
  });

  it('exports notifications namespace', () => {
    expect(api.notifications).toBeDefined();
    expect(api.notifications.list).toBeTypeOf('function');
    expect(api.notifications.markRead).toBeTypeOf('function');
    expect(api.notifications.markAllRead).toBeTypeOf('function');
  });

  it('exports all top-level namespaces', () => {
    const namespaces = [
      'tasks', 'agents', 'tools', 'models', 'skills', 'executions',
      'pipelines', 'templates', 'events', 'preferences', 'notifications',
      'inbox', 'supervisor', 'knowledge', 'audit', 'plugins', 'billing',
      'usage', 'apiKeys', 'releases', 'eval', 'notificationChannels',
      'operatorActions', 'workspaceSnapshot',
    ];
    for (const ns of namespaces) {
      expect((api as any)[ns], `api.${ns} should exist`).toBeDefined();
    }
  });

  it('exports health and stats as functions', () => {
    expect(api.health).toBeTypeOf('function');
    expect(api.stats).toBeTypeOf('function');
    expect(api.observability).toBeTypeOf('function');
    expect(api.diagnostics).toBeTypeOf('function');
  });
});

// ─── Permissions ─────────────────────────────────────────────────────────────

describe('permissions', () => {
  it('runtimeControlsAllowed returns true when diagnostics is null', () => {
    expect(runtimeControlsAllowed(null)).toBe(true);
  });

  it('taskDeleteAllowed returns true when diagnostics is null', () => {
    expect(taskDeleteAllowed(null)).toBe(true);
  });

  it('operatorRoleLabel returns unknown when diagnostics is null', () => {
    expect(operatorRoleLabel(null)).toBe('unknown operator');
  });

  it('readOnlyControlMessage is a non-empty string', () => {
    expect(readOnlyControlMessage.length).toBeGreaterThan(0);
  });
});

// ─── Notification Triage ─────────────────────────────────────────────────────

describe('notificationTriage', () => {
  const makeNotification = (overrides: any = {}) => ({
    id: '1',
    type: 'task_complete' as const,
    title: 'Test',
    message: 'msg',
    read: false,
    createdAt: '2024-01-01T00:00:00Z',
    taskId: 't1',
    ...overrides,
  });

  it('defaultNotificationFilters has expected defaults', () => {
    expect(defaultNotificationFilters.query).toBe('');
    expect(defaultNotificationFilters.status).toBe('unread');
    expect(defaultNotificationFilters.scope).toBe('all');
    expect(defaultNotificationFilters.type).toBe('all');
  });

  it('notificationTypeLabels has all types', () => {
    expect(Object.keys(notificationTypeLabels)).toHaveLength(5);
    expect(notificationTypeLabels.task_complete).toBe('Task complete');
  });

  it('filterNotifications returns unread by default filters', () => {
    const n1 = makeNotification({ read: false });
    const n2 = makeNotification({ id: '2', read: true });
    const result = filterNotifications([n1, n2], defaultNotificationFilters);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('filterNotifications filters by type', () => {
    const n1 = makeNotification({ type: 'task_complete' });
    const n2 = makeNotification({ id: '2', type: 'task_failed' });
    const result = filterNotifications([n1, n2], { ...defaultNotificationFilters, status: 'all', type: 'task_failed' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('2');
  });

  it('filterNotifications filters by query', () => {
    const n1 = makeNotification({ title: 'Deploy finished' });
    const n2 = makeNotification({ id: '2', title: 'Build started' });
    const result = filterNotifications([n1, n2], { ...defaultNotificationFilters, status: 'all', query: 'deploy' });
    expect(result).toHaveLength(1);
  });

  it('notificationScope returns correct scope', () => {
    expect(notificationScope(makeNotification({ type: 'needs_input' }))).toBe('inbox');
    expect(notificationScope(makeNotification({ pipelineId: 'p1', taskId: undefined }))).toBe('pipelines');
    expect(notificationScope(makeNotification({ taskId: 't1' }))).toBe('tasks');
  });

  it('buildNotificationGroups groups correctly', () => {
    const notifications = [
      makeNotification({ type: 'task_failed' }),
      makeNotification({ id: '2', type: 'task_complete' }),
      makeNotification({ id: '3', type: 'needs_input' }),
    ];
    const groups = buildNotificationGroups(notifications);
    expect(groups.length).toBeGreaterThanOrEqual(3);
    expect(groups.find(g => g.id === 'failures')?.notifications).toHaveLength(1);
  });

  it('notificationTarget returns correct targets', () => {
    expect(notificationTarget(makeNotification({ type: 'needs_input' }))).toEqual({ kind: 'inbox' });
    expect(notificationTarget(makeNotification({ taskId: 't1' }))).toEqual({ kind: 'task', taskId: 't1' });
  });
});

// ─── Saved Views ─────────────────────────────────────────────────────────────

describe('savedViews', () => {
  it('createSavedView creates a view with id and timestamp', () => {
    const view = createSavedView('My View', { status: 'active' });
    expect(view.name).toBe('My View');
    expect(view.id).toMatch(/^view_/);
    expect(view.filters).toEqual({ status: 'active' });
    expect(view.createdAt).toBeTruthy();
  });

  it('savedViewScope returns unknown when diagnostics is null', () => {
    expect(savedViewScope(null)).toBe('unknown');
  });
});

// ─── Activity Summary ────────────────────────────────────────────────────────

describe('activitySummary', () => {
  it('buildActivitySummary returns empty summary for empty input', () => {
    const summary = buildActivitySummary({
      diagnostics: null,
      tasks: [],
      inboxEntries: [],
      pipelines: [],
      platformEvents: [],
      operatorActions: [],
    });
    expect(summary.failedWork).toHaveLength(0);
    expect(summary.pendingDecisions).toHaveLength(0);
    expect(summary.blockedPipelines).toHaveLength(0);
  });

  it('buildActivitySummary filters by checkpoint', () => {
    const summary = buildActivitySummary({
      diagnostics: null,
      checkpoint: '2024-06-01T00:00:00Z',
      tasks: [
        { id: '1', status: 'failed', createdAt: '2024-05-01T00:00:00Z' } as any,
        { id: '2', status: 'failed', createdAt: '2024-07-01T00:00:00Z' } as any,
      ],
      inboxEntries: [],
      pipelines: [],
      platformEvents: [],
      operatorActions: [],
    });
    expect(summary.failedWork).toHaveLength(1);
    expect(summary.failedWork[0].id).toBe('2');
  });

  it('handoffTotal sums all categories', () => {
    const summary = {
      failedWork: [1, 2] as any,
      pendingDecisions: [1] as any,
      blockedPipelines: [] as any,
      newEvents: [1, 2, 3] as any,
      recentLaunches: [1] as any,
      operatorActions: [],
    };
    expect(handoffTotal(summary)).toBe(7);
  });
});
