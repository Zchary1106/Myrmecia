import { useMemo, useState } from 'react';
import { useStore } from '../../stores/store';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import type { ExecutionMessage, QualityLoopAttempt, RunTrace, Task, TaskExecution, TraceSpan } from '@agent-factory/shared';

const statusClass: Record<string, string> = {
  pending: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
  queued: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
  assigned: 'bg-blue-500/15 text-blue-300 border-blue-500/20',
  running: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  review: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  done: 'bg-green-500/15 text-green-400 border-green-500/20',
  failed: 'bg-red-500/15 text-red-400 border-red-500/20',
  cancelled: 'bg-gray-500/15 text-gray-500 border-gray-500/20',
};

function messageIcon(type: ExecutionMessage['type']) {
  if (type === 'user_input') return '👤';
  if (type === 'agent_text') return '💬';
  if (type === 'tool_use') return '🔧';
  if (type === 'tool_result') return '📎';
  if (type === 'progress') return '📊';
  return '❌';
}

function spanIcon(type: string) {
  if (type === 'agent.start') return '🤖';
  if (type === 'prompt.build') return '🧩';
  if (type === 'model.route') return '🧠';
  if (type === 'llm.call') return '💬';
  if (type === 'tool.call') return '🔧';
  if (type === 'permission.check') return '🛡️';
  return '📍';
}

const spanStatusClass: Record<TraceSpan['status'], string> = {
  running: 'text-blue-300 bg-blue-500/10',
  done: 'text-emerald-300 bg-emerald-500/10',
  failed: 'text-red-300 bg-red-500/10',
  blocked: 'text-yellow-300 bg-yellow-500/10',
};

type TraceStatusFilter = 'all' | TraceSpan['status'];

