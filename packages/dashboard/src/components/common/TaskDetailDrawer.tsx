import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores/store';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { readOnlyControlMessage, runtimeControlsAllowed } from '../../lib/permissions';
import type { ExecutionMessage, LogEntry, OperatorAction, QualityLoopAttempt, Task } from '@agent-factory/shared';
import { SkillStepProgress } from '../tasks/SkillStepProgress';

type DetailTab = 'overview' | 'trace' | 'logs' | 'quality' | 'audit';

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

const qualityClass: Record<QualityLoopAttempt['status'], string> = {
  reviewing: 'bg-blue-500/10 text-blue-400',
  approved: 'bg-green-500/10 text-green-400',
  needs_fix: 'bg-yellow-500/10 text-yellow-400',
  fixing: 'bg-blue-500/10 text-blue-300',
  fixed: 'bg-purple-500/10 text-purple-400',
  skipped: 'bg-gray-500/10 text-gray-500',
  failed: 'bg-red-500/10 text-red-400',
};

function messageIcon(type: ExecutionMessage['type']) {
  if (type === 'user_input') return '👤';
  if (type === 'agent_text') return '💬';
  if (type === 'tool_use') return '🔧';
  if (type === 'tool_result') return '📎';
  if (type === 'progress') return '📊';
  return '❌';
}

function ActionSummary({ action }: { action: OperatorAction }) {
  return (
    <div className="bg-background border border-border rounded-lg px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold">{action.action}</span>
        <span className={cn(
          'px-1.5 py-0.5 rounded text-[10px]',
          action.status === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400',
        )}>
          {action.status}
        </span>
        <span className="ml-auto text-[10px] text-gray-600">{new Date(action.createdAt).toLocaleString()}</span>
      </div>
      <div className="mt-1 text-[11px] text-gray-500">
        {action.actor.id} · {action.actor.role} · {action.actor.source}
      </div>
    </div>
  );
}

function OverviewTab({ task, agentName }: { task: Task; agentName?: string }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <InfoCard label="Status" value={task.status} />
        <InfoCard label="Mode" value={task.mode} />
        <InfoCard label="Priority" value={task.priority} />
        <InfoCard label="Agent" value={agentName || task.assigneeId || 'Unassigned'} />
        <InfoCard label="Created" value={new Date(task.createdAt).toLocaleString()} />
        <InfoCard label="Retries" value={String(task.retryCount || 0)} />
      </div>

      {/* Skill Executor Step Progress */}
      {(task.status === 'running' || task.status === 'done' || task.status === 'failed') && (
        <SkillStepProgress taskId={task.id} />
      )}

      {task.description && (
        <section>
          <div className="text-[11px] font-semibold text-gray-500 mb-2">Description</div>
          <p className="bg-background border border-border rounded-lg p-3 text-sm text-gray-300 whitespace-pre-wrap">
            {task.description}
          </p>
        </section>
      )}

      {task.output && (
        <section>
          <div className="text-[11px] font-semibold text-gray-500 mb-2">Output</div>
          <pre className="bg-background border border-border rounded-lg p-3 text-xs text-gray-300 whitespace-pre-wrap overflow-auto max-h-64">
            {task.output}
          </pre>
        </section>
      )}

      {task.error && (
        <section>
          <div className="text-[11px] font-semibold text-red-400 mb-2">Error</div>
          <pre className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-300 whitespace-pre-wrap overflow-auto">
            {task.error}
          </pre>
        </section>
      )}
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background border border-border rounded-lg p-3 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">{label}</div>
      <div className="text-xs text-gray-300 truncate">{value}</div>
    </div>
  );
}

