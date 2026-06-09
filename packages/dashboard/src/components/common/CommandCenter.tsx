import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useStore } from '../../stores/store';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { WorkLauncher } from './WorkLauncher';
import { FilterResultSummary, SearchInput, SelectFilter } from './FilterControls';
import {
  buildActivitySummary,
  getHandoffCheckpoint,
  handoffTotal,
  loadHandoffCheckpoint,
  markHandoffReviewed,
} from '../../lib/activitySummary';
import {
  buildNotificationGroups,
  defaultNotificationFilters,
  filterNotifications,
  notificationTarget,
  notificationTypeLabels,
  type NotificationFilters,
} from '../../lib/notificationTriage';
import type { ActivitySummary } from '../../lib/activitySummary';
import type { Notification, Pipeline, PlatformEvent, Task } from '@myrmecia/shared';

const statusClass: Record<string, string> = {
  pending: 'bg-gray-500/15 text-gray-400',
  queued: 'bg-yellow-500/15 text-yellow-400',
  assigned: 'bg-blue-500/15 text-blue-300',
  running: 'bg-blue-500/15 text-blue-400',
  review: 'bg-purple-500/15 text-purple-400',
  done: 'bg-green-500/15 text-green-400',
  failed: 'bg-red-500/15 text-red-400',
  cancelled: 'bg-gray-500/15 text-gray-500',
};

function StatCard({ label, value, icon, tone }: { label: string; value: string | number; icon: string; tone: string }) {
  const tones: Record<string, string> = {
    blue: 'bg-blue-500/10 text-blue-300',
    green: 'bg-green-500/10 text-green-300',
    yellow: 'bg-yellow-500/10 text-yellow-300',
    red: 'bg-red-500/10 text-red-300',
    purple: 'bg-purple-500/10 text-purple-300',
  };

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] text-gray-500 mb-1">{label}</div>
          <div className="text-2xl font-bold">{value}</div>
        </div>
        <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center text-lg', tones[tone])}>
          {icon}
        </div>
      </div>
    </div>
  );
}

function AttentionCard({
  title, subtitle, icon, tone, onClick,
}: {
  title: string;
  subtitle: string;
  icon: string;
  tone: 'red' | 'yellow' | 'purple';
  onClick?: () => void;
}) {
  const tones = {
    red: 'border-red-500/20 bg-red-500/5 text-red-300',
    yellow: 'border-yellow-500/20 bg-yellow-500/5 text-yellow-300',
    purple: 'border-purple-500/20 bg-purple-500/5 text-purple-300',
  };
  return (
    <button
      onClick={onClick}
      className={cn('w-full text-left border rounded-xl p-4 hover:border-accent/40 transition', tones[tone])}
    >
      <div className="flex items-start gap-3">
        <span className="text-xl">{icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{title}</div>
          <div className="text-[11px] text-gray-500 mt-1 line-clamp-2">{subtitle}</div>
        </div>
      </div>
    </button>
  );
}

function WorkRow({ task, onOpen }: { task: Task; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-surface-hover transition text-left"
    >
      <span className={cn('px-2 py-0.5 rounded text-[10px] font-medium', statusClass[task.status] || statusClass.pending)}>
        {task.status}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{task.title}</div>
        <div className="text-[11px] text-gray-500">{task.mode} · {task.priority}</div>
      </div>
      <div className="text-[10px] text-gray-600">{new Date(task.createdAt).toLocaleTimeString()}</div>
    </button>
  );
}

function PipelineRow({ pipeline }: { pipeline: Pipeline }) {
  return (
    <div className="bg-background border border-border rounded-lg px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={cn(
          'w-2 h-2 rounded-full',
          pipeline.status === 'running' ? 'bg-blue-500 animate-pulse' :
          pipeline.status === 'blocked' ? 'bg-yellow-500' :
          pipeline.status === 'failed' ? 'bg-red-500' : 'bg-gray-500',
        )} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{pipeline.name}</div>
          <div className="text-[11px] text-gray-500">
            stage {pipeline.currentStageIndex + 1} / {pipeline.stages?.length || 0} · {pipeline.status}
          </div>
        </div>
      </div>
    </div>
  );
}

function EventRow({ event }: { event: PlatformEvent }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2 border-b border-border last:border-0">
      <span className={cn(
        'mt-1 w-2 h-2 rounded-full',
        event.severity === 'error' ? 'bg-red-500' : event.severity === 'warn' ? 'bg-yellow-500' : 'bg-blue-500',
      )} />
      <div className="min-w-0">
        <div className="text-xs font-medium truncate">{event.eventType}</div>
        <div className="text-[10px] text-gray-600">{new Date(event.createdAt).toLocaleString()}</div>
      </div>
    </div>
  );
}

