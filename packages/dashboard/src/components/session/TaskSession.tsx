import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowUpRight, Bot, Check, ChevronRight, CircleAlert, Clock3, FolderOpen, MessageSquareText, Send, Sparkles, Wrench } from 'lucide-react';
import type { AgentSummary, ExecutionMessage, Task, TaskExecution } from '@myrmecia/shared';
import { cn } from '../../lib/utils';
import { useStore } from '../../stores/store';
import { StructuredTaskResult, looksLikeStructuredResult } from '../common/StructuredTaskResult';
import { api } from '../../lib/api';

type ConversationEntry = {
  id: string;
  task: Task;
  execution?: TaskExecution;
  agent?: AgentSummary;
  message: ExecutionMessage;
};

type StreamingEntry = {
  execution: TaskExecution;
  task: Task;
  agent: AgentSummary | undefined;
  content: string;
};

type SessionListItem = {
  id: string;
  task: Task;
  title: string;
  activity: Task;
};

const activeStatuses: Task['status'][] = ['running', 'waiting_for_tool', 'review', 'assigned', 'queued', 'pending'];

function taskStatusLabel(status: Task['status']): string {
  const labels: Record<Task['status'], string> = {
    pending: 'Preparing',
    queued: 'Routing',
    assigned: 'Assigned',
    running: 'In progress',
    waiting_for_tool: 'Waiting for a tool',
    review: 'In review',
    done: 'Completed',
    failed: 'Needs attention',
    cancelled: 'Cancelled',
  };
  return labels[status];
}

function taskStatusTone(status: Task['status']): string {
  if (status === 'done') return 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-500';
  if (status === 'failed' || status === 'cancelled') return 'border-red-400/25 bg-red-400/[0.08] text-red-500';
  if (status === 'review') return 'border-violet-400/25 bg-violet-400/[0.08] text-violet-500';
  return 'border-accent/25 bg-accent/[0.08] text-accent-light';
}

function humanTaskTitle(task: Task): string {
  if (/^test:/i.test(task.title)) return 'Quality check';
  if (/^review:/i.test(task.title)) return 'Review';
  return task.title;
}

function teamTargetFromTask(task: Task): string | undefined {
  return task.mode === 'master' && !task.parentTaskId
    ? task.title.match(/^(.+? Team):\s/)?.[1]
    : undefined;
}

function isInternalPlanningTask(task: Task, tasks: Task[]): boolean {
  return task.title.startsWith('Plan: ')
    && tasks.some(candidate => candidate.id !== task.id && `Plan: ${candidate.title}` === task.title);
}

function isDescendantTask(candidate: Task, rootTaskId: string, tasksById: Map<string, Task>): boolean {
  const visited = new Set<string>();
  let parentTaskId = candidate.parentTaskId;
  while (parentTaskId && !visited.has(parentTaskId)) {
    if (parentTaskId === rootTaskId) return true;
    visited.add(parentTaskId);
    parentTaskId = tasksById.get(parentTaskId)?.parentTaskId;
  }
  return false;
}

function rootTask(task: Task, tasksById: Map<string, Task>): Task {
  const visited = new Set<string>();
  let current = task;
  while (current.parentTaskId && !visited.has(current.parentTaskId)) {
    const parent = tasksById.get(current.parentTaskId);
    if (!parent) break;
    visited.add(parent.id);
    current = parent;
  }
  return current;
}

function taskActivityForTasks(sessionTasks: Task[], fallback: Task): Task {
  const byNewest = (left: Task, right: Task) => new Date(right.completedAt || right.startedAt || right.createdAt).getTime()
    - new Date(left.completedAt || left.startedAt || left.createdAt).getTime();

  const active = sessionTasks.filter(task => activeStatuses.includes(task.status)).sort(byNewest)[0];
  if (active) return active;

  return sessionTasks
    .filter(task => task.output || task.error || ['done', 'failed', 'cancelled'].includes(task.status))
    .sort(byNewest)[0] || fallback;
}

