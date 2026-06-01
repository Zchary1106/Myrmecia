import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores/store';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import type {
  AgentSummary,
  DynamicWorkflowPlan,
  DynamicWorkflowRun,
  ExecutionMessage,
  InboxEntry,
  Task,
  TaskExecution,
  ToolExecution,
} from '@agent-factory/shared';

type AuditReport = Awaited<ReturnType<typeof api.executionAudit.get>>;
type ArtifactSummary = Awaited<ReturnType<typeof api.artifacts.list>>[number];

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
  if (type === 'agent_text') return '💬';
  if (type === 'tool_use') return '🔧';
  if (type === 'tool_result') return '📎';
  if (type === 'progress') return '📊';
  if (type === 'error') return '❌';
  return '👤';
}

function nextStepFor(task?: Task, execution?: TaskExecution, audit?: AuditReport): string {
  if (!task) return 'Select a task or workflow node to inspect the next recommended action.';
  if (audit?.events.some(event => event.severity === 'block' || event.severity === 'error')) {
    return 'Review blocking audit events before retrying or approving downstream work.';
  }
  if (task.status === 'failed') return 'Open the error/output, fix the reported cause, then retry this task.';
  if (task.status === 'running') return 'Wait for the current agent step or inspect tool activity for stalls.';
  if (task.status === 'review') return 'Review the agent output and approve, request fixes, or run QA/security checks.';
  if (task.status === 'done') return 'Use the result as downstream evidence or continue to the next workflow step.';
  if (execution?.status === 'running') return 'Agent execution is active; watch messages, tools, and audit events.';
  return 'Task is waiting to be assigned or unblocked by its dependencies.';
}

function decisionFor(task?: Task, audit?: AuditReport): { label: string; tone: string } {
  if (!task) return { label: 'No selection', tone: 'bg-gray-500/10 text-gray-500' };
  if (audit?.events.some(event => event.severity === 'block' || event.severity === 'error')) {
    return { label: 'Blocked by governance', tone: 'bg-red-500/10 text-red-300' };
  }
  if (task.status === 'failed') return { label: 'Needs fix', tone: 'bg-red-500/10 text-red-300' };
  if (task.status === 'done') return { label: 'Ready', tone: 'bg-green-500/10 text-green-300' };
  if (task.status === 'running') return { label: 'In progress', tone: 'bg-blue-500/10 text-blue-300' };
  return { label: 'Waiting', tone: 'bg-yellow-500/10 text-yellow-300' };
}

function taskExecution(task: Task | undefined, executions: TaskExecution[]) {
  if (!task) return undefined;
  return executions.find(execution => execution.taskId === task.id);
}

function agentFor(task: Task | undefined, execution: TaskExecution | undefined, agents: AgentSummary[]) {
  if (!task && !execution) return undefined;
  return agents.find(agent => agent.id === (execution?.agentDefId || task?.assigneeId));
}

function tryParseTestReport(text?: string): Record<string, unknown> | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, text].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        if (parsed && typeof parsed === 'object' && ('status' in parsed || 'summary' in parsed || 'failures' in parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {}
    }
  }
  return null;
}