function HandoffMetric({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  tone: 'red' | 'yellow' | 'purple' | 'blue' | 'green';
  onClick?: () => void;
}) {
  const tones = {
    red: 'border-red-500/20 text-red-300 bg-red-500/5',
    yellow: 'border-yellow-500/20 text-yellow-300 bg-yellow-500/5',
    purple: 'border-purple-500/20 text-purple-300 bg-purple-500/5',
    blue: 'border-blue-500/20 text-blue-300 bg-blue-500/5',
    green: 'border-green-500/20 text-green-300 bg-green-500/5',
  };
  const className = cn('border rounded-xl p-3 text-left transition', tones[tone], onClick && 'hover:border-accent/40 cursor-pointer');
  const content = (
    <>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-[11px] text-gray-500 mt-1">{label}</div>
    </>
  );
  return onClick ? <button onClick={onClick} className={className}>{content}</button> : <div className={className}>{content}</div>;
}

function HandoffListItem({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: string;
  title: string;
  detail: string;
  onClick?: () => void;
}) {
  const className = 'w-full flex items-start gap-3 px-3 py-2 border-b border-border last:border-0 text-left hover:bg-surface-hover transition';
  const content = (
    <>
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0">
        <div className="text-xs font-medium truncate">{title}</div>
        <div className="text-[10px] text-gray-600 mt-0.5">{detail}</div>
      </div>
    </>
  );
  return onClick ? <button onClick={onClick} className={className}>{content}</button> : <div className={className}>{content}</div>;
}

function HandoffPanel({
  summary,
  onOpenTask,
  onOpenInbox,
  onOpenOrchestrator,
  onOpenAudit,
  onOpenObserve,
  onReviewed,
}: {
  summary: ActivitySummary;
  onOpenTask: (taskId: string) => void;
  onOpenInbox: () => void;
  onOpenOrchestrator: () => void;
  onOpenAudit: () => void;
  onOpenObserve: () => void;
  onReviewed: () => void;
}) {
  const total = handoffTotal(summary);
  const recentItems = [
    ...summary.failedWork.slice(0, 2).map(task => ({
      key: `task-${task.id}`,
      icon: '⚠️',
      title: task.title,
      detail: `${task.status} · ${new Date(task.createdAt).toLocaleString()}`,
      onClick: () => onOpenTask(task.id),
    })),
    ...summary.pendingDecisions.slice(0, 2).map(entry => ({
      key: `inbox-${entry.id}`,
      icon: '📥',
      title: entry.title,
      detail: `${entry.type} · ${new Date(entry.createdAt).toLocaleString()}`,
      onClick: onOpenInbox,
    })),
    ...summary.recentLaunches.slice(0, 2).map(action => ({
      key: `launch-${action.id}`,
      icon: action.action === 'pipeline.create' ? '🔗' : '🚀',
      title: action.action,
      detail: `${action.actor.id} · ${new Date(action.createdAt).toLocaleString()}`,
      onClick: onOpenAudit,
    })),
  ].slice(0, 5);

  return (
    <section className="bg-surface border border-border rounded-2xl p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">Operator handoff</h3>
          <p className="text-[11px] text-gray-500 mt-1">
            {summary.checkpoint
              ? `Changes since ${new Date(summary.checkpoint).toLocaleString()}`
              : 'No handoff checkpoint yet. Showing current open activity.'}
          </p>
        </div>
        <button
          onClick={onReviewed}
          className="px-3 py-1.5 rounded-lg bg-accent/10 text-accent-light text-[11px] hover:bg-accent/20 transition"
        >
          Mark reviewed
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <HandoffMetric label="failed/cancelled" value={summary.failedWork.length} tone="red" />
        <HandoffMetric label="pending decisions" value={summary.pendingDecisions.length} tone="purple" onClick={onOpenInbox} />
        <HandoffMetric label="blocked pipelines" value={summary.blockedPipelines.length} tone="yellow" onClick={onOpenOrchestrator} />
        <HandoffMetric label="new events" value={summary.newEvents.length} tone="blue" onClick={onOpenObserve} />
        <HandoffMetric label="recent launches" value={summary.recentLaunches.length} tone="green" onClick={onOpenAudit} />
      </div>

      <div className="bg-background border border-border rounded-xl overflow-hidden">
        {recentItems.map(({ key, ...item }) => (
          <HandoffListItem key={key} {...item} />
        ))}
        {recentItems.length === 0 && (
          <div className="px-4 py-8 text-center text-gray-600 text-sm">
            {total === 0 ? 'No handoff items right now' : 'No recent launch/failure/decision items to list'}
          </div>
        )}
      </div>
    </section>
  );
}

