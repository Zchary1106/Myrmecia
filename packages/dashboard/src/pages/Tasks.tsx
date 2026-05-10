import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores/store';
import { cn } from '../lib/utils';
import { TaskDetailDrawer } from '../components/common/TaskDetailDrawer';
import { FilterBar, FilterEmptyState, FilterResultSummary, SavedViewControls, SearchInput, SelectFilter } from '../components/common/FilterControls';
import { createSavedView, loadSavedViews, persistSavedViews, savedViewScope, type SavedView } from '../lib/savedViews';
import { WorkLauncher } from '../components/common/WorkLauncher';
import type { AgentSummary, Priority, Task, TaskMode, TaskStatus } from '@agent-factory/shared';

const columns = [
  { key: 'pending', label: 'Pending', color: 'border-gray-500', statuses: ['pending', 'queued', 'assigned'] },
  { key: 'running', label: 'Running', color: 'border-blue-500', statuses: ['running'] },
  { key: 'review', label: 'Review', color: 'border-purple-500', statuses: ['review'] },
  { key: 'failed', label: 'Failed', color: 'border-red-500', statuses: ['failed'] },
  { key: 'done', label: 'Done', color: 'border-green-500', statuses: ['done'] },
  { key: 'cancelled', label: 'Cancelled', color: 'border-gray-600', statuses: ['cancelled'] },
];

type StatusFilter = 'all' | TaskStatus;
type ModeFilter = 'all' | TaskMode;
type PriorityFilter = 'all' | Priority;
interface TaskFilters {
  query: string;
  status: StatusFilter;
  mode: ModeFilter;
  priority: PriorityFilter;
}

export function TasksPage() {
  const { tasks, agents, diagnostics, loadTasks } = useStore();
  const [showModal, setShowModal] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [priority, setPriority] = useState<PriorityFilter>('all');
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
        && (status === 'all' || task.status === status)
        && (mode === 'all' || task.mode === mode)
        && (priority === 'all' || task.priority === priority);
    });
  }, [tasks, query, status, mode, priority]);

  const clearFilters = () => {
    applyFilters({ query: '', status: 'all', mode: 'all', priority: 'all' });
  };

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Work Queue</h2>
          <p className="text-[12px] text-gray-500 mt-0.5">Filter tasks by state, mode, priority, or text.</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-light transition"
        >
          + Launch Work
        </button>
      </div>

      <div className="mb-4 space-y-2">
        <SavedViewControls
          builtInViews={[
            { id: 'failed', name: 'Failed tasks', filters: { query: '', status: 'failed', mode: 'all', priority: 'all' } },
            { id: 'running', name: 'Running now', filters: { query: '', status: 'running', mode: 'all', priority: 'all' } },
            { id: 'review', name: 'Needs review', filters: { query: '', status: 'review', mode: 'all', priority: 'all' } },
            { id: 'urgent', name: 'Urgent priority', filters: { query: '', status: 'all', mode: 'all', priority: 'urgent' } },
            { id: 'pipeline', name: 'Pipeline work', filters: { query: '', status: 'all', mode: 'pipeline', priority: 'all' } },
          ]}
          savedViews={savedViews}
          onApply={applyFilters}
          onSaveCurrent={saveCurrentView}
          onDeleteSaved={deleteSavedView}
        />
        <FilterBar>
          <SearchInput value={query} onChange={setQuery} placeholder="Search title, description, ids, output, errors..." />
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
        </FilterBar>
        <FilterResultSummary shown={filteredTasks.length} total={tasks.length} onClear={clearFilters} />
      </div>

      {/* Kanban Board */}
      <div className="flex-1 flex gap-4 overflow-x-auto">
        {columns.map(col => {
          const colTasks = filteredTasks.filter(t => col.statuses.includes(t.status));
          return (
            <div key={col.key} className="flex-1 min-w-[260px]">
              <div className={cn('flex items-center gap-2 mb-3 pb-2 border-b-2', col.color)}>
                <span className="text-sm font-semibold">{col.label}</span>
                <span className="text-xs text-gray-500 bg-surface px-2 py-0.5 rounded-full">{colTasks.length}</span>
              </div>
              <div className="space-y-2">
                {colTasks.map(task => (
                  <TaskCard key={task.id} task={task} agents={agents} onClick={() => setSelectedTaskId(task.id)} />
                ))}
                {colTasks.length === 0 && (
                  <div className="border border-dashed border-border rounded-lg py-8 text-center text-[11px] text-gray-700">
                    No matching tasks
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {tasks.length > 0 && filteredTasks.length === 0 && (
        <FilterEmptyState title="No tasks match these filters" detail="Clear filters or search for another task id, title, agent, or error." />
      )}

      {showModal && <WorkLauncher onClose={() => setShowModal(false)} onCreated={() => loadTasks()} />}

      {/* Task Detail Panel */}
      <TaskDetailDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
    </div>
  );
}

function TaskCard({ task, agents, onClick }: { task: Task; agents: AgentSummary[]; onClick: () => void }) {
  const agent = agents.find(a => a.id === task.assigneeId);
  const priorityColors: Record<string, string> = {
    urgent: 'text-red-400', high: 'text-orange-400', normal: 'text-gray-400', low: 'text-gray-600',
  };
  return (
    <div
      onClick={onClick}
      className="bg-surface border border-border rounded-lg p-3 cursor-pointer hover:border-accent/30 transition"
    >
      <div className="flex items-start gap-2">
        <span className={cn('text-xs mt-0.5', priorityColors[task.priority] || 'text-gray-400')}>●</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{task.title}</div>
          <div className="text-xs text-gray-500 mt-1">{task.mode}</div>
        </div>
      </div>
      {agent && (
        <div className="flex items-center gap-1 mt-2 text-xs text-gray-500">
          <span>{agent.emoji}</span>
          <span>{agent.name}</span>
        </div>
      )}
    </div>
  );
}