function TraceTab({ messages }: { messages: ExecutionMessage[] }) {
  return (
    <div className="space-y-2">
      {messages.map(message => (
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
      {messages.length === 0 && <EmptyState icon="🧭" text="No execution messages recorded yet" />}
    </div>
  );
}

function LogsTab({ logs }: { logs: LogEntry[] }) {
  return (
    <div className="bg-background rounded-lg border border-border overflow-hidden">
      {logs.map(log => (
        <div key={log.id} className="px-3 py-2 text-xs border-b border-border/50 last:border-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={cn(
              'font-mono uppercase text-[10px]',
              log.level === 'error' ? 'text-red-400' :
              log.level === 'warn' ? 'text-yellow-400' :
              log.level === 'debug' ? 'text-gray-500' : 'text-gray-300',
            )}>
              {log.level}
            </span>
            <span className="text-[10px] text-gray-600">{new Date(log.createdAt).toLocaleString()}</span>
          </div>
          <div className="font-mono text-gray-300 whitespace-pre-wrap">{log.message}</div>
        </div>
      ))}
      {logs.length === 0 && <EmptyState icon="📄" text="No task logs yet" />}
    </div>
  );
}

function QualityTab({ attempts }: { attempts: QualityLoopAttempt[] }) {
  return (
    <div className="space-y-2">
      {attempts.map(attempt => (
        <div key={attempt.id} className="bg-background border border-border rounded-lg px-3 py-2">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] text-gray-600">Round {attempt.iteration}</span>
            <span className={cn('px-1.5 py-0.5 rounded text-[10px]', qualityClass[attempt.status])}>
              {attempt.status}
            </span>
          </div>
          {attempt.reviewOutput && <AttemptBlock label="Review" value={attempt.reviewOutput} />}
          {attempt.fixOutput && <AttemptBlock label="Fix" value={attempt.fixOutput} />}
          {attempt.error && <AttemptBlock label="Error" value={attempt.error} tone="error" />}
        </div>
      ))}
      {attempts.length === 0 && <EmptyState icon="✅" text="No quality-loop attempts for this task" />}
    </div>
  );
}

function AttemptBlock({ label, value, tone }: { label: string; value: string; tone?: 'error' }) {
  return (
    <div className="mt-2">
      <div className={cn('text-[10px] font-semibold mb-1', tone === 'error' ? 'text-red-400' : 'text-gray-500')}>
        {label}
      </div>
      <div className={cn('text-[11px] whitespace-pre-wrap', tone === 'error' ? 'text-red-300' : 'text-gray-400')}>
        {value}
      </div>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="text-center py-10 text-gray-600">
      <div className="text-3xl mb-2 opacity-30">{icon}</div>
      <p className="text-sm">{text}</p>
    </div>
  );
}