function NotificationTriagePanel({
  notifications,
  unreadCount,
  onOpenNotification,
  onMarkRead,
  onMarkAllRead,
  busy,
}: {
  notifications: Notification[];
  unreadCount: number;
  onOpenNotification: (notification: Notification) => void;
  onMarkRead: (ids: string[]) => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  busy: boolean;
}) {
  const [filters, setFilters] = useState<NotificationFilters>(defaultNotificationFilters);
  const filtered = useMemo(() => filterNotifications(notifications, filters), [notifications, filters]);
  const groups = useMemo(() => buildNotificationGroups(filtered), [filtered]);
  const filteredUnreadIds = filtered.filter(notification => !notification.read).map(notification => notification.id);
  const tones = {
    red: 'border-red-500/20 bg-red-500/5 text-red-300',
    yellow: 'border-yellow-500/20 bg-yellow-500/5 text-yellow-300',
    purple: 'border-purple-500/20 bg-purple-500/5 text-purple-300',
    blue: 'border-blue-500/20 bg-blue-500/5 text-blue-300',
    green: 'border-green-500/20 bg-green-500/5 text-green-300',
  };

  const updateFilters = (updates: Partial<NotificationFilters>) => setFilters(current => ({ ...current, ...updates }));
  const resetFilters = () => setFilters(defaultNotificationFilters);

  return (
    <section className="bg-surface border border-border rounded-2xl p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">Notification triage</h3>
          <p className="text-[11px] text-gray-500 mt-1">
            Group, route, and acknowledge operator alerts without losing task context.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded-lg bg-accent/10 text-accent-light text-[11px]">
            {unreadCount} unread
          </span>
          <button
            onClick={() => onMarkRead(filteredUnreadIds)}
            disabled={busy || filteredUnreadIds.length === 0}
            className="px-3 py-1.5 rounded-lg bg-surface-hover text-[11px] text-gray-400 hover:text-white transition disabled:opacity-50"
          >
            Ack filtered
          </button>
          <button
            onClick={onMarkAllRead}
            disabled={busy || unreadCount === 0}
            className="px-3 py-1.5 rounded-lg bg-accent/10 text-accent-light text-[11px] hover:bg-accent/20 transition disabled:opacity-50"
          >
            Ack all
          </button>
        </div>
      </div>

      <div className="bg-background border border-border rounded-xl p-3 flex flex-wrap gap-2">
        <SearchInput
          value={filters.query}
          onChange={query => updateFilters({ query })}
          placeholder="Search notifications..."
        />
        <SelectFilter
          label="Status"
          value={filters.status}
          onChange={status => updateFilters({ status })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'unread', label: 'Unread' },
            { value: 'read', label: 'Read' },
          ]}
        />
        <SelectFilter
          label="Scope"
          value={filters.scope}
          onChange={scope => updateFilters({ scope })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'tasks', label: 'Tasks' },
            { value: 'pipelines', label: 'Pipelines' },
            { value: 'inbox', label: 'Inbox' },
            { value: 'system', label: 'System' },
          ]}
        />
        <SelectFilter
          label="Type"
          value={filters.type}
          onChange={type => updateFilters({ type })}
          options={[
            { value: 'all', label: 'All' },
            ...Object.entries(notificationTypeLabels).map(([value, label]) => ({
              value: value as NotificationFilters['type'],
              label,
            })),
          ]}
        />
        <FilterResultSummary shown={filtered.length} total={notifications.length} onClear={resetFilters} />
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
        {groups.slice(0, 4).map(group => (
          <div key={group.id} className={cn('border rounded-xl p-3', tones[group.tone])}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span>{group.icon}</span>
                  <span className="text-sm font-semibold">{group.label}</span>
                </div>
                <div className="text-[10px] text-gray-500 mt-1 line-clamp-2">{group.description}</div>
              </div>
              <span className="text-xl font-bold">{group.unreadCount}</span>
            </div>
            <button
              onClick={() => onMarkRead(group.notifications.filter(notification => !notification.read).map(notification => notification.id))}
              disabled={busy || group.unreadCount === 0}
              className="mt-3 text-[11px] text-gray-400 hover:text-white transition disabled:opacity-50"
            >
              Ack group
            </button>
          </div>
        ))}
        {groups.length === 0 && (
          <div className="md:col-span-2 xl:col-span-4 text-center py-8 text-gray-600 text-sm">
            No notifications match the current filters
          </div>
        )}
      </div>

      <div className="bg-background border border-border rounded-xl overflow-hidden">
        {filtered.slice(0, 8).map(notification => {
          const target = notificationTarget(notification);
          const targetLabel =
            target.kind === 'task' ? 'Open task' :
            target.kind === 'pipeline' ? 'Open pipeline' :
            target.kind === 'inbox' ? 'Open inbox' : 'Open observe';
          return (
            <div
              key={notification.id}
              className="w-full flex items-start gap-3 px-3 py-2 border-b border-border last:border-0 hover:bg-surface-hover transition"
            >
              <button
                onClick={() => onOpenNotification(notification)}
                className="flex-1 min-w-0 flex items-start gap-3 text-left"
              >
                <span className={cn(
                  'mt-1 w-2 h-2 rounded-full flex-shrink-0',
                  notification.read ? 'bg-gray-700' :
                  notification.type === 'task_failed' || notification.type === 'agent_error' ? 'bg-red-500' :
                  notification.type === 'needs_input' ? 'bg-purple-500' :
                  notification.type === 'pipeline_stage' ? 'bg-yellow-500' : 'bg-green-500',
                )} />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-medium truncate">{notification.title}</span>
                    {!notification.read && <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent-light text-[9px]">new</span>}
                  </span>
                  <span className="block text-[10px] text-gray-600 mt-0.5 line-clamp-1">{notification.message}</span>
                  <span className="block text-[10px] text-gray-700 mt-1">
                    {notificationTypeLabels[notification.type]} · {targetLabel} · {new Date(notification.createdAt).toLocaleString()}
                  </span>
                </span>
              </button>
              {!notification.read && (
                <button
                  onClick={() => onMarkRead([notification.id])}
                  className="px-2 py-1 rounded bg-surface-hover text-[10px] text-gray-400 hover:text-white transition"
                >
                  Ack
                </button>
              )}
            </div>
          );
        })}
        {notifications.length === 0 && (
          <div className="px-4 py-8 text-center text-gray-600 text-sm">No notifications recorded yet</div>
        )}
      </div>
    </section>
  );
}