function taskExecutionFor(taskId: string, executions: TaskExecution[]): TaskExecution | undefined {
  return executions
    .filter(execution => execution.taskId === taskId)
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())[0];
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function messageLabel(entry: ConversationEntry): string {
  if (entry.message.type === 'progress') return 'Agent activity';
  if (entry.message.type === 'error') return 'Execution issue';
  if (entry.message.type === 'tool_result') return entry.message.toolName ? `Tool result · ${entry.message.toolName}` : 'Tool result';
  return entry.agent?.name || 'Agent response';
}

export function TaskSession() {
  const {
    tasks,
    pipelines,
    agents,
    executions,
    executionMessages,
    streamingResponses,
    selectedTaskId,
    setSelectedTaskId,
    loadTasks,
    loadAgents,
    loadExecutions,
    loadExecutionMessages,
    setActiveView,
  } = useStore();

  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find(task => task.id === selectedTaskId) : undefined)
      || tasks.find(task => activeStatuses.includes(task.status))
      || tasks[0],
    [selectedTaskId, tasks],
  );
  const tasksById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  const root = useMemo(() => selectedTask ? rootTask(selectedTask, tasksById) : undefined, [selectedTask, tasksById]);
  const routedTeam = root ? teamTargetFromTask(root) : undefined;
  const relatedTasks = useMemo(() => {
    if (!root || !selectedTask) return [];
    if (selectedTask.pipelineId) {
      return tasks
        .filter(task => task.pipelineId === selectedTask.pipelineId)
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    }
    return tasks
      .filter(task => task.id === root.id || isDescendantTask(task, root.id, tasksById))
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  }, [root, selectedTask, tasks, tasksById]);
  const relatedTaskIds = useMemo(() => new Set(relatedTasks.map(task => task.id)), [relatedTasks]);
  const sessionRoots = useMemo(() => {
    const groups = new Map<string, Task[]>();
    for (const task of tasks) {
      // The Master creates a standalone planning execution to satisfy the
      // execution foreign key. Its useful output is copied to the parent task,
      // so it must not appear as a second user-facing conversation.
      if (isInternalPlanningTask(task, tasks)) continue;
      const key = task.pipelineId ? `pipeline:${task.pipelineId}` : `task:${rootTask(task, tasksById).id}`;
      const group = groups.get(key) || [];
      group.push(task);
      groups.set(key, group);
    }

    return [...groups.entries()]
      .map(([id, sessionTasks]): SessionListItem => {
        const activity = taskActivityForTasks(sessionTasks, sessionTasks[0]);
        const pipelineId = sessionTasks[0].pipelineId;
        const rootTaskForSession = pipelineId
          ? activity
          : rootTask(sessionTasks[0], tasksById);
        const pipeline = pipelineId ? pipelines.find(item => item.id === pipelineId) : undefined;

        return {
          id,
          task: rootTaskForSession,
          title: pipeline?.name || humanTaskTitle(rootTaskForSession),
          activity,
        };
      })
      .sort((left, right) => {
        const leftActive = activeStatuses.includes(left.activity.status);
        const rightActive = activeStatuses.includes(right.activity.status);
        if (leftActive !== rightActive) return leftActive ? -1 : 1;
        return new Date(right.activity.completedAt || right.activity.startedAt || right.activity.createdAt).getTime()
          - new Date(left.activity.completedAt || left.activity.startedAt || left.activity.createdAt).getTime();
      });
  }, [pipelines, tasks, tasksById]);
  const selectedSessionId = selectedTask
    ? selectedTask.pipelineId
      ? `pipeline:${selectedTask.pipelineId}`
      : `task:${root?.id || selectedTask.id}`
    : undefined;
  const relatedExecutions = useMemo(
    () => executions.filter(execution => relatedTaskIds.has(execution.taskId)),
    [executions, relatedTaskIds],
  );
  const streamingEntries = useMemo(() => relatedExecutions
    .map(execution => {
      const content = streamingResponses[execution.id];
      const task = tasksById.get(execution.taskId);
      if (!content || !task) return null;
      return {
        execution,
        task,
        agent: agents.find(agent => agent.id === execution.agentDefId || agent.id === task.assigneeId),
        content,
      };
    })
    .filter((entry): entry is StreamingEntry => Boolean(entry)),
  [agents, relatedExecutions, streamingResponses, tasksById]);
  const activeTask = useMemo(() => {
    for (const status of activeStatuses) {
      const match = relatedTasks.find(task => task.status === status && task.id !== root?.id);
      if (match) return match;
    }
    return relatedTasks.find(task => task.status === 'running') || root;
  }, [relatedTasks, root]);
  const activeAgent = activeTask?.assigneeId ? agents.find(agent => agent.id === activeTask.assigneeId) : undefined;
  const activeExecution = activeTask ? taskExecutionFor(activeTask.id, relatedExecutions) : undefined;
  const [followUp, setFollowUp] = useState('');
  const [followUpBusy, setFollowUpBusy] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([loadTasks(), loadAgents(), loadExecutions()]);
  }, [loadAgents, loadExecutions, loadTasks]);

  const executionIds = relatedExecutions.map(execution => execution.id).join('|');
  useEffect(() => {
    if (!executionIds) return;
    void Promise.all(relatedExecutions.map(execution => loadExecutionMessages(execution.id)));
  }, [executionIds, loadExecutionMessages, relatedExecutions]);

  const conversation = useMemo(() => {
    const entries: ConversationEntry[] = [];
    for (const execution of relatedExecutions) {
      const task = tasksById.get(execution.taskId);
      if (!task) continue;
      const agent = agents.find(item => item.id === execution.agentDefId || item.id === task.assigneeId);
      for (const message of executionMessages[execution.id] || []) {
        if (message.type === 'user_input' || message.type === 'tool_use') continue;
        entries.push({ id: `${execution.id}:${message.id}`, task, execution, agent, message });
      }
    }

    const finalOutputTasks = relatedTasks.filter(task => task.output || task.error);
    for (const task of finalOutputTasks) {
      // A failed planning task can still contain the Master's useful
      // clarification. Prefer that real response over a terse technical error.
      const output = task.output || task.error;
      if (!output) continue;
      const alreadyShown = entries.some(entry =>
        entry.task.id === task.id
        && (entry.message.content === output || output.startsWith(entry.message.content) || entry.message.content.startsWith(output)),
      );
      if (!alreadyShown) {
        const execution = taskExecutionFor(task.id, relatedExecutions);
        entries.push({
          id: `task-result:${task.id}`,
          task,
          execution,
          agent: task.assigneeId
            ? agents.find(item => item.id === task.assigneeId)
            : task.mode === 'master'
              ? agents.find(item => item.id === 'master' || item.role === 'orchestrator')
              : undefined,
          message: {
            id: -1,
            executionId: execution?.id || '',
            type: task.error && !task.output ? 'error' : 'agent_text',
            content: output,
            createdAt: task.completedAt || task.startedAt || task.createdAt,
          },
        });
      }
    }

    return entries.sort((left, right) => new Date(left.message.createdAt).getTime() - new Date(right.message.createdAt).getTime());
  }, [agents, executionMessages, relatedExecutions, relatedTasks, tasksById]);

  const submitFollowUp = async (event: FormEvent) => {
    event.preventDefault();
    const content = followUp.trim();
    if (!content || !activeExecution || activeExecution.status !== 'running' || followUpBusy) return;
    setFollowUpBusy(true);
    setFollowUpError(null);
    try {
      await api.executions.sendMessage(activeExecution.id, content, 'user_follow_up');
      setFollowUp('');
      await loadExecutionMessages(activeExecution.id);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : 'Unable to send follow-up instruction.');
    } finally {
      setFollowUpBusy(false);
    }
  };

  if (!root) {
    return (
      <main className="app-page-shell flex min-h-full items-center justify-center p-6">
        <section className="app-panel max-w-md p-7 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/10 text-accent-light"><MessageSquareText size={20} /></span>
          <h1 className="mt-4 text-lg font-semibold tracking-[-0.02em] text-app-primary">No task conversation yet</h1>
          <p className="mt-2 text-sm leading-6 text-app-secondary">Start a task from Home. Its user request, Agent updates, and final result will appear here.</p>
          <button type="button" onClick={() => setActiveView('command')} className="app-focus mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-accent-light hover:text-app-primary">
            Go to Home <ArrowUpRight size={15} />
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-page-shell min-h-full p-4 lg:p-6">
      <header className="mb-5 flex flex-col gap-4 border-b border-border/70 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-light">Task session</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.035em] text-app-primary">Your conversation with the team</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-app-secondary">See what you asked, who owns the next step, and the real output as work completes.</p>
        </div>
        <button type="button" onClick={() => setActiveView('timeline')} className="app-focus inline-flex w-fit items-center gap-1.5 text-xs font-medium text-app-muted transition hover:text-app-primary">
          Open technical timeline <ArrowUpRight size={14} />
        </button>
      </header>

      <div className="grid min-h-[calc(100vh-12rem)] gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="Task conversation" className="app-panel flex min-h-[560px] min-w-0 flex-col overflow-hidden">
          <header className="border-b border-border/70 px-5 py-4 sm:px-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-app-muted">Your request</div>
                <h2 className="mt-1 max-w-3xl text-pretty text-base font-semibold leading-6 text-app-primary">{root.input || root.description || root.title}</h2>
              </div>
              <span className={cn('inline-flex shrink-0 items-center rounded-lg border px-2.5 py-1 text-[11px] font-medium', taskStatusTone(activeTask?.status || root.status))}>
                {taskStatusLabel(activeTask?.status || root.status)}
              </span>
            </div>
          </header>

          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-6 sm:px-6">
            <article className="ml-auto max-w-[88%] rounded-2xl rounded-tr-md bg-accent px-4 py-3 text-sm leading-6 text-white shadow-[0_12px_28px_rgb(var(--color-accent)/.18)]">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-white/70">You</div>
              <p className="whitespace-pre-wrap">{root.input || root.description || root.title}</p>
              <time className="mt-2 block text-[10px] text-white/65">{formatTime(root.createdAt)}</time>
            </article>

            <article className="max-w-[88%] rounded-2xl rounded-tl-md border border-accent/20 bg-accent/[0.055] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent/12 text-accent-light"><Sparkles size={13} /></span>
                <div className="text-xs font-semibold text-app-primary">Master Agent</div>
              </div>
              <p className="mt-2 text-sm leading-6 text-app-secondary">
                {activeAgent
                  ? routedTeam && (activeAgent.id === 'master' || activeAgent.role === 'orchestrator')
                    ? `${activeAgent.name} is planning work for ${routedTeam}.`
                    : `The current step is assigned to ${activeAgent.name} (${activeAgent.role}).`
                  : routedTeam
                    ? `Your request is being prepared for ${routedTeam}.`
                  : activeTask?.status === 'queued' || activeTask?.status === 'pending'
                    ? 'Your request is being routed to the right specialist.'
                    : 'The task is being coordinated through its next execution step.'}
              </p>
            </article>

            {conversation.map(entry => {
              const isUserFollowUp = entry.message.type === 'user_follow_up';
              const isAgentReply = entry.message.type === 'agent_text';
              const isError = entry.message.type === 'error';
              const isToolResult = entry.message.type === 'tool_result';
              const content = entry.message.content;
              if (!content) return null;

              if (isUserFollowUp) {
                return (
                  <article key={entry.id} className="ml-auto max-w-[88%] rounded-2xl rounded-tr-md bg-accent px-4 py-3 text-sm leading-6 text-white shadow-[0_10px_24px_rgb(var(--color-accent)/.15)]">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-white/70">You · follow-up</div>
                    <p className="whitespace-pre-wrap">{content}</p>
                    <time className="mt-2 block text-[10px] text-white/65">{formatTime(entry.message.createdAt)}</time>
                  </article>
                );
              }

              if (isToolResult) {
                return (
                  <details key={entry.id} className="group rounded-xl border border-border/70 bg-background/35 px-3 py-2.5 text-xs">
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-app-muted transition group-open:text-app-secondary">
                      <Wrench size={13} /> {messageLabel(entry)} <ChevronRight size={13} className="ml-auto transition group-open:rotate-90" />
                    </summary>
                    <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-3 text-[11px] leading-5 text-app-secondary">{entry.message.content}</pre>
                  </details>
                );
              }

              if (!isAgentReply) {
                return (
                  <article key={entry.id} className={cn('max-w-[88%] rounded-xl border px-3.5 py-3 text-xs leading-5', isError ? 'border-red-400/25 bg-red-400/[0.055] text-red-500' : 'border-border/70 bg-background/40 text-app-secondary')}>
                    <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.11em] text-app-muted">
                      {isError ? <CircleAlert size={13} className="text-red-500" /> : <Clock3 size={13} />}
                      {messageLabel(entry)}
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap">{content}</p>
                  </article>
                );
              }

              return (
                <article key={entry.id} className="max-w-[88%] rounded-2xl rounded-tl-md border border-border bg-surface px-4 py-3 shadow-[0_8px_24px_rgb(39_51_77_/_0.05)]">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-surface-hover text-app-secondary"><Bot size={13} /></span>
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-app-primary">{messageLabel(entry)}</div>
                      <div className="text-[10px] text-app-muted">{humanTaskTitle(entry.task)} · {formatTime(entry.message.createdAt)}</div>
                    </div>
                  </div>
                  {looksLikeStructuredResult(content) ? (
                    <div className="mt-3"><StructuredTaskResult output={content} /></div>
                  ) : (
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-app-secondary">{content}</p>
                  )}
                </article>
              );
            })}

            {streamingEntries.map(entry => (
              <article key={`streaming:${entry.execution.id}`} aria-live="polite" className="max-w-[88%] rounded-2xl rounded-tl-md border border-accent/25 bg-accent/[0.045] px-4 py-3 shadow-[0_8px_24px_rgb(var(--color-accent)/.08)]">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent/12 text-accent-light"><Bot size={13} /></span>
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-app-primary">{entry.agent?.name || 'Agent'}</div>
                    <div className="flex items-center gap-1.5 text-[10px] text-accent-light"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> Writing a response</div>
                  </div>
                </div>
                {looksLikeStructuredResult(entry.content) ? (
                  <div className="mt-3"><StructuredTaskResult output={entry.content} compact /></div>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-app-secondary">{entry.content}<span className="ml-0.5 inline-block h-4 w-1 animate-pulse align-[-2px] bg-accent" aria-label="Generating" /></p>
                )}
              </article>
            ))}

            {conversation.length === 0 && streamingEntries.length === 0 && (
              <div className="flex max-w-[88%] items-center gap-3 rounded-2xl border border-dashed border-border bg-background/35 px-4 py-4 text-sm text-app-secondary">
                <Clock3 size={16} className="shrink-0 text-accent-light" />
                <span>{activeTask?.status === 'failed' ? 'The task stopped before an Agent response was recorded.' : 'Waiting for the first real Agent update…'}</span>
              </div>
            )}
          </div>

          <div className="border-t border-border/70 bg-background/25 px-5 py-4 sm:px-6">
            {activeExecution?.status === 'running' ? (
              <form onSubmit={event => void submitFollowUp(event)} aria-label="Send follow-up instruction">
                <div className="flex gap-2">
                  <input
                    value={followUp}
                    onChange={event => { setFollowUp(event.target.value); setFollowUpError(null); }}
                    placeholder={`Add an instruction for ${activeAgent?.name || 'the current Agent'}…`}
                    aria-label="Follow-up instruction"
                    className="app-focus min-w-0 flex-1 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm text-app-primary outline-none placeholder:text-app-muted transition focus:border-accent"
                    disabled={followUpBusy}
                  />
                  <button type="submit" disabled={!followUp.trim() || followUpBusy} className="app-focus inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3.5 text-xs font-semibold text-white transition hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-40">
                    {followUpBusy ? 'Sending…' : <><Send size={14} /> Send</>}
                  </button>
                </div>
                <p className="mt-2 text-[10px] leading-4 text-app-muted">The current Agent receives this at its next model turn. It is added to this task’s recorded conversation.</p>
                {followUpError && <p className="mt-1.5 text-[11px] text-red-500" role="alert">{followUpError}</p>}
              </form>
            ) : (
              <p className="text-xs text-app-muted">This execution is not currently accepting follow-up instructions.</p>
            )}
          </div>
        </section>

        <aside aria-label="Task context" className="space-y-4">
          <section className="app-panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
              <div>
                <div className="text-xs font-semibold text-app-primary">Task sessions</div>
                <div className="mt-0.5 text-[10px] text-app-muted">{sessionRoots.length} conversations</div>
              </div>
              <MessageSquareText size={15} className="text-app-muted" aria-hidden="true" />
            </div>
            <div className="max-h-[250px] divide-y divide-border/70 overflow-y-auto">
              {sessionRoots.map(({ id, task, title, activity }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSelectedTaskId(task.id)}
                  aria-current={id === selectedSessionId ? 'page' : undefined}
                  className={cn(
                    'app-focus flex w-full items-center gap-2.5 px-4 py-3 text-left transition hover:bg-surface-hover',
                    id === selectedSessionId && 'bg-accent/[0.055]',
                  )}
                >
                  <span className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    activity.status === 'done' ? 'bg-emerald-400' :
                    activity.status === 'failed' || activity.status === 'cancelled' ? 'bg-red-400' :
                    activity.status === 'review' ? 'bg-violet-400' : 'bg-accent',
                  )} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-app-primary">{title}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-app-muted">{taskStatusLabel(activity.status)} · {formatTime(activity.completedAt || activity.startedAt || activity.createdAt)}</span>
                  </span>
                  {id === selectedSessionId && <Check size={14} className="shrink-0 text-accent-light" aria-label="Current session" />}
                </button>
              ))}
            </div>
          </section>

          <section className="app-panel p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-app-muted">Working now</div>
            <div className="mt-3 flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-light"><Bot size={17} /></span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-app-primary">{activeAgent?.name || 'Master Agent'}</div>
                <div className="mt-0.5 text-[11px] text-app-muted">{activeAgent ? activeAgent.role : 'Task routing and coordination'}</div>
              </div>
            </div>
            <div className="mt-4 border-t border-border/70 pt-3">
              <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-app-muted">Current step</div>
              <div className="mt-1.5 text-sm font-medium text-app-primary">{activeTask ? humanTaskTitle(activeTask) : 'Preparing task'}</div>
            </div>
          </section>

          <section className="app-panel overflow-hidden">
            <div className="border-b border-border/70 px-4 py-3">
              <div className="text-xs font-semibold text-app-primary">Work stages</div>
            </div>
            <div className="divide-y divide-border/70">
              {relatedTasks.map(task => {
                const agent = task.assigneeId ? agents.find(item => item.id === task.assigneeId) : undefined;
                return (
                  <button key={task.id} type="button" onClick={() => setSelectedTaskId(task.id)} className={cn('app-focus flex w-full items-center gap-2.5 px-4 py-3 text-left transition hover:bg-surface-hover', task.id === activeTask?.id && 'bg-accent/[0.045]')}>
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', task.status === 'done' ? 'bg-emerald-400' : task.status === 'failed' ? 'bg-red-400' : task.status === 'review' ? 'bg-violet-400' : 'bg-accent')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-app-primary">{humanTaskTitle(task)}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-app-muted">{agent?.name || 'Master Agent'} · {taskStatusLabel(task.status)}</span>
                    </span>
                    {task.status === 'done' && <Check size={14} className="shrink-0 text-emerald-500" />}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="app-panel p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-app-muted">Context</div>
            <div className="mt-3 space-y-3 text-xs">
              <div className="flex gap-2.5">
                <FolderOpen size={14} className="mt-0.5 shrink-0 text-app-muted" />
                <div className="min-w-0"><div className="text-app-muted">Workspace</div><div className="mt-0.5 truncate text-app-secondary" title={root.workdir || root.workspacePath || ''}>{root.workdir || root.workspacePath || 'No workspace attached'}</div></div>
              </div>
              <div className="flex gap-2.5">
                <MessageSquareText size={14} className="mt-0.5 shrink-0 text-app-muted" />
                <div><div className="text-app-muted">Conversation</div><div className="mt-0.5 text-app-secondary">{conversation.filter(item => item.message.type === 'agent_text').length} Agent update{conversation.filter(item => item.message.type === 'agent_text').length === 1 ? '' : 's'}</div></div>
              </div>
            </div>
            <button type="button" onClick={() => setActiveView('timeline')} className="app-focus mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-accent-light transition hover:text-app-primary">
              View logs, tools, and trace <ArrowUpRight size={14} />
            </button>
          </section>
        </aside>
      </div>
    </main>
  );
}
