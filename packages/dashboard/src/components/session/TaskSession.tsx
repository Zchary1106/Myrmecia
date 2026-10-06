import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ArrowUpRight, Bot, Check, CheckCheck, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Clock3, Copy, FolderOpen, Menu, MessageSquareText, Plus, Sparkles, Wrench, X } from 'lucide-react';
import type { AgentSummary, ExecutionMessage, Task, TaskExecution } from '@myrmecia/shared';
import { isWaitingForAgentInput } from '@myrmecia/shared';
import { cn } from '../../lib/utils';
import { useStore } from '../../stores/store';
import { StructuredTaskResult, looksLikeStructuredResult } from '../common/StructuredTaskResult';
import { api } from '../../lib/api';
import { MarkdownMessage } from '../common/MarkdownMessage';
import { SessionDocuments } from './SessionDocuments';
import { ExecutionFailure } from './ExecutionFailure';
import { ResearchAnswer } from './ResearchAnswer';
import { useConnectionsStore } from '../../stores/connections';
import { conversationIdForTask, useConversationStore, workflowConversationLabel } from '../../stores/conversations';
import { SessionHistory } from './SessionHistory';
import { LiquidLens } from '../common/LiquidLens';
import { AgentRunStatus } from './AgentRunStatus';

type ConversationEntry = {
  id: string;
  task: Task;
  execution?: TaskExecution;
  agent?: AgentSummary;
  message: ExecutionMessage;
};

type ConversationItem =
  | { kind: 'message'; id: string; entry: ConversationEntry }
  | { kind: 'errors'; id: string; entry: ConversationEntry; errors: ConversationEntry[]; results: ConversationEntry[] }
  | { kind: 'tools'; id: string; entries: ConversationEntry[] };

type ToolDiagnostics = {
  operation?: string;
  durationMs?: number;
  phases?: Array<{ phase?: string; message?: string; elapsedMs?: number }>;
};

function diagnosticsFromMessage(message: ExecutionMessage): ToolDiagnostics | undefined {
  if (message.type !== 'tool_result') return;
  try {
    const parsed = JSON.parse(message.content);
    return parsed?.diagnostics?.source === 'xiaohongshu' ? parsed.diagnostics : undefined;
  } catch { return; }
}

function displayToolMessage(message: ExecutionMessage): string {
  if (message.type !== 'tool_result') return message.content || '(empty)';
  try {
    const parsed = JSON.parse(message.content);
    if (parsed?.kind === 'research_result' && typeof parsed.output === 'string') return parsed.output;
  } catch { /* Historical and non-research results remain plain text. */ }
  return message.content || '(empty)';
}