export function CommandCenter() {
  const {
    health, tasks, agents, pipelines, inboxEntries, platformEvents, operatorActions, diagnostics,
    notifications, unreadCount,
    setActiveView, loadTasks, loadPipelines, loadPlatformEvents, loadOperatorActions,
    setActivePipelineId, markNotificationRead, markNotificationsRead, markAllNotificationsRead,
  } = useStore();
  const [commandInput, setCommandInput] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showLauncher, setShowLauncher] = useState(false);
  const [handoffCheckpoint, setHandoffCheckpoint] = useState<string | undefined>(() => getHandoffCheckpoint(null));
  const [acknowledgingNotifications, setAcknowledgingNotifications] = useState(false);

  useEffect(() => {
    let active = true;
    void loadHandoffCheckpoint(diagnostics).then(checkpoint => {
      if (active) setHandoffCheckpoint(checkpoint);
    });
    return () => { active = false; };
  }, [diagnostics?.operator.actor.id, diagnostics?.operator.actor.role, diagnostics?.operator.actor.source]);

  const runningTasks = tasks.filter(task => ['running', 'assigned', 'queued'].includes(task.status));
  const failedTasks = tasks.filter(task => task.status === 'failed');
  const reviewTasks = tasks.filter(task => task.status === 'review');
  const pendingInbox = inboxEntries.filter(entry => entry.status === 'pending');
  const activeAgents = agents.filter(agent => (agent.activeExecutions || 0) > 0);
  const activePipelines = pipelines.filter(pipeline => ['running', 'paused', 'blocked'].includes(pipeline.status));
  const blockedPipelines = pipelines.filter(pipeline => ['blocked', 'failed'].includes(pipeline.status));

  const attentionItems = useMemo(() => [
    ...pendingInbox.slice(0, 3).map(entry => ({
      key: `inbox-${entry.id}`,
      title: entry.title,
      subtitle: entry.message,
      icon: '📥',
      tone: 'purple' as const,
      onClick: () => setActiveView('inbox'),
    })),
    ...failedTasks.slice(0, 3).map(task => ({
      key: `task-${task.id}`,
      title: task.title,
      subtitle: task.error || task.description || 'Task failed and needs operator review.',
      icon: '⚠️',
      tone: 'red' as const,
      onClick: () => setSelectedTaskId(task.id),
    })),
    ...blockedPipelines.slice(0, 3).map(pipeline => ({
      key: `pipeline-${pipeline.id}`,
      title: pipeline.name,
      subtitle: `${pipeline.status} pipeline waiting for operator attention.`,
      icon: '🔗',
      tone: 'yellow' as const,
      onClick: () => setActiveView('orchestrator'),
    })),
  ].slice(0, 6), [pendingInbox, failedTasks, blockedPipelines, setActiveView]);

  const handoffSummary = useMemo(() => buildActivitySummary({
    diagnostics,
    checkpoint: handoffCheckpoint,
    tasks,
    inboxEntries,
    pipelines,
    platformEvents,
    operatorActions,
  }), [diagnostics, handoffCheckpoint, tasks, inboxEntries, pipelines, platformEvents, operatorActions]);

  const dispatchCommand = async (event: FormEvent) => {
    event.preventDefault();
    if (!commandInput.trim() || dispatching) return;
    setDispatching(true);
    setResult(null);
    try {
      const response: any = await api.supervisor.dispatch(commandInput.trim());
      setResult({ ok: true, message: `Dispatched via ${response.mode || 'supervisor'} mode` });
      setCommandInput('');
      await Promise.all([loadTasks(), loadPipelines(), loadPlatformEvents()]);
    } catch (err: any) {
      setResult({ ok: false, message: err.message });
    } finally {
      setDispatching(false);
    }
  };

  const acknowledgeNotifications = async (ids: string[]) => {
    if (ids.length === 0 || acknowledgingNotifications) return;
    setAcknowledgingNotifications(true);
    try {
      await markNotificationsRead(ids);
    } finally {
      setAcknowledgingNotifications(false);
    }
  };

  const acknowledgeAllNotifications = async () => {
    if (acknowledgingNotifications || unreadCount === 0) return;
    setAcknowledgingNotifications(true);
    try {
      await markAllNotificationsRead();
    } finally {
      setAcknowledgingNotifications(false);
    }
  };

  const openNotification = (notification: Notification) => {
    if (!notification.read) void markNotificationRead(notification.id);
    const target = notificationTarget(notification);
    if (target.kind === 'task') {
      setSelectedTaskId(target.taskId);
      return;
    }
    if (target.kind === 'pipeline') {
      setActivePipelineId(target.pipelineId);
      setActiveView('orchestrator');
      return;
    }
    if (target.kind === 'inbox') {
      setActiveView('inbox');
      return;
    }
    setActiveView('observability');
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Command Center</h2>
          <p className="text-sm text-gray-500 mt-1">
            Run work, watch multi-agent execution, and clear operator blockers from one place.
          </p>
        </div>
        <div className="flex items-center gap-2 bg-surface border border-border rounded-xl px-3 py-2">
          <span className={cn('w-2 h-2 rounded-full', health?.status === 'ok' ? 'bg-green-500' : 'bg-gray-500')} />
          <span className="text-[11px] text-gray-500">{health?.status === 'ok' ? 'Connected' : 'Connecting'}</span>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-2xl p-4">
        <form onSubmit={dispatchCommand} className="flex gap-3">
          <input
            value={commandInput}
            onChange={event => setCommandInput(event.target.value)}
            placeholder="Tell Myrmecia what to build, fix, investigate, or review..."
            disabled={dispatching}
            className="flex-1 bg-background border border-border rounded-xl px-4 py-3 text-sm focus:border-accent outline-none placeholder-gray-600"
          />
          <button
            type="submit"
            disabled={dispatching || !commandInput.trim()}
            className="px-5 py-3 bg-accent text-white rounded-xl text-sm font-medium hover:bg-accent-light transition disabled:opacity-50"
          >
            {dispatching ? 'Dispatching...' : 'Dispatch'}
          </button>
          <button
            type="button"
            onClick={() => setShowLauncher(true)}
            className="px-4 py-3 bg-surface-hover text-gray-300 rounded-xl text-sm hover:text-white transition"
          >
            Guided Launch
          </button>
          <button
            type="button"
            onClick={() => setActiveView('tasks')}
            className="px-4 py-3 bg-surface-hover text-gray-300 rounded-xl text-sm hover:text-white transition"
          >
            Queue
          </button>
        </form>
        {result && (
          <div className={cn(
            'mt-3 border rounded-lg px-3 py-2 text-xs',
            result.ok ? 'bg-green-500/10 border-green-500/20 text-green-400' : 'bg-red-500/10 border-red-500/20 text-red-400',
          )}>
            {result.message}
          </div>
        )}
      </div>

      <div className="grid grid-cols-5 gap-4">
        <StatCard label="Active agents" value={`${activeAgents.length}/${agents.length}`} icon="🤖" tone="blue" />
        <StatCard label="Running work" value={runningTasks.length} icon="⚡" tone="green" />
        <StatCard label="Needs input" value={pendingInbox.length} icon="📥" tone="purple" />
        <StatCard label="Failures" value={failedTasks.length} icon="⚠️" tone="red" />
        <StatCard label="Review" value={reviewTasks.length} icon="✅" tone="yellow" />
      </div>

      <HandoffPanel
        summary={handoffSummary}
        onOpenTask={setSelectedTaskId}
        onOpenInbox={() => setActiveView('inbox')}
        onOpenOrchestrator={() => setActiveView('orchestrator')}
        onOpenAudit={() => setActiveView('audit')}
        onOpenObserve={() => setActiveView('observability')}
        onReviewed={() => {
          void markHandoffReviewed(diagnostics).then(setHandoffCheckpoint);
        }}
      />

      <NotificationTriagePanel
        notifications={notifications}
        unreadCount={unreadCount}
        onOpenNotification={openNotification}
        onMarkRead={acknowledgeNotifications}
        onMarkAllRead={acknowledgeAllNotifications}
        busy={acknowledgingNotifications}
      />

      <div className="grid xl:grid-cols-[1.1fr_0.9fr] gap-6">
        <section className="space-y-6">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-400">Needs attention</h3>
              <button onClick={() => setActiveView('inbox')} className="text-[11px] text-gray-500 hover:text-gray-300">
                Open inbox
              </button>
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              {attentionItems.map(item => (
                <AttentionCard
                  key={item.key}
                  title={item.title}
                  subtitle={item.subtitle}
                  icon={item.icon}
                  tone={item.tone}
                  onClick={item.onClick}
                />
              ))}
              {attentionItems.length === 0 && (
                <div className="md:col-span-2 bg-surface border border-border rounded-xl py-10 text-center text-gray-600">
                  <div className="text-3xl mb-2 opacity-30">✨</div>
                  <p className="text-sm">No blockers right now</p>
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-400">Active work</h3>
              <button onClick={() => setActiveView('tasks')} className="text-[11px] text-gray-500 hover:text-gray-300">
                View queue
              </button>
            </div>
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              {runningTasks.slice(0, 8).map(task => (
                <WorkRow key={task.id} task={task} onOpen={() => setSelectedTaskId(task.id)} />
              ))}
              {runningTasks.length === 0 && (
                <div className="px-4 py-8 text-center text-gray-600 text-sm">No active tasks</div>
              )}
            </div>
          </div>
        </section>

        <aside className="space-y-6">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-400">Pipelines</h3>
              <button onClick={() => setActiveView('orchestrator')} className="text-[11px] text-gray-500 hover:text-gray-300">
                Orchestrator
              </button>
            </div>
            <div className="space-y-2">
              {activePipelines.slice(0, 5).map(pipeline => <PipelineRow key={pipeline.id} pipeline={pipeline} />)}
              {activePipelines.length === 0 && (
                <div className="bg-surface border border-border rounded-xl py-8 text-center text-gray-600 text-sm">
                  No active pipelines
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-400">Recent events</h3>
              <button onClick={() => setActiveView('observability')} className="text-[11px] text-gray-500 hover:text-gray-300">
                Observe
              </button>
            </div>
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              {platformEvents.slice(0, 8).map(event => <EventRow key={event.id} event={event} />)}
              {platformEvents.length === 0 && (
                <div className="px-4 py-8 text-center text-gray-600 text-sm">No events recorded yet</div>
              )}
            </div>
          </div>
        </aside>
      </div>

      <TaskDetailDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      {showLauncher && (
        <WorkLauncher
          initialInput={commandInput}
          onClose={() => setShowLauncher(false)}
          onCreated={async () => {
            setCommandInput('');
            await Promise.all([loadTasks(), loadPipelines(), loadPlatformEvents()]);
            await loadOperatorActions();
          }}
        />
      )}
    </div>
  );
}
