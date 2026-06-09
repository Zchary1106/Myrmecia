import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores/store';
import { cn } from '../../lib/utils';
import { FilterBar, FilterEmptyState, FilterResultSummary, HighlightChip, SavedViewControls, SearchInput, SelectFilter } from '../common/FilterControls';
import { TaskDetailDrawer } from '../common/TaskDetailDrawer';
import { createSavedView, loadSavedViews, persistSavedViews, savedViewScope, type SavedView } from '../../lib/savedViews';
import type { PlatformEvent } from '@myrmecia/shared';

const severityClass: Record<PlatformEvent['severity'], string> = {
  info: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  warn: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  error: 'bg-red-500/10 text-red-400 border-red-500/20',
};

function MetricCard({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'warn' | 'error' }) {
  return (
    <div className={cn(
      'bg-surface border border-border rounded-xl p-4',
      tone === 'warn' && 'border-yellow-500/20',
      tone === 'error' && 'border-red-500/20',
    )}>
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}

type SeverityFilter = 'all' | PlatformEvent['severity'];
interface EventFilters {
  query: string;
  severity: SeverityFilter;
}

function EventRow({ event, onOpenTask }: { event: PlatformEvent; onOpenTask: (taskId: string) => void }) {
  return (
    <div className="bg-surface border border-border rounded-xl px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className={cn('px-2 py-0.5 rounded border text-[10px] font-medium', severityClass[event.severity])}>
          {event.severity}
        </span>
        <span className="text-xs font-medium">{event.eventType}</span>
        <span className="text-[10px] text-gray-600 ml-auto">{new Date(event.createdAt).toLocaleString()}</span>
      </div>
      <div className="flex flex-wrap gap-2 text-[10px] text-gray-600">
        {event.taskId && <HighlightChip tone="accent" onClick={() => onOpenTask(event.taskId!)}>task: {event.taskId}</HighlightChip>}
        {event.pipelineId && <HighlightChip>pipeline: {event.pipelineId}</HighlightChip>}
        {event.agentId && <HighlightChip>agent: {event.agentId}</HighlightChip>}
        {event.executionId && <HighlightChip>execution: {event.executionId}</HighlightChip>}
      </div>
    </div>
  );
}

export function ObservabilityView() {
  const { observability, platformEvents, diagnostics, loadObservability, loadPlatformEvents } = useStore();
  const [query, setQuery] = useState('');
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [savedViews, setSavedViews] = useState<SavedView<EventFilters>[]>([]);
  const scope = savedViewScope(diagnostics);

  useEffect(() => {
    void loadObservability();
    void loadPlatformEvents();
  }, []);

  useEffect(() => {
    let active = true;
    void loadSavedViews<EventFilters>('observability', scope).then(views => {
      if (active) setSavedViews(views);
    });
    return () => { active = false; };
  }, [scope]);

  const refresh = async () => {
    await Promise.all([loadObservability(), loadPlatformEvents()]);
  };

  const filteredEvents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return platformEvents.filter(event => {
      const haystack = [
        event.eventType,
        event.severity,
        event.taskId,
        event.pipelineId,
        event.agentId,
        event.executionId,
        event.inboxEntryId,
        JSON.stringify(event.payload || {}),
      ].filter(Boolean).join(' ').toLowerCase();
      return (!needle || haystack.includes(needle))
        && (severity === 'all' || event.severity === severity);
    });
  }, [platformEvents, query, severity]);

  const currentFilters: EventFilters = { query, severity };
  const applyFilters = (filters: EventFilters) => {
    setQuery(filters.query);
    setSeverity(filters.severity);
  };
  const clearFilters = () => {
    applyFilters({ query: '', severity: 'all' });
  };
  const saveCurrentView = () => {
    const name = window.prompt('Name this Observability view');
    if (!name?.trim()) return;
    const next = [createSavedView(name.trim(), currentFilters), ...savedViews].slice(0, 12);
    setSavedViews(next);
    void persistSavedViews('observability', scope, next);
  };
  const deleteSavedView = (id: string) => {
    const next = savedViews.filter(view => view.id !== id);
    setSavedViews(next);
    void persistSavedViews('observability', scope, next);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Observability</h2>
          <p className="text-[12px] text-gray-500 mt-0.5">
            Durable event history, failure hotspots, retries, and pipeline health.
          </p>
        </div>
        <button
          onClick={() => refresh()}
          className="px-3 py-1.5 rounded-lg bg-surface-hover text-[11px] text-gray-400 hover:text-white transition"
        >
          Refresh
        </button>
      </div>

      {observability && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard label="Events" value={observability.totals.events} />
            <MetricCard label="Failed tasks" value={observability.totals.failedTasks} tone="error" />
            <MetricCard label="Retried tasks" value={observability.totals.retriedTasks} tone="warn" />
            <MetricCard label="Failed pipelines" value={observability.totals.failedPipelines} tone="error" />
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <section className="bg-surface border border-border rounded-xl p-4">
              <h3 className="text-sm font-semibold mb-3">Failure hotspots</h3>
              <div className="space-y-2">
                {observability.failureHotspots.map(item => (
                  <button
                    key={item.taskId}
                    onClick={() => setSelectedTaskId(item.taskId)}
                    className="w-full text-left bg-background border border-border rounded-lg px-3 py-2 hover:border-accent/30 transition"
                  >
                    <div className="text-xs font-medium truncate">{item.title}</div>
                    <div className="text-[10px] text-gray-600 mt-1">{item.count} error events</div>
                  </button>
                ))}
                {observability.failureHotspots.length === 0 && (
                  <div className="text-xs text-gray-600 py-6 text-center">No failure hotspots</div>
                )}
              </div>
            </section>

            <section className="bg-surface border border-border rounded-xl p-4">
              <h3 className="text-sm font-semibold mb-3">Retry hotspots</h3>
              <div className="space-y-2">
                {observability.retryHotspots.map(item => (
                  <button
                    key={item.taskId}
                    onClick={() => setSelectedTaskId(item.taskId)}
                    className="w-full text-left bg-background border border-border rounded-lg px-3 py-2 hover:border-accent/30 transition"
                  >
                    <div className="text-xs font-medium truncate">{item.title}</div>
                    <div className="text-[10px] text-gray-600 mt-1">{item.retryCount} retries · {item.status}</div>
                  </button>
                ))}
                {observability.retryHotspots.length === 0 && (
                  <div className="text-xs text-gray-600 py-6 text-center">No retry hotspots</div>
                )}
              </div>
            </section>

            <section className="bg-surface border border-border rounded-xl p-4">
              <h3 className="text-sm font-semibold mb-3">Pipeline health</h3>
              <div className="space-y-2">
                {observability.pipelineHealth.map(item => (
                  <div key={item.status} className="flex items-center justify-between bg-background border border-border rounded-lg px-3 py-2">
                    <span className="text-xs">{item.status}</span>
                    <span className="text-xs text-gray-400">{item.count}</span>
                  </div>
                ))}
                {observability.pipelineHealth.length === 0 && (
                  <div className="text-xs text-gray-600 py-6 text-center">No pipelines yet</div>
                )}
              </div>
            </section>
          </div>
        </>
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-400">Recent events</h3>
          <FilterResultSummary shown={filteredEvents.length} total={platformEvents.length} onClear={clearFilters} />
        </div>
        <SavedViewControls
          builtInViews={[
            { id: 'errors', name: 'Error events', filters: { query: '', severity: 'error' } },
            { id: 'warnings', name: 'Warnings', filters: { query: '', severity: 'warn' } },
            { id: 'task-events', name: 'Task events', filters: { query: 'task', severity: 'all' } },
            { id: 'pipeline-events', name: 'Pipeline events', filters: { query: 'pipeline', severity: 'all' } },
          ]}
          savedViews={savedViews}
          onApply={applyFilters}
          onSaveCurrent={saveCurrentView}
          onDeleteSaved={deleteSavedView}
        />
        <FilterBar>
          <SearchInput value={query} onChange={setQuery} placeholder="Search event type, task id, pipeline id, payload..." />
          <SelectFilter
            label="Severity"
            value={severity}
            onChange={setSeverity}
            options={[
              { value: 'all', label: 'All' },
              { value: 'info', label: 'Info' },
              { value: 'warn', label: 'Warn' },
              { value: 'error', label: 'Error' },
            ]}
          />
        </FilterBar>
        <div className="space-y-2">
          {filteredEvents.map(event => <EventRow key={event.id} event={event} onOpenTask={setSelectedTaskId} />)}
          {platformEvents.length === 0 && (
            <div className="text-center py-16 text-gray-600">
              <div className="text-4xl mb-3 opacity-30">📈</div>
              <p className="text-sm">No platform events recorded yet</p>
            </div>
          )}
          {platformEvents.length > 0 && filteredEvents.length === 0 && (
            <FilterEmptyState title="No events match these filters" detail="Try another severity, event type, task id, or payload term." />
          )}
        </div>
      </section>

      <TaskDetailDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
    </div>
  );
}