export function TaskDetailDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const {
    tasks, agents, executions, executionMessages, qualityLoopAttempts, operatorActions,
    diagnostics,
    loadTasks, loadExecutions, loadExecutionMessages, loadQualityLoopAttempts, loadOperatorActions,
  } = useStore();
  const [tab, setTab] = useState<DetailTab>('overview');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const task = taskId ? tasks.find(item => item.id === taskId) : undefined;
  const execution = taskId ? executions.find(item => item.taskId === taskId) : undefined;
  const messages = execution ? executionMessages[execution.id] || [] : [];
  const attempts = taskId ? qualityLoopAttempts[taskId] || [] : [];
  const taskActions = taskId ? operatorActions.filter(action => action.taskId === taskId || action.targetId === taskId) : [];
  const canControl = runtimeControlsAllowed(diagnostics);
  const agent = useMemo(
    () => agents.find(item => item.id === (execution?.agentDefId || task?.assigneeId)),
    [agents, execution?.agentDefId, task?.assigneeId],
  );

  useEffect(() => {
    if (!taskId) return;
    setTab('overview');
    setError(null);
    void loadTasks();
    void loadExecutions();
    void loadQualityLoopAttempts(taskId);
    void loadOperatorActions();
    api.tasks.logs(taskId).then(setLogs).catch((err: Error) => setError(err.message));
  }, [taskId]);

  useEffect(() => {
    if (execution) void loadExecutionMessages(execution.id);
  }, [execution?.id]);

  if (!taskId) return null;

  const refresh = async () => {
    await Promise.all([loadTasks(), loadExecutions(), loadQualityLoopAttempts(taskId), loadOperatorActions()]);
    setLogs(await api.tasks.logs(taskId));
  };

  const runTaskAction = async (action: 'cancel' | 'retry') => {
    if (!task) return;
    if (action === 'cancel' && !window.confirm(`Cancel task "${task.title}"? This stops queued/running work.`)) return;
    setBusyAction(action);
    setError(null);
    try {
      if (action === 'cancel') await api.tasks.cancel(task.id, true);
      if (action === 'retry') await api.tasks.retry(task.id);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-[520px] max-w-[calc(100vw-2rem)] bg-surface border-l border-border shadow-2xl flex flex-col">
      <div className="p-4 border-b border-border">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              {task && (
                <span className={cn('px-2 py-0.5 rounded border text-[10px] font-medium', statusClass[task.status])}>
                  {task.status}
                </span>
              )}
              {execution && <span className="text-[10px] text-gray-600">{execution.status} execution</span>}
            </div>
            <h3 className="font-bold text-base truncate">{task?.title || taskId}</h3>
            <p className="text-[11px] text-gray-500 mt-1">
              {agent ? `${agent.emoji || '🤖'} ${agent.name}` : 'No agent assigned'} · {task?.mode || 'unknown'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition">✕</button>
        </div>

        {task && (
          <div className="flex items-center gap-2 mt-4">
            {['pending', 'queued', 'assigned', 'running'].includes(task.status) && (
              <button
                onClick={() => void runTaskAction('cancel')}
                disabled={!!busyAction || !canControl}
                title={canControl ? undefined : readOnlyControlMessage}
                className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 text-[11px] hover:bg-red-500/20 disabled:opacity-50"
              >
                {busyAction === 'cancel' ? 'Cancelling...' : 'Cancel'}
              </button>
            )}
            {['failed', 'cancelled'].includes(task.status) && (
              <button
                onClick={() => void runTaskAction('retry')}
                disabled={!!busyAction || !canControl}
                title={canControl ? undefined : readOnlyControlMessage}
                className="px-3 py-1.5 rounded-lg bg-accent/10 text-accent-light text-[11px] hover:bg-accent/20 disabled:opacity-50"
              >
                {busyAction === 'retry' ? 'Retrying...' : 'Retry'}
              </button>
            )}
            <button
              onClick={() => void refresh()}
              className="px-3 py-1.5 rounded-lg bg-surface-hover text-gray-400 text-[11px] hover:text-white"
            >
              Refresh
            </button>
            {!canControl && (
              <span className="text-[10px] text-yellow-400">{readOnlyControlMessage}</span>
            )}
          </div>
        )}
      </div>

      <div className="px-4 pt-3 border-b border-border">
        <div className="flex gap-1 overflow-x-auto">
          {(['overview', 'trace', 'logs', 'quality', 'audit'] as const).map(item => (
            <button
              key={item}
              onClick={() => setTab(item)}
              className={cn(
                'px-3 py-2 text-[11px] capitalize border-b-2 transition',
                tab === item ? 'border-accent text-accent-light' : 'border-transparent text-gray-500 hover:text-gray-300',
              )}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {!task && <EmptyState icon="📋" text="Task not found in the current workspace snapshot" />}
        {task && tab === 'overview' && <OverviewTab task={task} agentName={agent?.name} />}
        {task && tab === 'trace' && <TraceTab messages={messages} />}
        {task && tab === 'logs' && <LogsTab logs={logs} />}
        {task && tab === 'quality' && <QualityTab attempts={attempts} />}
        {task && tab === 'audit' && (
          <div className="space-y-2">
            {taskActions.map(action => <ActionSummary key={action.id} action={action} />)}
            {taskActions.length === 0 && <EmptyState icon="🧾" text="No operator actions recorded for this task" />}
          </div>
        )}
      </div>
    </div>
  );
}