function ToolActivity({ entries }: { entries: ConversationEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const calls = entries.filter(entry => entry.message.type === 'tool_use').length;
  const results = entries.length - calls;
  const names = [...new Set(entries.map(entry => entry.message.toolName || 'Unknown tool'))].join(', ');
  const xhsDiagnostics = entries.map(entry => diagnosticsFromMessage(entry.message)).filter(Boolean) as ToolDiagnostics[];
  const lastXhs = xhsDiagnostics.at(-1);
  const lastPhase = lastXhs?.phases?.at(-1);
  return (
    <details
      aria-label="Tool activity"
      className="rounded-xl border border-border/70 bg-background/35 text-xs"
      onToggle={event => setExpanded(event.currentTarget.open)}
    >
      <summary className="app-focus flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-app-muted [&::-webkit-details-marker]:hidden">
        <Wrench size={13} className="shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium">Tool calls</span>
        <span className="shrink-0">{calls > 0 ? `${calls} call${calls === 1 ? '' : 's'} · ` : ''}{results} result{results === 1 ? '' : 's'}</span>
        <span title={names} className="min-w-0 flex-1 truncate">{names}</span>
        {lastXhs && <span className="hidden shrink-0 text-[10px] text-app-muted sm:inline">
          小红书 {((lastXhs.durationMs || 0) / 1000).toFixed(1)}s · {lastPhase?.message || lastXhs.operation}
        </span>}
        <ChevronRight size={13} className={cn('shrink-0 transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
      </summary>
      {expanded && (
        <div className="max-h-80 space-y-2 overflow-y-auto border-t border-border/70 p-3">
          {entries.map(entry => {
            const diagnostics = diagnosticsFromMessage(entry.message);
            return <details key={entry.id} className="rounded-lg border border-border/60 bg-surface px-3 py-2">
              <summary className="app-focus cursor-pointer text-app-secondary">
                {entry.message.type === 'tool_use' ? 'Input' : 'Result'} · {entry.message.toolName || 'Unknown tool'}
                <time className="ml-2 text-[10px] text-app-muted">{formatTime(entry.message.createdAt)}</time>
              </summary>
              {diagnostics?.phases?.length && <ol aria-label="Xiaohongshu execution phases" className="mt-2 space-y-1 border-l border-border pl-3 text-[10px] text-app-muted">
                {diagnostics.phases.map((phase, index) => <li key={`${phase.phase}:${index}`}>
                  <span className="tabular-nums">{((phase.elapsedMs || 0) / 1000).toFixed(1)}s</span>
                  <span className="ml-2">{phase.message || phase.phase}</span>
                </li>)}
              </ol>}
              <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-[11px] leading-5 text-app-secondary">{displayToolMessage(entry.message)}</pre>
            </details>;
          })}
        </div>
      )}
    </details>
  );
}

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

// SQLite timestamps are UTC even when they lack an explicit timezone suffix.
function sessionDate(value: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}

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

function humanTaskTitle(task: Task): string {
  if (/^test:/i.test(task.title)) return 'Quality check';
  if (/^review:/i.test(task.title)) return 'Review';
  return task.title;
}

// A display label, not a rewrite of the task: preserve the complete title in
// the tooltip and original request in the conversation.
function compactSessionTitle(title: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Untitled conversation';
  if (Array.from(normalized).length <= 32) return normalized;
  const firstClause = normalized.split(/[，。！？]|[,!?]\s/)[0].trim();
  const label = Array.from(firstClause).length >= 8 ? firstClause : normalized;
  const characters = Array.from(label);
  return characters.length > 32 ? `${characters.slice(0, 32).join('').trimEnd()}…` : label;
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
  const byNewest = (left: Task, right: Task) => sessionDate(right.completedAt || right.startedAt || right.createdAt).getTime()
    - sessionDate(left.completedAt || left.startedAt || left.createdAt).getTime();

  const active = sessionTasks.filter(task => activeStatuses.includes(task.status)).sort(byNewest)[0];
  if (active) return active;

  return sessionTasks
    .filter(task => task.output || task.error || ['done', 'failed', 'cancelled'].includes(task.status))
    .sort(byNewest)[0] || fallback;
}

function taskExecutionFor(taskId: string, executions: TaskExecution[]): TaskExecution | undefined {
  return executions
    .filter(execution => execution.taskId === taskId)
    .sort((left, right) => sessionDate(right.startedAt).getTime() - sessionDate(left.startedAt).getTime())[0];
}

function formatTime(value: string): string {
  return sessionDate(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function UserMessage({ content, createdAt, anchorId }: { content: string; createdAt: string; anchorId?: string }) {
  return (
    <article id={anchorId} aria-label="Your message" className="message-enter ml-auto w-fit min-w-0 scroll-mt-8 max-w-[88%] sm:max-w-[min(78%,42rem)]">
      <p className="glass-user-bubble whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[18px] rounded-tr-[6px] bg-accent px-4 py-2.5 text-sm leading-6 text-white shadow-[0_10px_26px_rgb(var(--color-accent)/.18)]">{content}</p>
      <div className="mt-1 flex justify-end gap-1 px-1 text-[10px] leading-4 text-app-muted">
        <span>You ·</span><time dateTime={createdAt}>{formatTime(createdAt)}</time>
      </div>
    </article>
  );
}

function resizeComposer(element: HTMLTextAreaElement) {
  element.style.height = '0px';
  element.style.height = `${Math.max(44, Math.min(element.scrollHeight + 2, 160))}px`;
}

function messageLabel(entry: ConversationEntry): string {
  if (entry.message.type === 'progress') return 'Agent activity';
  if (entry.message.type === 'error') return 'Execution issue';
  if (entry.message.type === 'tool_result') return entry.message.toolName ? `Tool result · ${entry.message.toolName}` : 'Tool result';
  return entry.execution?.runState?.agentName || entry.agent?.name || entry.execution?.agentDefId || entry.task.assigneeId || 'Agent response';
}

export function TaskSession() {
  const conversationStates = useConversationStore(state => state.states);
  const conversationIds = useConversationStore(state => state.conversationIds);
  const xiaohongshuAuthenticated = useConnectionsStore(state => state.xiaohongshu?.authenticated === true);
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
    upsertTask,
  } = useStore();

  const tasksById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  const selectableTasks = useMemo(
    () => tasks.filter(task => conversationStates[conversationIdForTask(task, tasksById, conversationIds)] !== 'deleted' && !isInternalPlanningTask(task, tasks)),
    [tasks, tasksById, conversationStates, conversationIds],
  );
  const selectedTask = useMemo(() => {
    const current = selectableTasks.filter(task => !conversationStates[conversationIdForTask(task, tasksById, conversationIds)]);
    return (selectedTaskId ? selectableTasks.find(task => task.id === selectedTaskId) : undefined)
      || current.find(task => activeStatuses.includes(task.status)) || current[0] || selectableTasks[0];
  }, [selectedTaskId, selectableTasks, tasksById, conversationStates, conversationIds]);
  const root = useMemo(() => selectedTask ? rootTask(selectedTask, tasksById) : undefined, [selectedTask, tasksById]);
  const routedTeam = root ? teamTargetFromTask(root) : undefined;
  const relatedTasks = useMemo(() => {
    if (!root || !selectedTask) return [];
    const pipelineId = selectedTask.pipelineId || root.pipelineId;
    if (pipelineId) {
      return tasks
        .filter(task => conversationIdForTask(task, tasksById) === `pipeline:${pipelineId}`)
        .sort((left, right) => sessionDate(left.createdAt).getTime() - sessionDate(right.createdAt).getTime());
    }
    return tasks
      .filter(task => task.id === root.id || isDescendantTask(task, root.id, tasksById))
      .sort((left, right) => sessionDate(left.createdAt).getTime() - sessionDate(right.createdAt).getTime());
  }, [root, selectedTask, tasks, tasksById]);
  const relatedTaskIds = useMemo(() => new Set(relatedTasks.map(task => task.id)), [relatedTasks]);
  const sessionRoots = useMemo(() => {
    const groups = new Map<string, Task[]>();
    for (const task of selectableTasks) {
      // The Master creates a standalone planning execution to satisfy the
      // execution foreign key. Its useful output is copied to the parent task,
      // so it must not appear as a second user-facing conversation.
      if (isInternalPlanningTask(task, tasks)) continue;
      const key = conversationIdForTask(task, tasksById, conversationIds);
      const group = groups.get(key) || [];
      group.push(task);
      groups.set(key, group);
    }

    return [...groups.entries()]
      .map(([id, sessionTasks]): SessionListItem => {
        const activity = taskActivityForTasks(sessionTasks, sessionTasks[0]);
        const pipelineId = id.startsWith('pipeline:') ? id.slice(9) : undefined;
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
        return sessionDate(right.activity.completedAt || right.activity.startedAt || right.activity.createdAt).getTime()
          - sessionDate(left.activity.completedAt || left.activity.startedAt || left.activity.createdAt).getTime();
      });
  }, [pipelines, tasks, selectableTasks, tasksById, conversationIds]);
  const selectedSessionId = selectedTask ? conversationIdForTask(selectedTask, tasksById, conversationIds) : undefined;
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
    return relatedTasks.find(task => task.status === 'running')
      || [...relatedTasks].reverse().find(task => task.parentTaskId && task.createdBy === 'user')
      || root;
  }, [relatedTasks, root]);
  const activeAgent = activeTask?.assigneeId ? agents.find(agent => agent.id === activeTask.assigneeId) : undefined;
  const activeExecution = activeTask ? taskExecutionFor(activeTask.id, relatedExecutions) : undefined;
  const externalRunning = activeExecution?.status === 'running' && activeExecution.agentDefId.startsWith('external:');
  const [followUp, setFollowUp] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [followUpBusy, setFollowUpBusy] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [documentsParsing, setDocumentsParsing] = useState(false);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [atConversationEnd, setAtConversationEnd] = useState(true);
  const [hasNewConversationContent, setHasNewConversationContent] = useState(false);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const documentTaskRef = useRef(root?.id);
  documentTaskRef.current = root?.id;
  const canContinue = relatedTasks.length > 0
    && !conversationStates[selectedSessionId || '']
    && relatedTasks.every(task => ['done', 'failed', 'cancelled'].includes(task.status) || isWaitingForAgentInput(task, relatedExecutions));
  const [headerHost, setHeaderHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHeaderHost(document.getElementById('session-header-slot'));
  }, []);

  useEffect(() => {
    setFollowUp('');
    setFollowUpError(null);
    setDocumentsParsing(false);
    setHasNewConversationContent(false);
    setAtConversationEnd(true);
  }, [root?.id]);

  useLayoutEffect(() => {
    if (composerRef.current) resizeComposer(composerRef.current);
  }, [followUp, root?.id]);

  useEffect(() => {
    const element = composerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let previousWidth = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== previousWidth) {
        previousWidth = entry.contentRect.width;
        resizeComposer(element);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root?.id]);

  useEffect(() => {
    void Promise.all([loadTasks(), loadAgents(), loadExecutions(), useConversationStore.getState().load()]);
  }, [loadAgents, loadExecutions, loadTasks]);

  useEffect(() => {
    if (root?.assigneeId !== 'xiaohongshu-writer') return;
    const check = () => { void useConnectionsStore.getState().checkXiaohongshu().catch(() => undefined); };
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [root?.id, root?.assigneeId]);

  const executionIds = relatedExecutions.map(execution => execution.id).join('|');
  useEffect(() => {
    if (!executionIds) return;
    void Promise.all(relatedExecutions.map(execution => loadExecutionMessages(execution.id)));
  }, [executionIds, loadExecutionMessages, relatedExecutions]);

  const conversation = useMemo(() => {
    const entries: ConversationEntry[] = [];
    // A continuation's execution input contains inherited context. Show only
    // the user's new instruction, never that internal prompt.
    for (const task of relatedTasks) {
      if (task.parentTaskId && task.createdBy === 'user') {
        entries.push({
          id: `turn-input:${task.id}`, task,
          message: {
            id: -1, executionId: '', type: 'user_follow_up',
            content: task.description, createdAt: task.createdAt,
          },
        });
      }
    }
    for (const execution of relatedExecutions) {
      const task = tasksById.get(execution.taskId);
      if (!task) continue;
      const agent = agents.find(item => item.id === execution.agentDefId || item.id === task.assigneeId);
      for (const message of executionMessages[execution.id] || []) {
        if (message.type === 'user_input') continue;
        entries.push({ id: `${execution.id}:${message.id}`, task, execution, agent, message });
      }
    }

    const finalOutputTasks = relatedTasks.filter(task => task.output || task.error);
    for (const task of finalOutputTasks) {
      // A failed planning task can still contain the Master's useful
      // clarification. Prefer that real response over a terse technical error.
      const output = task.output || task.error;
      if (!output) continue;
      const execution = taskExecutionFor(task.id, relatedExecutions);
      const matchingReply = entries.find(entry =>
        entry.task.id === task.id
        && entry.execution?.id === execution?.id
        && entry.message.type === (task.output ? 'agent_text' : 'error')
        && entry.message.content.trim().length > 0
        && (entry.message.content === output || output.startsWith(entry.message.content)),
      );
      if (matchingReply) {
        // Older persisted messages contain only the first 500 characters.
        // Replace that preview with the complete result instead of suppressing it.
        matchingReply.message = { ...matchingReply.message, content: output };
      } else {
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

    return entries.sort((left, right) => sessionDate(left.message.createdAt).getTime() - sessionDate(right.message.createdAt).getTime());
  }, [agents, executionMessages, relatedExecutions, relatedTasks, tasksById]);

  const conversationItems = useMemo(() => {
    const items: ConversationItem[] = [];
    for (const entry of conversation) {
      if (entry.message.type === 'error') {
        const errors = conversation.filter(item => item.task.id === entry.task.id && item.message.type === 'error');
        if (errors[errors.length - 1].id !== entry.id) continue;
        items.push({ kind: 'errors', id: entry.id, entry, errors, results: conversation.filter(item => item.task.id === entry.task.id && item.message.type === 'tool_result') });
        continue;
      }
      if (entry.message.type === 'tool_use' || entry.message.type === 'tool_result') {
        const previous = items[items.length - 1];
        // Keep chronological boundaries: never fold a user turn, reply, error
        // or a different execution into the same tool group.
        if (previous?.kind === 'tools'
          && previous.entries[0].message.executionId === entry.message.executionId) {
          previous.entries.push(entry);
        } else {
          items.push({ kind: 'tools', id: entry.id, entries: [entry] });
        }
      } else {
        items.push({ kind: 'message', id: entry.id, entry });
      }
    }
    return items;
  }, [conversation]);
  const userTurnIds = useMemo(
    () => ['turn-root', ...conversation.filter(entry => entry.message.type === 'user_follow_up').map(entry => `turn-${entry.id}`)],
    [conversation],
  );
  const streamingFingerprint = streamingEntries.map(entry => `${entry.execution.id}:${entry.content.length}`).join('|');

  const scrollConversationToEnd = (behavior: ScrollBehavior = 'smooth') => {
    const element = messageScrollRef.current;
    if (!element) return;
    if (typeof element.scrollTo === 'function') element.scrollTo({ top: element.scrollHeight, behavior });
    else element.scrollTop = element.scrollHeight;
    setAtConversationEnd(true);
    setHasNewConversationContent(false);
  };

  const handleConversationScroll = () => {
    const element = messageScrollRef.current;
    if (!element) return;
    const nextAtEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    setAtConversationEnd(nextAtEnd);
    if (nextAtEnd) setHasNewConversationContent(false);
  };

  useEffect(() => {
    if (atConversationEnd) {
      requestAnimationFrame(() => scrollConversationToEnd(streamingEntries.length ? 'auto' : 'smooth'));
    } else {
      setHasNewConversationContent(true);
    }
  }, [conversationItems.length, streamingFingerprint]);

  const copyResponse = async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(id);
      window.setTimeout(() => setCopiedMessageId(current => current === id ? null : current), 1600);
    } catch {
      setCopiedMessageId(null);
    }
  };

  const jumpToTurn = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const retryFailedTask = async (task: Task) => {
    if (retryingTaskId) return;
    setRetryingTaskId(task.id);
    setFollowUpError(null);
    try {
      const retried = await api.tasks.retry(task.id);
      upsertTask(retried);
      setSelectedTaskId(retried.id);
      await Promise.all([loadTasks(), loadExecutions()]);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : 'Unable to retry this task.');
    } finally {
      setRetryingTaskId(null);
    }
  };

  const submitFollowUp = async (event: FormEvent) => {
    event.preventDefault();
    if (conversationStates[selectedSessionId || '']) {
      setFollowUpError('请先恢复归档会话，再继续追问。');
      return;
    }
    const content = followUp.trim();
    if (!content || !root || followUpBusy || documentsParsing) return;
    if (externalRunning) {
      setFollowUpError('此外部 Agent 不支持执行中追加指令。请等待结果，再发起新的调用。');
      return;
    }
    const running = activeExecution?.status === 'running';
    if (!running && !canContinue) return;
    setFollowUpBusy(true);
    setFollowUpError(null);
    try {
      if (running && activeExecution) {
        await api.executions.sendMessage(activeExecution.id, content, 'user_follow_up');
        await loadExecutionMessages(activeExecution.id);
      } else {
        const next = await api.tasks.continue(activeTask?.id || root.id, content);
        upsertTask(next);
        setSelectedTaskId(next.id);
        await loadTasks();
        await loadExecutions();
      }
      setFollowUp('');
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : 'Unable to send follow-up instruction.');
    } finally {
      setFollowUpBusy(false);
    }
  };

  if (!root) {
    return (
      <main className="app-page-shell flex min-h-full items-center justify-center p-6">
        {headerHost && createPortal(<span className="text-sm font-medium text-app-primary">Conversations</span>, headerHost)}
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

  const sessionTitle = sessionRoots.find(session => session.id === selectedSessionId)?.title || humanTaskTitle(root);
  const sessionStatus = activeTask?.status || root.status;
  const workflowStatus = pipelines.find(pipeline => pipeline.id === (selectedTask?.pipelineId || root.pipelineId))?.status;
  const executionState = activeExecution?.runState;
  const displayStatus = workflowConversationLabel(workflowStatus) || (executionState?.phase === 'waiting_for_user' ? '等待你的回复'
    : sessionStatus === 'done' && executionState ? executionState.acceptance === 'accepted' ? '已验收'
      : executionState.acceptance === 'rejected' ? '需要修改' : '执行结束 · 待验收'
      : taskStatusLabel(sessionStatus));
  const recipient = activeExecution?.runState?.agentName || activeAgent?.name || activeExecution?.agentDefId || activeTask?.assigneeId || routedTeam;
  const composerDeliveryHint = conversationStates[selectedSessionId || ''] === 'archived'
    ? '此会话已归档，请在左侧归档列表中恢复。'
    : externalRunning
      ? '外部 Agent 正在执行，请等待结果后再发起新的调用。'
      : canContinue
        ? 'Continues this session with its previous context.'
        : activeExecution?.status === 'running'
          ? `Sent to ${recipient || 'the current Agent'} on its next turn.`
          : 'You can draft the next instruction while this run settles.';
  const sessionHeader = (
    <div aria-label="Conversation header" className="grid min-w-0 grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)]">
      <div aria-hidden="true" className="hidden xl:block" />
      <div className="flex min-w-0 items-center justify-between gap-3 xl:pl-4">
        <div className="min-w-0 max-w-lg flex-1">
          <h1 title={sessionTitle} className="truncate text-[15px] font-medium leading-6 tracking-[-0.015em] text-app-primary">{compactSessionTitle(sessionTitle)}</h1>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] leading-4">
            <Bot size={12} className="shrink-0 text-app-muted" aria-hidden="true" />
            <span title={recipient} className="truncate text-app-muted">
              {recipient || (['queued', 'pending'].includes(sessionStatus) ? 'Selecting an Agent…' : 'No Agent assigned')}
            </span>
            <span aria-hidden="true" className="text-app-muted">·</span>
            <span className={cn('shrink-0', workflowStatus && ['paused', 'awaiting_retry', 'blocked'].includes(workflowStatus) ? 'text-amber-500' : workflowStatus === 'failed' || sessionStatus === 'failed' ? 'text-red-500' : workflowStatus !== 'running' && sessionStatus === 'done' ? 'text-emerald-500' : 'text-app-muted')}>
              {displayStatus}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => setMobileSessionsOpen(true)} aria-label="Open task sessions" title="Open task sessions" className="app-focus rounded-lg p-2 text-app-muted transition hover:bg-surface-hover hover:text-app-primary xl:hidden">
            <Menu size={16} />
          </button>
          <button type="button" onClick={() => setActiveView('timeline')} aria-label="Open technical timeline" title="Open technical timeline" className="app-focus rounded-lg px-2 py-2 text-xs text-app-muted transition hover:bg-surface-hover hover:text-app-primary">
            <span className="hidden sm:inline">Details</span><ArrowUpRight size={16} className="sm:hidden" />
          </button>
          <button type="button" onClick={() => { setSelectedTaskId(null); setActiveView('command'); }} aria-label="New conversation" title="New conversation" className="app-focus inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs font-medium text-app-secondary transition hover:bg-surface-hover hover:text-app-primary">
            <Plus size={14} /><span className="hidden sm:inline">New conversation</span>
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <main data-agent-chat-shell className="glass-chat flex h-full min-h-0 w-full flex-col overflow-y-auto bg-background xl:overflow-hidden">
      {headerHost ? createPortal(sessionHeader, headerHost) : <header className="mb-4 shrink-0 border-b border-border pb-3">{sessionHeader}</header>}
      {mobileSessionsOpen && <button type="button" aria-label="Close task sessions" onClick={() => setMobileSessionsOpen(false)} className="fixed inset-0 z-30 bg-black/35 backdrop-blur-[2px] xl:hidden" />}
      <div className="grid min-h-0 flex-1 xl:grid-cols-[280px_minmax(0,1fr)] xl:overflow-hidden">
        <section aria-label="Task conversation" className="agent-chat-thread relative order-2 flex min-h-[560px] min-w-0 flex-col overflow-hidden bg-background xl:min-h-0">
          <div ref={messageScrollRef} onScroll={handleConversationScroll} className="agent-chat-messages min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
            <div className="mx-auto w-full max-w-[850px] space-y-6">
            <UserMessage anchorId="turn-root" content={root.input || root.description || root.title} createdAt={root.createdAt} />
            {relatedExecutions.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 1).map(execution => (
              <AgentRunStatus key={execution.id} execution={execution}
                task={tasksById.get(execution.taskId) || root} sessionStatus={root.status} sessionError={root.error}
                agentName={execution.runState?.agentName || agents.find(agent => agent.id === execution.agentDefId)?.name || execution.agentDefId}
                onRevise={() => {
                  setFollowUp('请修改上一轮结果：');
                  composerRef.current?.focus();
                }} />
            ))}

            <article className="message-enter max-w-full border-l-2 border-accent/35 py-1 pl-4">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent/12 text-accent-light"><Sparkles size={13} /></span>
                <div className="text-xs font-semibold text-app-primary">{recipient || 'Master Agent'}</div>
              </div>
              <p className="mt-2 text-sm leading-6 text-app-secondary">
                {sessionStatus === 'failed'
                  ? `${recipient || 'Agent'} 的执行已停止，任务尚未完成。已收集资料和错误详情见下方。`
                  : sessionStatus === 'done'
                    ? '执行已结束，可以查看回复、验收结果或继续追问。'
                  : sessionStatus === 'cancelled'
                    ? '任务已取消，不再继续执行。'
                  : activeAgent
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

            {conversationItems.map(item => {
              if (item.kind === 'errors') return <ExecutionFailure key={item.id} task={item.entry.task}
                errors={item.errors.map(entry => entry.message)} results={item.results.map(entry => entry.message)}
                onModels={() => setActiveView('models')}
                onRetry={() => void retryFailedTask(item.entry.task)}
                retrying={retryingTaskId === item.entry.task.id}
                onContinue={() => {
                  setFollowUp('请基于已收集资料继续，先整理部分答案，只补充必要的查询，并明确尚未核实的信息。');
                  composerRef.current?.focus();
                }} />;
              if (item.kind === 'tools') return <ToolActivity key={item.id} entries={item.entries} />;
              const entry = item.entry;
              const isUserFollowUp = entry.message.type === 'user_follow_up';
              const isAgentReply = entry.message.type === 'agent_text';
              const isError = entry.message.type === 'error';
              const content = entry.message.content;
              if (!content) return null;

              if (isUserFollowUp) {
                return (
                  <UserMessage key={entry.id} anchorId={`turn-${entry.id}`} content={content} createdAt={entry.message.createdAt} />
                );
              }

              if (!isAgentReply) {
                if (entry.message.type === 'progress') {
                  return (
                    <details key={entry.id} className="group rounded-xl bg-surface-hover/55 text-xs">
                      <summary className="app-focus flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-app-muted [&::-webkit-details-marker]:hidden">
                        <span className="agent-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                        <span className="min-w-0 flex-1 truncate">{messageLabel(entry)}</span>
                        <ChevronRight size={13} className="transition-transform group-open:rotate-90" />
                      </summary>
                      <p className="border-t border-border/60 px-3 py-3 whitespace-pre-wrap text-app-secondary">{content}</p>
                    </details>
                  );
                }
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
                <article key={entry.id} className="message-enter group max-w-full py-1">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-surface-hover text-app-secondary"><Bot size={13} /></span>
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-app-primary">{messageLabel(entry)}</div>
                      <div className="text-[10px] text-app-muted" title={humanTaskTitle(entry.task)}>{formatTime(entry.message.createdAt)}</div>
                    </div>
                  </div>
                  {looksLikeStructuredResult(content) ? (
                    <div className="mt-3"><StructuredTaskResult output={content} /></div>
                  ) : (
                    <div className="mt-2"><ResearchAnswer content={content} request={entry.task.description || entry.task.input} conversationInput={entry.task.input} agentId={entry.execution?.agentDefId || entry.task.assigneeId} /></div>
                  )}
                  <div className="mt-2 flex min-h-7 items-center gap-1 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    <button type="button" onClick={() => void copyResponse(entry.id, content)} className="app-focus inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] text-app-muted transition hover:bg-surface-hover hover:text-app-primary" aria-label={`Copy response from ${messageLabel(entry)}`}>
                      {copiedMessageId === entry.id ? <CheckCheck size={13} className="text-emerald-500" /> : <Copy size={13} />}
                      {copiedMessageId === entry.id ? 'Copied' : 'Copy'}
                    </button>
                    <button type="button" onClick={() => setActiveView('timeline')} className="app-focus rounded-lg px-2 py-1 text-[10px] text-app-muted transition hover:bg-surface-hover hover:text-app-primary">
                      View run
                    </button>
                  </div>
                </article>
              );
            })}

            {streamingEntries.map(entry => (
              <article key={`streaming:${entry.execution.id}`} aria-live="polite" className="message-enter max-w-full border-l-2 border-accent/35 py-1 pl-4">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent/12 text-accent-light"><Bot size={13} /></span>
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-app-primary">{entry.execution.runState?.agentName || entry.agent?.name || 'Agent'}</div>
                    <div className="flex items-center gap-1.5 text-[10px] text-accent-light"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> Writing a response</div>
                  </div>
                </div>
                {looksLikeStructuredResult(entry.content) ? (
                  <div className="mt-3"><StructuredTaskResult output={entry.content} compact /></div>
                ) : (
                  <div className="mt-2">
                    <MarkdownMessage content={entry.content} />
                    <span className="streaming-caret ml-0.5 inline-block h-4 w-[2px] bg-accent" aria-label="Generating" />
                  </div>
                )}
              </article>
            ))}

            {conversation.length === 0 && streamingEntries.length === 0 && (
              <div className="message-enter flex max-w-full items-center gap-3 py-4 text-sm text-app-secondary">
                <span className="agent-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                <span>{activeTask?.status === 'failed' ? 'The task stopped before an Agent response was recorded.'
                  : activeExecution?.runState?.modelRequest ? '模型首条输出尚未到达，等待时间与请求时限见上方执行状态。'
                  : 'Waiting for the first real Agent update…'}</span>
              </div>
            )}
            </div>
          </div>

          {!atConversationEnd && (
            <button type="button" onClick={() => scrollConversationToEnd()} className="app-focus absolute bottom-32 right-5 z-20 inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-surface/95 px-3 py-2 text-[11px] font-medium text-app-secondary shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:text-app-primary sm:right-8" aria-label="Jump to latest message">
              {hasNewConversationContent ? <><span className="h-1.5 w-1.5 rounded-full bg-accent" /> New activity</> : 'Latest'}
              <ArrowDown size={13} />
            </button>
          )}

          {userTurnIds.length > 1 && (
            <nav aria-label="Conversation turns" className="absolute right-3 top-1/2 z-20 hidden -translate-y-1/2 flex-col items-center gap-1.5 2xl:flex">
              <button type="button" onClick={() => jumpToTurn(userTurnIds[0])} className="app-focus rounded-full border border-border/70 bg-surface/90 p-1.5 text-app-muted shadow-sm transition hover:text-accent-light" aria-label="Jump to first request"><ChevronUp size={13} /></button>
              <div className="flex max-h-52 flex-col gap-1 overflow-y-auto px-1">
                {userTurnIds.map((id, index) => (
                  <button key={id} type="button" onClick={() => jumpToTurn(id)} className="app-focus group flex h-3 w-7 items-center justify-end" aria-label={`Jump to request ${index + 1}`}>
                    <span className="h-0.5 w-4 rounded-full bg-border transition-all group-hover:w-6 group-hover:bg-accent" />
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => jumpToTurn(userTurnIds[userTurnIds.length - 1])} className="app-focus rounded-full border border-border/70 bg-surface/90 p-1.5 text-app-muted shadow-sm transition hover:text-accent-light" aria-label="Jump to latest request"><ChevronDown size={13} /></button>
            </nav>
          )}

          <div className="agent-composer-dock max-h-[48vh] shrink-0 overflow-y-auto px-4 pb-4 pt-6 sm:px-8">
            <div className="mx-auto w-full max-w-[850px]">
              {!xiaohongshuAuthenticated && conversation.some(entry =>
                  entry.message.type === 'tool_result' && entry.message.toolName?.startsWith('mcp__xiaohongshu__')
                  && /XHS_LOGIN_REQUIRED|not logged in|未登录/i.test(entry.message.content)) && (
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-app-muted">
                  <span>上次小红书查询需要登录，请在 Home 检查连接。</span>
                  <button type="button" onClick={() => {
                    useConnectionsStore.setState({ homeTarget: 'xiaohongshu' });
                    setActiveView('command');
                  }} className="app-focus rounded px-2 py-1 text-accent-light">前往连接</button>
                </div>
              )}
              <form onSubmit={event => void submitFollowUp(event)} aria-label="Send follow-up instruction" className="agent-composer">
                <LiquidLens radius={22} />
                <SessionDocuments key={root.id} taskId={root.id} onParsingChange={busy => {
                  if (documentTaskRef.current === root.id) setDocumentsParsing(busy);
                }} actions={<div className="session-composer-actions">
                  <div id="follow-up-recipient-hint" className="session-composer-destination" title={composerDeliveryHint}>
                    <Bot size={13} aria-hidden="true" />
                    <span className="truncate" title={recipient || 'Master Agent'}>{recipient || 'Master Agent'}</span>
                    <span className="session-composer-delivery">
                      {conversationStates[selectedSessionId || ''] === 'archived' ? 'Archived' : externalRunning ? 'Working' : canContinue ? 'Follow-up' : activeExecution?.status === 'running' ? 'Next turn' : 'Waiting'}
                    </span>
                    <span className="sr-only">{composerDeliveryHint}</span>
                  </div>
                  <p id="follow-up-keyboard-hint" className="session-composer-keyboard">
                    <span aria-hidden="true"><kbd>↵</kbd> Send <span className="mx-1">·</span> <kbd>⇧ ↵</kbd> New line</span>
                    <span className="sr-only">Enter to send · Shift+Enter for a new line</span>
                  </p>
                  <button type="submit" disabled={externalRunning || !followUp.trim() || followUpBusy || documentsParsing || (!canContinue && activeExecution?.status !== 'running')} aria-label="Send follow-up" className="session-composer-send glass-primary-button app-focus">
                    {followUpBusy ? <span className="agent-thinking-dots agent-thinking-dots-light" aria-label="Sending"><i /><i /><i /></span> : <ArrowUp size={18} aria-hidden="true" />}
                  </button>
                </div>}>
                  <textarea
                    ref={composerRef}
                    rows={1}
                    value={followUp}
                    onChange={event => { setFollowUp(event.target.value); setFollowUpError(null); }}
                    onCompositionStart={() => { composingRef.current = true; }}
                    onCompositionEnd={() => { composingRef.current = false; }}
                    onKeyDown={event => {
                      if (event.key !== 'Enter' || event.shiftKey || composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }}
                    placeholder={externalRunning ? '外部 Agent 正在执行，请等待结果后再发起新的调用…' : conversationStates[selectedSessionId || ''] === 'archived' ? '请先在归档列表中恢复此会话，再继续追问。' : canContinue ? 'Ask a follow-up in this conversation…' : `Add an instruction for ${activeAgent?.name || activeTask?.assigneeId || 'the current Agent'}…`}
                    aria-label="Follow-up instruction"
                    aria-describedby="follow-up-keyboard-hint follow-up-recipient-hint"
                    className="session-composer-input"
                    disabled={followUpBusy || conversationStates[selectedSessionId || ''] === 'archived'}
                    maxLength={8000}
                  />
                </SessionDocuments>
                {followUpError && <p className="mx-2 mt-2 text-[11px] text-red-500" role="alert">{followUpError}</p>}
              </form>
            </div>
          </div>
        </section>

        <aside aria-label="Task context" className={cn(
          'glass-surface glass-session-context fixed bottom-0 left-0 top-14 z-40 flex w-[min(88vw,320px)] min-h-0 flex-col bg-surface shadow-2xl transition-transform duration-200 xl:static xl:z-auto xl:w-auto xl:translate-x-0 xl:bg-surface/45 xl:shadow-none xl:overflow-hidden',
          mobileSessionsOpen
            ? 'visible translate-x-0 pointer-events-auto'
            : 'invisible -translate-x-full pointer-events-none xl:visible xl:pointer-events-auto',
        )}>
          <SessionHistory sessions={sessionRoots} selectedId={selectedSessionId} onSelect={setSelectedTaskId} onClose={() => setMobileSessionsOpen(false)} />

          <details className="group shrink-0 border-t border-border/70">
            <summary className="app-focus flex cursor-pointer list-none items-center justify-between px-4 py-3 text-xs font-medium text-app-secondary transition hover:bg-surface-hover hover:text-app-primary [&::-webkit-details-marker]:hidden">
              <span>Session details</span>
              <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
            </summary>
          <div className="max-h-[48vh] space-y-0 overflow-y-auto border-t border-border/70">
          <section className="border-b border-border/70 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-app-muted">{['failed', 'done', 'cancelled'].includes(sessionStatus) ? 'Last execution' : 'Working now'}</div>
            <div className="mt-3 flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-light"><Bot size={17} /></span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-app-primary">{recipient || 'Master Agent'}</div>
                <div className="mt-0.5 text-[11px] text-app-muted">{['failed', 'done', 'cancelled'].includes(sessionStatus) ? taskStatusLabel(sessionStatus) : activeAgent?.role || 'Task routing and coordination'}</div>
              </div>
            </div>
            <div className="mt-4 border-t border-border/70 pt-3">
              <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-app-muted">Current step</div>
              <div className="mt-1.5 text-sm font-medium text-app-primary">{activeTask ? humanTaskTitle(activeTask) : 'Preparing task'}</div>
            </div>
          </section>

          <section className="overflow-hidden border-b border-border/70">
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
                      <span className="mt-0.5 block truncate text-[10px] text-app-muted">{agent?.name || task.assigneeId || 'Master Agent'} · {taskStatusLabel(task.status)}</span>
                    </span>
                    {task.status === 'done' && <Check size={14} className="shrink-0 text-emerald-500" />}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="p-4">
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
          </div>
          </details>
        </aside>
      </div>
    </main>
  );
}