function traceMetaText(span: TraceSpan | undefined, key: string): string | undefined {
  const value = span?.metadata?.[key];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function traceDuration(ms?: number) {
  if (ms === undefined) return '-';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function latestSpan(trace: RunTrace, type: string) {
  return [...trace.spans].reverse().find(span => span.type === type);
}

function TraceDiagnosticCards({ trace }: { trace: RunTrace }) {
  const modelSpan = latestSpan(trace, 'model.route');
  const promptSpan = latestSpan(trace, 'prompt.build');
  const llmSpan = latestSpan(trace, 'llm.call');
  const toolSpans = trace.spans.filter(span => span.type === 'tool.call');
  const blockedSpans = trace.spans.filter(span => span.status === 'blocked');
  const failedSpans = trace.spans.filter(span => span.status === 'failed' || span.error);
  const issueTone = failedSpans.length ? 'border-red-500/30 text-red-300' : blockedSpans.length ? 'border-yellow-500/30 text-yellow-300' : 'border-emerald-500/30 text-emerald-300';

  return (
    <div className="mb-3 grid grid-cols-2 gap-2">
      <TraceDiagnostic label="Model" value={traceMetaText(modelSpan, 'modelId') || '-'} detail={traceMetaText(modelSpan, 'reason') || traceMetaText(modelSpan, 'source') || 'route missing'} />
      <TraceDiagnostic label="Skill" value={traceMetaText(promptSpan, 'skillVersionId') || traceMetaText(promptSpan, 'skillId') || '-'} detail={traceMetaText(promptSpan, 'skillChecksum')?.slice(0, 12) || 'checksum missing'} />
      <TraceDiagnostic label="LLM" value={llmSpan?.status || '-'} detail={`${traceDuration(llmSpan?.durationMs)} · ${traceMetaText(llmSpan, 'costUSD') || '$0'}`} />
      <TraceDiagnostic label="Issues" value={`${failedSpans.length} failed`} detail={`${blockedSpans.length} blocked · ${toolSpans.length} tools`} className={issueTone} />
    </div>
  );
}

function TraceDiagnostic({ label, value, detail, className }: { label: string; value: string; detail: string; className?: string }) {
  return (
    <div className={cn('rounded-lg border border-border bg-background p-2', className)}>
      <div className="text-[9px] uppercase tracking-[0.16em] text-gray-600">{label}</div>
      <div className="mt-1 truncate text-xs font-semibold">{value}</div>
      <div className="mt-1 line-clamp-2 text-[10px] text-gray-500">{detail}</div>
    </div>
  );
}

function taskExecutionFor(task: Task, executions: TaskExecution[]) {
  return executions.find(execution => execution.taskId === task.id);
}

const qualityStatusClass: Record<QualityLoopAttempt['status'], string> = {
  reviewing: 'text-blue-400 bg-blue-500/10',
  approved: 'text-green-400 bg-green-500/10',
  needs_fix: 'text-yellow-400 bg-yellow-500/10',
  fixing: 'text-blue-300 bg-blue-500/10',
  fixed: 'text-purple-400 bg-purple-500/10',
  skipped: 'text-gray-500 bg-gray-500/10',
  failed: 'text-red-400 bg-red-500/10',
};

export function ExecutionTimeline() {
  const {
    tasks, executions, agents, executionMessages,
    selectedTaskId, setSelectedTaskId, qualityLoopAttempts,
    loadTasks, loadAgents, loadExecutions, loadExecutionMessages, loadQualityLoopAttempts,
  } = useStore();
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [selectedTrace, setSelectedTrace] = useState<RunTrace | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<TraceSpan | null>(null);
  const [traceQuery, setTraceQuery] = useState('');
  const [traceStatus, setTraceStatus] = useState<TraceStatusFilter>('all');
  const [traceType, setTraceType] = useState('all');
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const orderedTasks = useMemo(
    () => [...tasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tasks],
  );

  const selectedMessages = selectedExecutionId ? executionMessages[selectedExecutionId] || [] : [];
  const selectedTask = selectedTaskId ? tasks.find(task => task.id === selectedTaskId) : undefined;
  const selectedQualityAttempts = selectedTaskId ? qualityLoopAttempts[selectedTaskId] || [] : [];
  const traceTypes = useMemo(() => {
    if (!selectedTrace) return [];
    return Array.from(new Set(selectedTrace.spans.map(span => span.type))).sort();
  }, [selectedTrace]);
  const filteredTraceSpans = useMemo(() => {
    if (!selectedTrace) return [];
    const needle = traceQuery.trim().toLowerCase();
    return selectedTrace.spans.filter(span => {
      const issue = span.status === 'failed' || span.status === 'blocked' || Boolean(span.error);
      const haystack = [
        span.name,
        span.type,
        span.status,
        span.error,
        JSON.stringify(span.metadata || {}),
      ].filter(Boolean).join(' ').toLowerCase();
      return (!needle || haystack.includes(needle))
        && (traceStatus === 'all' || span.status === traceStatus)
        && (traceType === 'all' || span.type === traceType)
        && (!issuesOnly || issue);
    });
  }, [selectedTrace, traceQuery, traceStatus, traceType, issuesOnly]);

  const selectTask = async (task: Task, executionId?: string) => {
    setSelectedTaskId(task.id);
    setSelectedSpan(null);
    if (executionId) {
      setSelectedExecutionId(executionId);
      const [trace] = await Promise.all([
        api.executions.trace(executionId).catch(() => null),
        loadExecutionMessages(executionId),
      ]);
      setSelectedTrace(trace);
    } else {
      setSelectedExecutionId(null);
      setSelectedTrace(null);
    }
    await loadQualityLoopAttempts(task.id);
  };

  const clearTraceFilters = () => {
    setTraceQuery('');
    setTraceStatus('all');
    setTraceType('all');
    setIssuesOnly(false);
  };

  const refreshSnapshot = async () => {
    await Promise.all([loadTasks(), loadAgents(), loadExecutions()]);
    if (selectedTaskId) await loadQualityLoopAttempts(selectedTaskId);
  };

  const cancelTask = async (task: Task) => {
    if (!window.confirm(`Cancel task "${task.title}"? This stops queued/running work.`)) return;
    setBusyTaskId(task.id);
    setError(null);
    try {
      await api.tasks.cancel(task.id, true);
      await refreshSnapshot();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyTaskId(null);
    }
  };

  const retryTask = async (task: Task) => {
    setBusyTaskId(task.id);
    setError(null);
    try {
      await api.tasks.retry(task.id);
      await refreshSnapshot();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyTaskId(null);
    }
  };

  return (
    <div className="h-full flex">
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-xl font-bold">Execution Timeline</h2>
            <p className="text-[12px] text-gray-500 mt-0.5">
              Follow tasks, agent executions, and runtime messages in one trace.
            </p>
          </div>
          <button
            onClick={() => refreshSnapshot()}
            className="px-3 py-1.5 rounded-lg bg-surface-hover text-[11px] text-gray-400 hover:text-white transition"
          >
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {orderedTasks.map(task => {
            const execution = taskExecutionFor(task, executions);
            const agent = agents.find(a => a.id === (execution?.agentDefId || task.assigneeId));
            const selected = execution?.id === selectedExecutionId;

            return (
              <div
                key={task.id}
                onClick={() => selectTask(task, execution?.id)}
                className={cn(
                  'w-full text-left bg-surface border rounded-xl px-4 py-3 transition cursor-pointer',
                  selected || task.id === selectedTaskId ? 'border-accent ring-1 ring-accent/20' : 'border-border hover:border-accent/30',
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-1 flex flex-col items-center">
                    <div className={cn(
                      'w-2.5 h-2.5 rounded-full',
                      task.status === 'running' ? 'bg-blue-500 animate-pulse' :
                      task.status === 'done' ? 'bg-green-500' :
                      task.status === 'failed' ? 'bg-red-500' : 'bg-gray-500',
                    )} />
                    <div className="w-px h-12 bg-border mt-2" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={cn('px-2 py-0.5 rounded border text-[10px] font-medium', statusClass[task.status])}>
                        {task.status}
                      </span>
                      <span className="text-[10px] text-gray-600">{task.mode}</span>
                      {task.priority !== 'normal' && (
                        <span className="text-[10px] text-orange-400">{task.priority}</span>
                      )}
                    </div>

                    <div className="text-sm font-medium truncate">{task.title}</div>
                    <div className="text-[11px] text-gray-500 mt-1 line-clamp-2">{task.description}</div>

                    <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-600">
                      <span>{new Date(task.createdAt).toLocaleString()}</span>
                      {agent && <span>{agent.emoji} {agent.name}</span>}
                      {execution && (
                        <span>
                          {execution.status} · {execution.tokenCount} tokens · ${execution.costUSD.toFixed(4)}
                        </span>
                      )}
                      {!execution && <span>No execution yet</span>}
                    </div>

                    <div className="flex items-center gap-2 mt-3">
                      {['pending', 'queued', 'assigned', 'running'].includes(task.status) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void cancelTask(task);
                          }}
                          disabled={busyTaskId === task.id}
                          className="px-2.5 py-1 rounded bg-red-500/10 text-red-400 text-[10px] hover:bg-red-500/20 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      )}
                      {['failed', 'cancelled'].includes(task.status) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void retryTask(task);
                          }}
                          disabled={busyTaskId === task.id}
                          className="px-2.5 py-1 rounded bg-accent/10 text-accent-light text-[10px] hover:bg-accent/20 disabled:opacity-50"
                        >
                          Retry
                        </button>
                      )}
                      {busyTaskId === task.id && (
                        <span className="text-[10px] text-gray-600">Updating...</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {orderedTasks.length === 0 && (
            <div className="text-center py-16 text-gray-600">
              <div className="text-4xl mb-3 opacity-30">🧭</div>
              <p className="text-sm">No task timeline yet</p>
              <p className="text-[11px] text-gray-700 mt-1">Start a direct or orchestrated task to see the trace.</p>
            </div>
          )}
        </div>
      </div>

      <aside className="w-[360px] border-l border-border bg-surface overflow-y-auto">
        <div className="p-4 border-b border-border">
          <div className="text-sm font-semibold">Task trace</div>
          <div className="text-[11px] text-gray-500 mt-1">
            {selectedTask?.title || 'Select a task'}
          </div>
        </div>

        <div className="p-3 space-y-2">
          {selectedTrace && (
            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] font-semibold text-gray-500">Structured trace</div>
                <span className={cn(
                  'rounded px-1.5 py-0.5 text-[10px]',
                  selectedTrace.status === 'done' ? 'bg-emerald-500/10 text-emerald-300' :
                  selectedTrace.status === 'failed' ? 'bg-red-500/10 text-red-300' : 'bg-blue-500/10 text-blue-300',
                )}>
                  {selectedTrace.status}
                </span>
              </div>
              <div className="space-y-2">
                <TraceDiagnosticCards trace={selectedTrace} />
                <TraceFilters
                  query={traceQuery}
                  status={traceStatus}
                  type={traceType}
                  types={traceTypes}
                  issuesOnly={issuesOnly}
                  shown={filteredTraceSpans.length}
                  total={selectedTrace.spans.length}
                  onQueryChange={setTraceQuery}
                  onStatusChange={setTraceStatus}
                  onTypeChange={setTraceType}
                  onIssuesOnlyChange={setIssuesOnly}
                  onClear={clearTraceFilters}
                />
                {selectedSpan && (
                  <TraceSpanInspector span={selectedSpan} onClose={() => setSelectedSpan(null)} />
                )}
                {filteredTraceSpans.map(span => (
                  <button
                    key={span.id}
                    onClick={() => setSelectedSpan(span)}
                    className={cn(
                      'w-full bg-background border rounded-lg px-3 py-2 text-left transition hover:border-accent/30',
                      selectedSpan?.id === span.id ? 'border-accent/50 ring-1 ring-accent/20' : 'border-border',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span>{spanIcon(span.type)}</span>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">{span.name}</span>
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px]', spanStatusClass[span.status])}>{span.status}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-600">
                      <span>{span.type}</span>
                      {span.durationMs !== undefined && <span>{traceDuration(span.durationMs)}</span>}
                    </div>
                    {span.error && <div className="mt-2 line-clamp-2 text-[11px] text-red-300">{span.error}</div>}
                    {Object.keys(span.metadata || {}).length > 0 && (
                      <div className="mt-2 line-clamp-2 rounded bg-surface p-2 text-[10px] text-gray-500">
                        {JSON.stringify(span.metadata)}
                      </div>
                    )}
                  </button>
                ))}
                {filteredTraceSpans.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border bg-background p-6 text-center text-xs text-gray-600">
                    No spans match current filters
                  </div>
                )}
              </div>
            </div>
          )}

          {selectedTaskId && (
            <div className="mb-4">
              <div className="text-[11px] font-semibold text-gray-500 mb-2">Quality loop attempts</div>
              <div className="space-y-2">
                {selectedQualityAttempts.map(attempt => (
                  <div key={attempt.id} className="bg-background border border-border rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] text-gray-600">Round {attempt.iteration}</span>
                      <span className={cn('px-1.5 py-0.5 rounded text-[10px]', qualityStatusClass[attempt.status])}>
                        {attempt.status}
                      </span>
                    </div>
                    {attempt.reviewOutput && (
                      <div className="text-[11px] text-gray-400 line-clamp-3 whitespace-pre-wrap">
                        Review: {attempt.reviewOutput}
                      </div>
                    )}
                    {attempt.fixOutput && (
                      <div className="text-[11px] text-gray-400 line-clamp-3 whitespace-pre-wrap mt-1">
                        Fix: {attempt.fixOutput}
                      </div>
                    )}
                    {attempt.error && (
                      <div className="text-[11px] text-red-400 mt-1">{attempt.error}</div>
                    )}
                  </div>
                ))}
                {selectedQualityAttempts.length === 0 && (
                  <div className="text-center text-gray-600 text-xs py-4 bg-background border border-border rounded-lg">
                    No quality-loop attempts for this task
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="text-[11px] font-semibold text-gray-500 mb-2">Execution messages</div>
          {selectedMessages.map(message => (
            <div key={message.id} className="bg-background border border-border rounded-lg px-3 py-2">
              <div className="flex items-center gap-2 text-[10px] text-gray-600 mb-1">
                <span>{messageIcon(message.type)}</span>
                <span>{message.type}</span>
                {message.toolName && <span className="text-accent-light">{message.toolName}</span>}
              </div>
              <div className={cn(
                'text-[12px] whitespace-pre-wrap leading-relaxed',
                message.type === 'error' ? 'text-red-400' : 'text-gray-300',
              )}>
                {message.content}
              </div>
            </div>
          ))}

          {selectedExecutionId && selectedMessages.length === 0 && (
            <div className="text-center text-gray-600 text-sm py-8">No messages recorded yet</div>
          )}

          {!selectedExecutionId && (
            <div className="text-center text-gray-600 text-sm py-8">
              Select an execution to inspect its activity stream.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function TraceFilters({
  query,
  status,
  type,
  types,
  issuesOnly,
  shown,
  total,
  onQueryChange,
  onStatusChange,
  onTypeChange,
  onIssuesOnlyChange,
  onClear,
}: {
  query: string;
  status: TraceStatusFilter;
  type: string;
  types: string[];
  issuesOnly: boolean;
  shown: number;
  total: number;
  onQueryChange: (value: string) => void;
  onStatusChange: (value: TraceStatusFilter) => void;
  onTypeChange: (value: string) => void;
  onIssuesOnlyChange: (value: boolean) => void;
  onClear: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold text-gray-400">Span Explorer</div>
        <button onClick={onClear} className="text-[10px] text-gray-600 hover:text-gray-300">Clear</button>
      </div>
      <input
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        placeholder="Search span name, error, metadata..."
        className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-xs outline-none focus:border-accent"
      />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <select
          value={status}
          onChange={event => onStatusChange(event.target.value as TraceStatusFilter)}
          className="rounded-lg border border-border bg-surface px-2 py-2 text-xs outline-none focus:border-accent"
        >
          <option value="all">All statuses</option>
          <option value="running">running</option>
          <option value="done">done</option>
          <option value="failed">failed</option>
          <option value="blocked">blocked</option>
        </select>
        <select
          value={type}
          onChange={event => onTypeChange(event.target.value)}
          className="rounded-lg border border-border bg-surface px-2 py-2 text-xs outline-none focus:border-accent"
        >
          <option value="all">All types</option>
          {types.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
      <label className="mt-2 flex cursor-pointer items-center justify-between rounded-lg border border-border bg-surface px-2 py-2 text-xs text-gray-400">
        <span>Issues only</span>
        <input type="checkbox" checked={issuesOnly} onChange={event => onIssuesOnlyChange(event.target.checked)} />
      </label>
      <div className="mt-2 text-[10px] text-gray-600">{shown} / {total} spans shown</div>
    </div>
  );
}

function TraceSpanInspector({ span, onClose }: { span: TraceSpan; onClose: () => void }) {
  return (
    <div className="rounded-xl border border-accent/30 bg-background p-3 shadow-lg shadow-accent/5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-accent-light">Span Detail</div>
          <div className="mt-1 truncate text-sm font-semibold">{span.name}</div>
        </div>
        <button onClick={onClose} className="rounded bg-surface px-2 py-1 text-[10px] text-gray-500 hover:text-white">Close</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <TraceKeyValue label="Type" value={span.type} />
        <TraceKeyValue label="Status" value={span.status} />
        <TraceKeyValue label="Duration" value={traceDuration(span.durationMs)} />
        <TraceKeyValue label="Started" value={new Date(span.startedAt).toLocaleTimeString()} />
      </div>
      {span.error && (
        <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
          {span.error}
        </div>
      )}
      <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-border bg-surface p-2 text-[10px] text-gray-400">
        {JSON.stringify(span.metadata || {}, null, 2)}
      </pre>
      <div className="mt-2 truncate text-[10px] text-gray-600">span {span.id}</div>
      {span.parentSpanId && <div className="mt-1 truncate text-[10px] text-gray-600">parent {span.parentSpanId}</div>}
    </div>
  );
}

function TraceKeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-2">
      <div className="text-[9px] uppercase tracking-[0.14em] text-gray-600">{label}</div>
      <div className="mt-1 truncate text-[11px] text-gray-300">{value}</div>
    </div>
  );
}
