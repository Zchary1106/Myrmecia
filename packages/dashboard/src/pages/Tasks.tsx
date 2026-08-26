import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from '../stores/store';
import { cn } from '../lib/utils';
import { TaskDetailDrawer } from '../components/common/TaskDetailDrawer';
import { FilterEmptyState, FilterResultSummary, SavedViewControls, SelectFilter } from '../components/common/FilterControls';
import { createSavedView, loadSavedViews, persistSavedViews, savedViewScope, type SavedView } from '../lib/savedViews';
import { WorkLauncher } from '../components/common/WorkLauncher';
import type { Priority, Task, TaskMode, TaskStatus } from '@myrmecia/shared';
import { AlertTriangle, CheckCircle2, Clock3, Layers3, ListTodo, Play, Plus, Search, UserRound } from 'lucide-react';

type StatusFilter = 'all' | 'attention' | TaskStatus;
type ModeFilter = 'all' | TaskMode;
type PriorityFilter = 'all' | Priority;
interface TaskFilters {
  query: string;
  status: StatusFilter;
  mode: ModeFilter;
  priority: PriorityFilter;
}

const attentionStatuses: TaskStatus[] = ['waiting_for_tool', 'review'];

function relativeTime(value: string): string {
  const delta = Math.max(0, Date.now() - new Date(value).getTime());
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hr ago`;
  return `${Math.floor(delta / 86_400_000)} d ago`;
}

function taskDuration(task: Task): string {
  if (!task.startedAt) return '—';
  const end = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - new Date(task.startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function updatedAt(task: Task): string {
  return task.completedAt || task.startedAt || task.createdAt;
}

const statusTone: Record<TaskStatus, string> = {
  pending: 'bg-gray-500/10 text-gray-500',
  queued: 'bg-amber-500/10 text-amber-500',
  assigned: 'bg-blue-500/10 text-blue-500',
  running: 'bg-emerald-500/10 text-emerald-500',
  waiting_for_tool: 'bg-violet-500/10 text-violet-500',
  review: 'bg-violet-500/10 text-violet-500',
  done: 'bg-emerald-500/10 text-emerald-500',
  failed: 'bg-red-500/10 text-red-500',
  cancelled: 'bg-gray-500/10 text-gray-500',
};

export function TasksPage() {
  const { tasks, agents, diagnostics, loadTasks } = useStore();
  const [showModal, setShowModal] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [priority, setPriority] = useState<PriorityFilter>('all');
  const [page, setPage] = useState(1);
  const [savedViews, setSavedViews] = useState<SavedView<TaskFilters>[]>([]);
  const scope = savedViewScope(diagnostics);

  useEffect(() => {
    let active = true;
    void loadSavedViews<TaskFilters>('work-queue', scope).then(views => {
      if (active) setSavedViews(views);
    });
    return () => { active = false; };
  }, [scope]);

  const currentFilters: TaskFilters = { query, status, mode, priority };
  const applyFilters = (filters: TaskFilters) => {
    setQuery(filters.query);
    setStatus(filters.status);
    setMode(filters.mode);
    setPriority(filters.priority);
  };
  const saveCurrentView = () => {
    const name = window.prompt('Name this Work Queue view');
    if (!name?.trim()) return;
    const next = [createSavedView(name.trim(), currentFilters), ...savedViews].slice(0, 12);
    setSavedViews(next);
    void persistSavedViews('work-queue', scope, next);
  };
  const deleteSavedView = (id: string) => {
    const next = savedViews.filter(view => view.id !== id);
    setSavedViews(next);
    void persistSavedViews('work-queue', scope, next);
  };

  const filteredTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasks.filter(task => {
      const haystack = [
        task.title,
        task.description,
        task.input,
        task.output,
        task.error,
        task.id,
        task.assigneeId,
        task.pipelineId,
      ].filter(Boolean).join(' ').toLowerCase();
      return (!needle || haystack.includes(needle))
        && (status === 'all' || (status === 'attention' ? attentionStatuses.includes(task.status) : task.status === status))
        && (mode === 'all' || task.mode === mode)
        && (priority === 'all' || task.priority === priority);
    }).sort((a, b) => new Date(updatedAt(b)).getTime() - new Date(updatedAt(a)).getTime());
  }, [tasks, query, status, mode, priority]);

  const clearFilters = () => {
    applyFilters({ query: '', status: 'all', mode: 'all', priority: 'all' });
  };
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(filteredTasks.length / pageSize));
  const pageTasks = filteredTasks.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => { setPage(1); }, [query, status, mode, priority]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  return (
    <div className="app-page-shell min-h-full space-y-6 p-6">
      <div className="page-heading-row flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-[-0.03em]">Work Queue</h1>
          <p className="mt-1 text-[12px] text-gray-500">Monitor and manage all Agent work across your workspace.</p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <label className="relative min-w-0 flex-1 sm:w-[320px]">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-muted" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search tasks, workflows, or agents…" className="w-full rounded-xl border border-border bg-surface py-2.5 pl-9 pr-3 text-xs text-app-primary outline-none transition focus:border-accent/50" />
          </label>
          <button onClick={() => setShowModal(true)} className="home-primary-button app-focus inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold text-white"><Plus size={14} /> Launch Work</button>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <QueueMetric icon={<Layers3 size={17} />} label="All tasks" value={tasks.length} detail="total recorded work" />
        <QueueMetric icon={<Play size={17} />} label="Running" value={tasks.filter(task => task.status === 'running').length} detail="active execution" tone="green" />
        <QueueMetric icon={<Clock3 size={17} />} label="Queued" value={tasks.filter(task => ['pending', 'queued', 'assigned'].includes(task.status)).length} detail="waiting to start" tone="amber" />
        <QueueMetric icon={<ListTodo size={17} />} label="Needs input" value={tasks.filter(task => attentionStatuses.includes(task.status)).length} detail="tool or review gate" tone="violet" />
        <QueueMetric icon={<AlertTriangle size={17} />} label="Failed" value={tasks.filter(task => task.status === 'failed').length} detail="requires attention" tone="red" />
      </section>

      <section>
        <div className="flex flex-col gap-3 border-b border-border lg:flex-row lg:items-center lg:justify-between">
          <div className="flex gap-5 overflow-x-auto">
            {([
              ['all', 'All tasks', tasks.length],
              ['running', 'Running', tasks.filter(task => task.status === 'running').length],
              ['attention', 'Needs input', tasks.filter(task => attentionStatuses.includes(task.status)).length],
              ['failed', 'Failed', tasks.filter(task => task.status === 'failed').length],
            ] as const).map(([id, label, count]) => <button key={id} type="button" onClick={() => setStatus(id)} className={cn('app-focus shrink-0 border-b-2 px-1 pb-3 text-xs font-medium transition', status === id ? 'border-accent text-accent-light' : 'border-transparent text-app-muted hover:text-app-primary')}>{label}<span className="ml-1.5 rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px]">{count}</span></button>)}
          </div>
          <div className="flex flex-wrap gap-2 pb-3">
          <SelectFilter
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All' },
              { value: 'pending', label: 'Pending' },
              { value: 'queued', label: 'Queued' },
              { value: 'assigned', label: 'Assigned' },
              { value: 'running', label: 'Running' },
              { value: 'waiting_for_tool', label: 'Waiting for tool' },
              { value: 'review', label: 'Review' },
              { value: 'failed', label: 'Failed' },
              { value: 'done', label: 'Done' },
              { value: 'cancelled', label: 'Cancelled' },
            ]}
          />
          <SelectFilter
            label="Mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'all', label: 'All' },
              { value: 'master', label: 'Master' },
              { value: 'direct', label: 'Direct' },
              { value: 'pipeline', label: 'Pipeline' },
            ]}
          />
          <SelectFilter
            label="Priority"
            value={priority}
            onChange={setPriority}
            options={[
              { value: 'all', label: 'All' },
              { value: 'urgent', label: 'Urgent' },
              { value: 'high', label: 'High' },
              { value: 'normal', label: 'Normal' },
              { value: 'low', label: 'Low' },
            ]}
          />
          </div>
        </div>

        <details className="mt-3">
          <summary className="app-focus w-fit cursor-pointer rounded-lg px-2 py-1 text-[10px] font-medium text-app-muted hover:bg-surface-hover hover:text-app-primary">Saved views & presets</summary>
          <div className="mt-2">
            <SavedViewControls
              builtInViews={[
                { id: 'failed', name: 'Failed tasks', filters: { query: '', status: 'failed', mode: 'all', priority: 'all' } },
                { id: 'running', name: 'Running now', filters: { query: '', status: 'running', mode: 'all', priority: 'all' } },
                { id: 'review', name: 'Needs review', filters: { query: '', status: 'attention', mode: 'all', priority: 'all' } },
                { id: 'urgent', name: 'Urgent priority', filters: { query: '', status: 'all', mode: 'all', priority: 'urgent' } },
                { id: 'pipeline', name: 'Pipeline work', filters: { query: '', status: 'all', mode: 'pipeline', priority: 'all' } },
              ]}
              savedViews={savedViews}
              onApply={applyFilters}
              onSaveCurrent={saveCurrentView}
              onDeleteSaved={deleteSavedView}
            />
          </div>
        </details>
      </section>

      <section className="premium-card overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] border-collapse text-left">
            <thead><tr className="border-b border-border text-[10px] font-medium text-app-muted"><th className="px-4 py-3">Task</th><th className="px-3 py-3">Workflow</th><th className="px-3 py-3">Agent</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Priority</th><th className="px-3 py-3">Duration</th><th className="px-4 py-3">Updated</th></tr></thead>
            <tbody>
              {pageTasks.map(task => {
                const agent = agents.find(item => item.id === task.assigneeId);
                return <tr key={task.id} onClick={() => setSelectedTaskId(task.id)} className={cn('group cursor-pointer border-b border-border/70 transition last:border-0 hover:bg-accent/[0.035]', selectedTaskId === task.id && 'bg-accent/[0.055]')}>
                  <td className="relative px-4 py-3.5"><span className={cn('absolute inset-y-0 left-0 w-0.5', task.status === 'failed' ? 'bg-red-400' : attentionStatuses.includes(task.status) ? 'bg-violet-400' : task.status === 'running' ? 'bg-emerald-400' : task.status === 'done' ? 'bg-blue-400' : 'bg-amber-400')} /><div className="max-w-[320px] truncate text-xs font-semibold text-app-primary">{task.title}</div><div className="mt-1 max-w-[320px] truncate text-[9px] text-app-muted">#{task.id.slice(0, 8)} · {task.description || task.mode}</div></td>
                  <td className="px-3 py-3.5"><span className="inline-flex max-w-[160px] items-center gap-1 rounded-md bg-accent/8 px-2 py-1 text-[9px] text-accent-light"><GitBranchIcon /> <span className="truncate">{task.pipelineId ? task.pipelineId.slice(0, 12) : task.mode}</span></span></td>
                  <td className="px-3 py-3.5"><div className="flex items-center gap-2"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[11px]">{agent?.emoji || <UserRound size={12} />}</span><div className="min-w-0"><div className="max-w-[130px] truncate text-[10px] font-medium text-app-primary">{agent?.name || task.assigneeId || 'Unassigned'}</div><div className="text-[9px] text-app-muted">{agent?.role || task.mode}</div></div></div></td>
                  <td className="px-3 py-3.5"><span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[9px] font-medium capitalize', statusTone[task.status])}><span className="h-1.5 w-1.5 rounded-full bg-current" />{task.status.replaceAll('_', ' ')}</span></td>
                  <td className="px-3 py-3.5"><span className={cn('text-[10px] font-medium capitalize', task.priority === 'urgent' ? 'text-red-500' : task.priority === 'high' ? 'text-orange-500' : task.priority === 'low' ? 'text-emerald-500' : 'text-app-secondary')}>{task.priority}</span></td>
                  <td className="px-3 py-3.5 text-[10px] tabular-nums text-app-secondary">{taskDuration(task)}</td>
                  <td className="px-4 py-3.5 text-[10px] text-app-muted">{relativeTime(updatedAt(task))}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        <footer className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <FilterResultSummary shown={filteredTasks.length} total={tasks.length} onClear={clearFilters} />
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={page === 1} className="app-focus rounded-lg border border-border px-2.5 py-1.5 text-[10px] text-app-muted disabled:opacity-35">‹</button>
            {Array.from({ length: Math.min(pageCount, 5) }, (_, index) => {
              const start = Math.min(Math.max(1, page - 2), Math.max(1, pageCount - 4));
              const number = start + index;
              return <button key={number} type="button" onClick={() => setPage(number)} className={cn('app-focus h-7 min-w-7 rounded-lg border px-2 text-[10px]', page === number ? 'border-accent bg-accent/10 text-accent-light' : 'border-border text-app-muted hover:text-app-primary')}>{number}</button>;
            })}
            <button type="button" onClick={() => setPage(current => Math.min(pageCount, current + 1))} disabled={page === pageCount} className="app-focus rounded-lg border border-border px-2.5 py-1.5 text-[10px] text-app-muted disabled:opacity-35">›</button>
            <span className="ml-2 text-[9px] text-app-muted">{pageSize} / page · newest first</span>
          </div>
        </footer>
      </section>

      {tasks.length > 0 && filteredTasks.length === 0 && (
        <FilterEmptyState title="No tasks match these filters" detail="Clear filters or search for another task id, title, agent, or error." />
      )}

      {showModal && <WorkLauncher onClose={() => setShowModal(false)} onCreated={() => loadTasks()} />}

      {/* Task Detail Panel */}
      <TaskDetailDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
    </div>
  );
}

function QueueMetric({ icon, label, value, detail, tone = 'blue' }: { icon: ReactNode; label: string; value: number; detail: string; tone?: 'blue' | 'green' | 'violet' | 'amber' | 'red' }) {
  const toneClass = { blue: 'bg-blue-500/10 text-blue-500', green: 'bg-emerald-500/10 text-emerald-500', violet: 'bg-violet-500/10 text-violet-500', amber: 'bg-amber-500/10 text-amber-500', red: 'bg-red-500/10 text-red-500' }[tone];
  return <div className="premium-card flex min-h-[112px] items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4"><div className="min-w-0"><div className="text-[10px] font-medium text-app-muted">{label}</div><div className="mt-2 text-2xl font-semibold tabular-nums tracking-[-0.04em] text-app-primary">{value}</div><div className="mt-1 truncate text-[9px] text-app-muted">{detail}</div></div><span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl', toneClass)}>{icon}</span></div>;
}

function GitBranchIcon() {
  return <span aria-hidden="true">◇</span>;
}