function WorkflowRail({
  workflows,
  selectedWorkflowId,
  onSelectWorkflow,
  onCancelWorkflow,
}: {
  workflows: DynamicWorkflowRun[];
  selectedWorkflowId?: string;
  onSelectWorkflow: (workflow: DynamicWorkflowRun) => void;
  onCancelWorkflow: (workflow: DynamicWorkflowRun) => void;
}) {
  return (
    <div className="space-y-2">
      {workflows.slice(0, 8).map(workflow => (
        <div
          key={workflow.id}
          className={cn(
            'w-full rounded-xl border px-3 py-2 text-left transition',
            selectedWorkflowId === workflow.id ? 'border-accent bg-accent/10' : 'border-border bg-surface hover:border-accent/40',
          )}
        >
          <button className="w-full text-left" onClick={() => onSelectWorkflow(workflow)}>
            <div className="flex items-center gap-2">
              <span className={cn('h-2 w-2 rounded-full', workflow.status === 'running' ? 'bg-blue-500 animate-pulse' : workflow.status === 'done' ? 'bg-green-500' : workflow.status === 'failed' ? 'bg-red-500' : 'bg-gray-500')} />
              <span className="truncate text-xs font-semibold">{workflow.goal}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] text-gray-500">
              <span>{workflow.status}</span>
              <span>{workflow.plan.steps.length} steps</span>
            </div>
          </button>
          <div className="mt-2 flex justify-end">
            <button
              onClick={() => onCancelWorkflow(workflow)}
              disabled={['done', 'failed', 'cancelled'].includes(workflow.status)}
              className="rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      ))}
      {workflows.length === 0 && (
        <div className="rounded-xl border border-dashed border-border py-8 text-center text-xs text-gray-600">
          No dynamic workflows yet
        </div>
      )}
    </div>
  );
}

function TaskGraph({
  tasks,
  agents,
  workflow,
  selectedTaskId,
  onSelectTask,
}: {
  tasks: Task[];
  agents: AgentSummary[];
  workflow?: DynamicWorkflowRun;
  selectedTaskId?: string;
  onSelectTask: (task: Task) => void;
}) {
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const levels: Task[][] = [];
  const depthOf = (task: Task, seen = new Set<string>()): number => {
    if (seen.has(task.id)) return 0;
    seen.add(task.id);
    const deps = (task.dependsOn || []).map(id => taskMap.get(id)).filter(Boolean) as Task[];
    if (deps.length === 0) return 0;
    return 1 + Math.max(...deps.map(dep => depthOf(dep, seen)));
  };
  tasks.forEach(task => {
    const depth = depthOf(task);
    if (!levels[depth]) levels[depth] = [];
    levels[depth].push(task);
  });

  if (tasks.length === 0) {
    return <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-gray-600">No tasks in this workflow selection</div>;
  }

  const cardW = 220;
  const cardH = 92;
  const colGap = 70;
  const rowGap = 18;
  const positions = new Map<string, { x: number; y: number; task: Task }>();
  levels.forEach((level, col) => level.forEach((task, row) => {
    positions.set(task.id, { x: col * (cardW + colGap), y: 28 + row * (cardH + rowGap), task });
  }));
  const width = Math.max(1, levels.length) * cardW + Math.max(0, levels.length - 1) * colGap;
  const height = Math.max(...levels.map(level => 28 + level.length * (cardH + rowGap)), 160);
  const blockedDeps = new Set(tasks.filter(task => task.status === 'failed').map(task => task.id));
  const stepByTask = new Map((workflow?.plan.steps || []).filter(step => step.taskId).map(step => [step.taskId!, step]));

  return (
    <div className="overflow-x-auto pb-2">
      <div className="relative" style={{ width, height }}>
        <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
          {tasks.flatMap(task => (task.dependsOn || []).map(depId => {
            const from = positions.get(depId);
            const to = positions.get(task.id);
            if (!from || !to) return null;
            const blocked = blockedDeps.has(depId);
            const x1 = from.x + cardW;
            const y1 = from.y + cardH / 2;
            const x2 = to.x;
            const y2 = to.y + cardH / 2;
            const mid = x1 + (x2 - x1) / 2;
            return (
              <path
                key={`${depId}-${task.id}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                stroke={blocked ? '#ef4444' : '#334155'}
                strokeWidth={blocked ? 3 : 2}
                fill="none"
                markerEnd="url(#arrow)"
              />
            );
          }))}
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#475569" />
            </marker>
          </defs>
        </svg>
        {levels.map((level, index) => (
          <div key={index} className="absolute text-[10px] uppercase tracking-[0.16em] text-gray-600" style={{ left: index * (cardW + colGap), top: 0 }}>
            {index === 0 ? 'Start' : `Depends +${index}`}
          </div>
        ))}
        {tasks.map(task => {
          const pos = positions.get(task.id)!;
          const agent = agents.find(item => item.id === task.assigneeId);
          const step = stepByTask.get(task.id);
          return (
            <button
              key={task.id}
              onClick={() => onSelectTask(task)}
              className={cn(
                'absolute rounded-xl border p-3 text-left transition',
                selectedTaskId === task.id ? 'border-accent bg-accent/10 ring-1 ring-accent/20' : 'border-border bg-background hover:border-accent/40',
              )}
              style={{ left: pos.x, top: pos.y, width: cardW, height: cardH }}
            >
              <div className="flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full', task.status === 'running' ? 'bg-blue-500 animate-pulse' : task.status === 'done' ? 'bg-green-500' : task.status === 'failed' ? 'bg-red-500' : 'bg-gray-500')} />
                <span className="line-clamp-2 text-xs font-semibold">{step?.title || task.title}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className={cn('rounded border px-1.5 py-0.5 text-[10px]', statusClass[task.status])}>{task.status}</span>
                <span className="truncate text-[10px] text-gray-500">{agent ? `${agent.emoji || '🤖'} ${agent.name}` : 'Unassigned'}</span>
              </div>
              {step?.dependsOn?.length ? <div className="mt-1 truncate text-[10px] text-gray-600">← {step.dependsOn.join(', ')}</div> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MessageFeed({ messages }: { messages: ExecutionMessage[] }) {
  if (messages.length === 0) {
    return <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-gray-600">No agent messages yet</div>;
  }
  return (
    <div className="space-y-2">
      {messages.slice(-12).map(message => (
        <div key={message.id} className="rounded-xl border border-border bg-background p-3">
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-gray-600">
            <span>{messageIcon(message.type)}</span>
            <span>{message.type}</span>
            {message.toolName && <span className="normal-case tracking-normal text-accent-light">{message.toolName}</span>}
          </div>
          <div className={cn('whitespace-pre-wrap text-xs leading-relaxed', message.type === 'error' ? 'text-red-300' : 'text-gray-300')}>
            {message.content}
          </div>
        </div>
      ))}
    </div>
  );
}

function TransparencyPanel({
  task,
  execution,
  agent,
  tools,
  audit,
  workflow,
  inboxEntries,
  artifacts,
  onRespondInbox,
  onRetryTask,
  onCancelTask,
  onStepControl,
  actionBusy,
}: {
  task?: Task;
  execution?: TaskExecution;
  agent?: AgentSummary;
  tools: ToolExecution[];
  audit: AuditReport | null;
  workflow?: DynamicWorkflowRun;
  inboxEntries: InboxEntry[];
  artifacts: ArtifactSummary[];
  onRespondInbox: (entry: InboxEntry, approved: boolean) => void;
  onRetryTask: () => void;
  onCancelTask: () => void;
  onStepControl: (action: 'rerun' | 'skip' | 'replace_agent' | 'force_unblock', agentId?: string) => void;
  actionBusy: boolean;
}) {
  const decision = decisionFor(task, audit || undefined);
  const currentStep = workflow?.plan.steps.find(step => step.taskId === task?.id);
  const relatedApprovals = inboxEntries.filter(entry =>
    entry.taskId === task?.id || entry.executionId === execution?.id || (workflow && entry.message.includes(workflow.id))
  );
  return (
    <aside className="w-[340px] shrink-0 space-y-3 overflow-y-auto">
      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Decision</h3>
          <span className={cn('rounded-full px-2 py-1 text-[10px] font-semibold', decision.tone)}>{decision.label}</span>
        </div>
        <p className="text-xs leading-relaxed text-gray-400">{nextStepFor(task, execution, audit || undefined)}</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={onRetryTask}
            disabled={!task || actionBusy || task.status === 'running'}
            className="rounded-lg bg-accent/15 px-3 py-2 text-xs text-accent-light disabled:cursor-not-allowed disabled:opacity-40"
          >
            Retry / upgrade
          </button>
          <button
            onClick={onCancelTask}
            disabled={!task || actionBusy || ['done', 'failed', 'cancelled'].includes(task.status)}
            className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel task
          </button>
        </div>
        <div className="mt-2 text-[10px] leading-relaxed text-gray-600">
          Retry increments task retry count; model routing may escalate from cheap to balanced/strong automatically.
        </div>
      </section>

      {currentStep && (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h3 className="mb-3 text-sm font-semibold">Workflow step controls</h3>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => onStepControl('rerun')} disabled={actionBusy} className="rounded-lg bg-accent/15 px-3 py-2 text-xs text-accent-light disabled:opacity-40">Rerun step</button>
            <button onClick={() => onStepControl('skip')} disabled={actionBusy} className="rounded-lg bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300 disabled:opacity-40">Skip step</button>
            <button onClick={() => onStepControl('force_unblock')} disabled={actionBusy} className="rounded-lg bg-purple-500/10 px-3 py-2 text-xs text-purple-300 disabled:opacity-40">Force unblock</button>
            <button onClick={() => onStepControl('replace_agent', agent?.id)} disabled={actionBusy || !agent} className="rounded-lg bg-blue-500/10 px-3 py-2 text-xs text-blue-300 disabled:opacity-40">Replace agent</button>
          </div>
          <div className="mt-2 text-[10px] text-gray-600">Current step: {currentStep.id}</div>
        </section>
      )}

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">Artifacts / evidence</h3>
        <div className="space-y-2">
          {artifacts.slice(0, 8).map(artifact => (
            <div key={artifact.id} className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="truncate text-xs font-medium">{artifact.name}</div>
              <div className="mt-1 text-[10px] text-gray-600">{artifact.ownerId} · {artifact.createdAt}</div>
            </div>
          ))}
          {workflow?.validationSummary && (
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-gray-600">Workflow validation</div>
              <div className="mt-1 text-xs text-gray-300">{workflow.validationSummary}</div>
            </div>
          )}
          {workflow?.result && (
            <details className="rounded-lg border border-border bg-background px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium">Workflow result</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-gray-400">{workflow.result}</pre>
            </details>
          )}
          {task?.output && (
            <details className="rounded-lg border border-border bg-background px-3 py-2" open>
              <summary className="cursor-pointer text-xs font-medium">Task output</summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[10px] text-gray-400">{task.output}</pre>
            </details>
          )}
          {tryParseTestReport(task?.output) && (
            <div className="rounded-lg border border-accent/20 bg-accent/10 px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-accent-light">Parsed test report</div>
              <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap text-[10px] text-gray-300">
                {JSON.stringify(tryParseTestReport(task?.output), null, 2)}
              </pre>
            </div>
          )}
          {!workflow?.validationSummary && !workflow?.result && !task?.output && (
            <div className="text-xs text-gray-600">Artifacts appear after agents produce outputs or workflow validation completes.</div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">Approval cards</h3>
        <div className="space-y-2">
          {relatedApprovals.map(entry => (
            <div key={entry.id} className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-3 py-2">
              <div className="text-xs font-medium text-yellow-200">{entry.title}</div>
              <div className="mt-1 line-clamp-3 text-[10px] text-gray-400">{entry.message}</div>
              <div className="mt-2 flex gap-2">
                <button onClick={() => onRespondInbox(entry, true)} className="rounded bg-green-500/15 px-2 py-1 text-[10px] text-green-300">Approve</button>
                <button onClick={() => onRespondInbox(entry, false)} className="rounded bg-red-500/15 px-2 py-1 text-[10px] text-red-300">Reject</button>
              </div>
            </div>
          ))}
          {audit?.events.filter(event => event.severity === 'block' || event.severity === 'error').map((event, index) => (
            <div key={`${event.type}-approval-${index}`} className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
              <div className="text-xs font-medium text-red-200">{event.type}</div>
              <div className="mt-1 text-[10px] text-gray-400">{event.message}</div>
            </div>
          ))}
          {relatedApprovals.length === 0 && !audit?.events.some(event => event.severity === 'block' || event.severity === 'error') && (
            <div className="text-xs text-gray-600">No pending approvals or blocking audit cards.</div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">Agent & model</h3>
        <Info label="Agent" value={agent ? `${agent.emoji || '🤖'} ${agent.name}` : 'Unassigned'} />
        <Info label="Role" value={agent?.role || task?.assigneeId || '-'} />
        <Info label="Model" value={execution?.modelId || 'not selected yet'} />
        <Info label="Tier" value={execution?.modelTier || '-'} />
        <Info label="Why this model" value={execution?.modelRouteReason || 'route reason will appear after execution starts'} />
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">Tools</h3>
        <div className="space-y-2">
          {tools.slice(0, 8).map(tool => (
            <div key={tool.id} className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium">{tool.toolId}</span>
                <span className={cn('rounded px-1.5 py-0.5 text-[10px]', tool.status === 'done' ? 'bg-green-500/10 text-green-400' : tool.status === 'failed' || tool.status === 'blocked' ? 'bg-red-500/10 text-red-400' : 'bg-blue-500/10 text-blue-400')}>{tool.status}</span>
              </div>
              {tool.outputSummary && <div className="mt-1 line-clamp-2 text-[10px] text-gray-500">{tool.outputSummary}</div>}
            </div>
          ))}
          {tools.length === 0 && <div className="text-xs text-gray-600">No tool calls recorded</div>}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">Audit</h3>
        <div className="space-y-2">
          {audit?.events.slice(-8).map((event, index) => (
            <div key={`${event.type}-${index}`} className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium">{event.type}</span>
                <span className={cn('rounded px-1.5 py-0.5 text-[10px]', event.severity === 'block' || event.severity === 'error' ? 'bg-red-500/10 text-red-400' : event.severity === 'warn' ? 'bg-yellow-500/10 text-yellow-400' : 'bg-gray-500/10 text-gray-400')}>{event.severity}</span>
              </div>
              <div className="mt-1 text-[10px] text-gray-500">{event.message}</div>
            </div>
          ))}
          {!audit && <div className="text-xs text-gray-600">Audit report appears after execution policy snapshot is recorded</div>}
        </div>
      </section>
    </aside>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-gray-600">{label}</div>
      <div className="mt-0.5 break-words text-xs text-gray-300">{value}</div>
    </div>
  );
}

export function InteractionConsolePage() {
  const {
    tasks,
    agents,
    executions,
    executionMessages,
    toolExecutions,
    models,
    loadTasks,
    loadAgents,
    loadExecutions,
    loadToolExecutions,
    loadModels,
    loadExecutionMessages,
  } = useStore();
  const [workflows, setWorkflows] = useState<DynamicWorkflowRun[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | undefined>();
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [goal, setGoal] = useState('');
  const [previewPlan, setPreviewPlan] = useState<DynamicWorkflowPlan | null>(null);
  const [previewJson, setPreviewJson] = useState('');
  const [creatingWorkflow, setCreatingWorkflow] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingInbox, setPendingInbox] = useState<InboxEntry[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);

  const refreshConsole = async () => {
    void Promise.all([loadTasks(), loadAgents(), loadExecutions(), loadToolExecutions(), loadModels()]);
    await Promise.all([
      api.supervisor.workflows.list().then(setWorkflows).catch(() => setWorkflows([])),
      api.inbox.list({ status: 'pending' }).then(setPendingInbox).catch(() => setPendingInbox([])),
      api.artifacts.list().then(setArtifacts).catch(() => setArtifacts([])),
    ]);
  };

  useEffect(() => {
    void refreshConsole();
  }, []);

  const selectedWorkflow = workflows.find(workflow => workflow.id === selectedWorkflowId) || workflows[0];
  const workflowTaskIds = new Set(selectedWorkflow?.taskIds || []);
  const scopedTasks = selectedWorkflow
    ? tasks.filter(task => workflowTaskIds.has(task.id))
    : tasks.slice(0, 24);
  const selectedTask = tasks.find(task => task.id === selectedTaskId) || scopedTasks.find(task => task.status === 'running') || scopedTasks[0];
  const execution = taskExecution(selectedTask, executions);
  const agent = agentFor(selectedTask, execution, agents);
  const messages = execution ? executionMessages[execution.id] || [] : [];
  const relatedTools = toolExecutions.filter(tool => tool.executionId === execution?.id || tool.taskId === selectedTask?.id);

  useEffect(() => {
    if (!execution?.id) {
      setAudit(null);
      return;
    }
    void loadExecutionMessages(execution.id);
    setLoadingAudit(true);
    api.executionAudit.get(execution.id)
      .then(setAudit)
      .catch(() => setAudit(null))
      .finally(() => setLoadingAudit(false));
  }, [execution?.id]);

  const activeCount = tasks.filter(task => task.status === 'running').length;
  const blockedCount = tasks.filter(task => task.status === 'failed' || task.status === 'review').length;
  const totalCost = executions.reduce((sum, item) => sum + (item.costUSD || 0), 0);
  const modelCount = models.filter(model => model.enabled).length;

  async function previewWorkflow() {
    const trimmed = goal.trim();
    if (!trimmed) {
      setNotice('Enter a goal before creating a dynamic workflow.');
      return;
    }
    setCreatingWorkflow(true);
    setNotice(null);
    try {
      const preview = await api.supervisor.workflows.preview({ goal: trimmed });
      setPreviewPlan(preview.plan);
      setPreviewJson(JSON.stringify(preview.plan, null, 2));
      setNotice(`Preview generated: ${preview.plan.steps.length} steps. Review or edit before dispatch.`);
    } catch (err: any) {
      setNotice(err?.message || 'Failed to preview workflow.');
    } finally {
      setCreatingWorkflow(false);
    }
  }

  async function createWorkflow() {
    const trimmed = goal.trim() || previewPlan?.goal || '';
    if (!trimmed) {
      setNotice('Enter a goal before creating a dynamic workflow.');
      return;
    }
    setCreatingWorkflow(true);
    setNotice(null);
    try {
      let plan = previewPlan || undefined;
      if (previewJson.trim()) {
        plan = JSON.parse(previewJson) as DynamicWorkflowPlan;
      }
      const workflow = await api.supervisor.workflows.create({ goal: trimmed, plan });
      setWorkflows(prev => [workflow, ...prev.filter(item => item.id !== workflow.id)]);
      setSelectedWorkflowId(workflow.id);
      setSelectedTaskId(workflow.taskIds[0]);
      setGoal('');
      setPreviewPlan(null);
      setPreviewJson('');
      await refreshConsole();
      setNotice(`Created dynamic workflow with ${workflow.plan.steps.length} steps.`);
    } catch (err: any) {
      setNotice(err?.message || 'Failed to create workflow.');
    } finally {
      setCreatingWorkflow(false);
    }
  }

  async function retryTask() {
    if (!selectedTask) return;
    setActionBusy(true);
    setNotice(null);
    try {
      const updated = await api.tasks.retry(selectedTask.id);
      setSelectedTaskId(updated.id);
      await refreshConsole();
      setNotice('Task queued for retry. Model routing will escalate if retry thresholds are met.');
    } catch (err: any) {
      setNotice(err?.message || 'Failed to retry task.');
    } finally {
      setActionBusy(false);
    }
  }

  async function cancelTask() {
    if (!selectedTask) return;
    setActionBusy(true);
    setNotice(null);
    try {
      await api.tasks.cancel(selectedTask.id, true);
      await refreshConsole();
      setNotice('Task cancelled.');
    } catch (err: any) {
      setNotice(err?.message || 'Failed to cancel task.');
    } finally {
      setActionBusy(false);
    }
  }

  async function cancelWorkflow(workflow: DynamicWorkflowRun) {
    setActionBusy(true);
    setNotice(null);
    try {
      const updated = await api.supervisor.workflows.cancel(workflow.id);
      setWorkflows(prev => prev.map(item => item.id === updated.id ? updated : item));
      setNotice('Workflow cancelled.');
    } catch (err: any) {
      setNotice(err?.message || 'Failed to cancel workflow.');
    } finally {
      setActionBusy(false);
    }
  }

  async function controlStep(action: 'rerun' | 'skip' | 'replace_agent' | 'force_unblock', agentId?: string) {
    if (!selectedWorkflow || !selectedTask) return;
    const step = selectedWorkflow.plan.steps.find(item => item.taskId === selectedTask.id);
    if (!step) {
      setNotice('No workflow step is associated with this task.');
      return;
    }
    setActionBusy(true);
    setNotice(null);
    try {
      const updated = await api.supervisor.workflows.controlStep(selectedWorkflow.id, step.id, {
        action,
        agentId,
        reason: `Operator requested ${action} from Interaction Console`,
      });
      setWorkflows(prev => prev.map(item => item.id === updated.id ? updated : item));
      const updatedStep = updated.plan.steps.find(item => item.id === step.id);
      if (updatedStep?.taskId) setSelectedTaskId(updatedStep.taskId);
      await refreshConsole();
      setNotice(`Workflow step ${action.replace('_', ' ')} completed.`);
    } catch (err: any) {
      setNotice(err?.message || `Failed to ${action} workflow step.`);
    } finally {
      setActionBusy(false);
    }
  }

  async function respondInbox(entry: InboxEntry, approved: boolean) {
    setActionBusy(true);
    setNotice(null);
    try {
      await api.inbox.respond(entry.id, {
        status: approved ? 'approved' : 'rejected',
        response: approved ? 'Approved from Interaction Console' : 'Rejected from Interaction Console',
      });
      await refreshConsole();
      setNotice(approved ? 'Approval accepted.' : 'Approval rejected.');
    } catch (err: any) {
      setNotice(err?.message || 'Failed to respond to approval.');
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Agent Interaction Console</h2>
          <p className="mt-1 text-sm text-gray-500">
            See who is working, why the platform chose that model, what tools ran, and what should happen next.
          </p>
        </div>
        <button
          onClick={() => {
            void refreshConsole();
          }}
          className="rounded-lg bg-surface-hover px-3 py-2 text-xs text-gray-400 hover:text-white"
        >
          Refresh
        </button>
      </header>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <label className="mb-1 block text-[10px] uppercase tracking-[0.16em] text-gray-600">Create dynamic workflow</label>
            <textarea
              value={goal}
              onChange={event => setGoal(event.target.value)}
              rows={2}
              placeholder="Describe a goal, e.g. implement auth fix, run QA, security review, and release gate..."
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>
          <div className="flex w-48 flex-col justify-end gap-2">
            <button
              onClick={previewWorkflow}
              disabled={creatingWorkflow}
              className="rounded-lg bg-surface-hover px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creatingWorkflow ? 'Working...' : 'Preview plan'}
            </button>
            <button
              onClick={createWorkflow}
              disabled={creatingWorkflow}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Dispatch
            </button>
            <p className="text-[10px] leading-relaxed text-gray-600">Planner creates steps, fans out agents, then validates and summarizes.</p>
          </div>
        </div>
        {notice && <div className="mt-3 rounded-lg border border-accent/20 bg-accent/10 px-3 py-2 text-xs text-accent-light">{notice}</div>}
        {previewPlan && (
          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_360px]">
            <div className="rounded-xl border border-border bg-background p-3">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold">Plan preview</h3>
                  <p className="text-[11px] text-gray-500">{previewPlan.strategy}</p>
                </div>
                <span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] text-accent-light">{previewPlan.steps.length} steps</span>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {previewPlan.steps.map((step, index) => (
                  <div key={step.id} className="rounded-lg border border-border bg-surface px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-[0.14em] text-gray-600">Step {index + 1}</span>
                      <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-300">{step.agentRole}</span>
                    </div>
                    <div className="mt-1 text-xs font-semibold">{step.title}</div>
                    <div className="mt-1 line-clamp-2 text-[10px] text-gray-500">{step.description}</div>
                    <div className="mt-2 text-[10px] text-gray-600">Depends: {step.dependsOn?.join(', ') || 'none'}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background p-3">
              <div className="mb-2 text-sm font-semibold">Edit JSON plan</div>
              <textarea
                value={previewJson}
                onChange={event => {
                  setPreviewJson(event.target.value);
                  try {
                    setPreviewPlan(JSON.parse(event.target.value));
                  } catch {}
                }}
                className="h-64 w-full resize-none rounded-lg border border-border bg-surface p-2 font-mono text-[10px] leading-relaxed outline-none focus:border-accent"
              />
            </div>
          </div>
        )}
      </section>

      <div className="grid grid-cols-4 gap-3">
        <Metric label="Active agents" value={String(activeCount)} detail="running tasks" />
        <Metric label="Needs attention" value={String(blockedCount)} detail="failed or review" />
        <Metric label="Enabled models" value={String(modelCount)} detail="available routes" />
        <Metric label="Tracked cost" value={`$${totalCost.toFixed(4)}`} detail="loaded executions" />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr_340px] gap-4">
        <section className="min-h-0 overflow-y-auto rounded-xl border border-border bg-surface p-4">
          <div className="mb-3">
            <h3 className="text-sm font-semibold">Workflow / task map</h3>
            <p className="mt-1 text-[11px] text-gray-500">Pick a workflow or inspect recent work directly.</p>
          </div>
          <WorkflowRail
            workflows={workflows}
            selectedWorkflowId={selectedWorkflow?.id}
            onCancelWorkflow={cancelWorkflow}
            onSelectWorkflow={(workflow) => {
              setSelectedWorkflowId(workflow.id);
              setSelectedTaskId(workflow.taskIds[0]);
            }}
          />
        </section>

        <main className="min-w-0 space-y-4 overflow-y-auto">
          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">{selectedWorkflow ? selectedWorkflow.goal : 'Recent work'}</h3>
                <p className="mt-1 text-[11px] text-gray-500">
                  {selectedWorkflow ? `${selectedWorkflow.status} · ${selectedWorkflow.plan.strategy}` : 'No workflow selected; showing latest tasks.'}
                </p>
              </div>
              {selectedWorkflow && (
                <span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] text-accent-light">
                  {selectedWorkflow.plan.steps.length} steps
                </span>
              )}
            </div>
            <TaskGraph
              tasks={scopedTasks}
              agents={agents}
              workflow={selectedWorkflow}
              selectedTaskId={selectedTask?.id}
              onSelectTask={(task) => setSelectedTaskId(task.id)}
            />
          </section>

          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">{selectedTask?.title || 'No task selected'}</h3>
                <p className="mt-1 text-[11px] text-gray-500">
                  {agent ? `${agent.emoji || '🤖'} ${agent.name}` : 'No agent'} · {execution?.modelId || 'model pending'} · {execution?.modelRouteSource || 'route pending'}
                </p>
              </div>
              {selectedTask && <span className={cn('rounded border px-2 py-1 text-[10px]', statusClass[selectedTask.status])}>{selectedTask.status}</span>}
            </div>

            <div className="mb-4 grid grid-cols-4 gap-2">
              <StepPill label="Plan" active={Boolean(selectedTask)} done={Boolean(selectedTask?.startedAt)} />
              <StepPill label="Actions" active={selectedTask?.status === 'running'} done={Boolean(relatedTools.length)} />
              <StepPill label="Evidence" active={Boolean(messages.length || selectedTask?.output)} done={selectedTask?.status === 'done'} />
              <StepPill label="Decision" active={Boolean(selectedTask)} done={decisionFor(selectedTask, audit || undefined).label === 'Ready'} />
            </div>

            <MessageFeed messages={messages} />
          </section>
        </main>

        <TransparencyPanel
          task={selectedTask}
          execution={execution}
          agent={agent}
          tools={relatedTools}
          audit={loadingAudit ? null : audit}
          workflow={selectedWorkflow}
          inboxEntries={pendingInbox}
          artifacts={artifacts}
          onRespondInbox={respondInbox}
          onRetryTask={retryTask}
          onCancelTask={cancelTask}
          onStepControl={controlStep}
          actionBusy={actionBusy}
        />
      </div>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="text-[10px] uppercase tracking-[0.16em] text-gray-600">{label}</div>
      <div className="mt-1 text-xl font-bold">{value}</div>
      <div className="mt-1 text-[11px] text-gray-500">{detail}</div>
    </div>
  );
}

function StepPill({ label, active, done }: { label: string; active?: boolean; done?: boolean }) {
  return (
    <div className={cn(
      'rounded-lg border px-3 py-2 text-center text-[11px]',
      done ? 'border-green-500/30 bg-green-500/10 text-green-300' :
      active ? 'border-blue-500/30 bg-blue-500/10 text-blue-300' :
      'border-border bg-background text-gray-600',
    )}>
      {label}
    </div>
  );
}
