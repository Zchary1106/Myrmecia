import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores/store';
import { cn } from '../../lib/utils';
import { FilterBar, FilterEmptyState, FilterResultSummary, HighlightChip, SavedViewControls, SearchInput, SelectFilter } from '../common/FilterControls';
import { TaskDetailDrawer } from '../common/TaskDetailDrawer';
import { createSavedView, loadSavedViews, persistSavedViews, savedViewScope, type SavedView } from '../../lib/savedViews';
import type { OperatorAction } from '@agent-factory/shared';

const statusClass: Record<OperatorAction['status'], string> = {
  success: 'bg-green-500/10 text-green-400 border-green-500/20',
  failed: 'bg-red-500/10 text-red-400 border-red-500/20',
};

const targetIcons: Record<OperatorAction['targetType'], string> = {
  task: '📋',
  pipeline: '🔗',
  inbox: '📥',
  system: '⚙️',
  agent: '🤖',
  tool: '🧰',
  skill: '📚',
  model: '🧠',
  template: '🧩',
};

type TargetFilter = 'all' | OperatorAction['targetType'];
type StatusFilter = 'all' | OperatorAction['status'];
interface AuditFilters {
  query: string;
  targetType: TargetFilter;
  status: StatusFilter;
}

function ActionRow({ action, onOpenTask }: { action: OperatorAction; onOpenTask: (taskId: string) => void }) {
  return (
    <div className="bg-surface border border-border rounded-xl px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-sm">
          {targetIcons[action.targetType]}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold">{action.action}</span>
            <span className={cn('px-2 py-0.5 rounded border text-[10px]', statusClass[action.status])}>
              {action.status}
            </span>
            <span className="text-[10px] text-gray-600 ml-auto">{new Date(action.createdAt).toLocaleString()}</span>
          </div>
          <div className="text-[11px] text-gray-500">
            {action.actor.id} · {action.actor.role} · {action.actor.source}
          </div>
          <div className="flex flex-wrap gap-2 mt-2 text-[10px] text-gray-600">
            <HighlightChip>{action.targetType}: {action.targetId || 'n/a'}</HighlightChip>
            {action.taskId && <HighlightChip tone="accent" onClick={() => onOpenTask(action.taskId!)}>task: {action.taskId}</HighlightChip>}
            {action.pipelineId && <HighlightChip>pipeline: {action.pipelineId}</HighlightChip>}
            {action.inboxEntryId && <HighlightChip>inbox: {action.inboxEntryId}</HighlightChip>}
          </div>
          {Object.keys(action.metadata).length > 0 && (
            <details className="mt-2">
              <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-300">Metadata</summary>
              <pre className="mt-1 bg-background border border-border rounded-lg p-2 text-[10px] text-gray-400 overflow-x-auto">
                {JSON.stringify(action.metadata, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

export function AuditView() {
  const { operatorActions, diagnostics, loadOperatorActions } = useStore();
  const [query, setQuery] = useState('');
  const [targetType, setTargetType] = useState<TargetFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [savedViews, setSavedViews] = useState<SavedView<AuditFilters>[]>([]);
  const scope = savedViewScope(diagnostics);

  useEffect(() => {
    void loadOperatorActions();
  }, []);

  useEffect(() => {
    let active = true;
    void loadSavedViews<AuditFilters>('audit', scope).then(views => {
      if (active) setSavedViews(views);
    });
    return () => { active = false; };
  }, [scope]);

  const currentFilters: AuditFilters = { query, targetType, status };
  const applyFilters = (filters: AuditFilters) => {
    setQuery(filters.query);
    setTargetType(filters.targetType);
    setStatus(filters.status);
  };
  const saveCurrentView = () => {
    const name = window.prompt('Name this Audit view');
    if (!name?.trim()) return;
    const next = [createSavedView(name.trim(), currentFilters), ...savedViews].slice(0, 12);
    setSavedViews(next);
    void persistSavedViews('audit', scope, next);
  };
  const deleteSavedView = (id: string) => {
    const next = savedViews.filter(view => view.id !== id);
    setSavedViews(next);
    void persistSavedViews('audit', scope, next);
  };

  const filteredActions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return operatorActions.filter(action => {
      const metadata = JSON.stringify(action.metadata || {});
      const haystack = [
        action.action,
        action.actor.id,
        action.actor.role,
        action.actor.source,
        action.targetType,
        action.targetId,
        action.taskId,
        action.pipelineId,
        action.inboxEntryId,
        metadata,
      ].filter(Boolean).join(' ').toLowerCase();
      return (!needle || haystack.includes(needle))
        && (targetType === 'all' || action.targetType === targetType)
        && (status === 'all' || action.status === status);
    });
  }, [operatorActions, query, targetType, status]);

  const clearFilters = () => {
    applyFilters({ query: '', targetType: 'all', status: 'all' });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Audit History</h2>
          <p className="text-[12px] text-gray-500 mt-0.5">
            Durable operator action provenance for controls and human decisions.
          </p>
        </div>
        <button
          onClick={() => loadOperatorActions()}
          className="px-3 py-1.5 rounded-lg bg-surface-hover text-[11px] text-gray-400 hover:text-white transition"
        >
          Refresh
        </button>
      </div>

      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="text-sm font-semibold mb-3">Role model</h3>
        <div className="grid md:grid-cols-3 gap-3 text-[12px]">
          <div className="bg-background border border-border rounded-lg p-3">
            <div className="font-semibold">admin</div>
            <div className="text-gray-500 mt-1">Default local/token operator with full control provenance.</div>
          </div>
          <div className="bg-background border border-border rounded-lg p-3">
            <div className="font-semibold">operator</div>
            <div className="text-gray-500 mt-1">Reserved for future scoped runtime control access.</div>
          </div>
          <div className="bg-background border border-border rounded-lg p-3">
            <div className="font-semibold">viewer</div>
            <div className="text-gray-500 mt-1">Reserved for future read-only remote dashboards.</div>
          </div>
        </div>
      </div>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-400">Recent actions</h3>
          <FilterResultSummary shown={filteredActions.length} total={operatorActions.length} onClear={clearFilters} />
        </div>
        <SavedViewControls
          builtInViews={[
            { id: 'my-actions', name: 'My actions', filters: { query: diagnostics?.operator.actor.id || '', targetType: 'all', status: 'all' } },
            { id: 'task-actions', name: 'Task controls', filters: { query: '', targetType: 'task', status: 'all' } },
            { id: 'platform-config', name: 'Platform config', filters: { query: '', targetType: 'agent', status: 'all' } },
            { id: 'failed-actions', name: 'Failed actions', filters: { query: '', targetType: 'all', status: 'failed' } },
          ]}
          savedViews={savedViews}
          onApply={applyFilters}
          onSaveCurrent={saveCurrentView}
          onDeleteSaved={deleteSavedView}
        />
        <FilterBar>
          <SearchInput value={query} onChange={setQuery} placeholder="Search action, actor, target id, metadata..." />
          <SelectFilter
            label="Target"
            value={targetType}
            onChange={setTargetType}
            options={[
              { value: 'all', label: 'All' },
              { value: 'task', label: 'Task' },
              { value: 'pipeline', label: 'Pipeline' },
              { value: 'inbox', label: 'Inbox' },
              { value: 'system', label: 'System' },
              { value: 'agent', label: 'Agent' },
              { value: 'tool', label: 'Tool' },
              { value: 'skill', label: 'Skill' },
              { value: 'model', label: 'Model' },
              { value: 'template', label: 'Template' },
            ]}
          />
          <SelectFilter
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All' },
              { value: 'success', label: 'Success' },
              { value: 'failed', label: 'Failed' },
            ]}
          />
        </FilterBar>
        <div className="space-y-2">
          {filteredActions.map(action => <ActionRow key={action.id} action={action} onOpenTask={setSelectedTaskId} />)}
          {operatorActions.length === 0 && (
            <div className="text-center py-16 text-gray-600">
              <div className="text-4xl mb-3 opacity-30">🧾</div>
              <p className="text-sm">No operator actions recorded yet</p>
            </div>
          )}
          {operatorActions.length > 0 && filteredActions.length === 0 && (
            <FilterEmptyState title="No audit actions match these filters" detail="Try a different actor, target type, task id, or action name." />
          )}
        </div>
      </section>

      <TaskDetailDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
    </div>
  );
}
