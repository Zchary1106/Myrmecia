import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentSummary, RunTrace, TraceSpan } from '@myrmecia/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useStore } from '../../stores/store';
import { AuditDrawer } from '../audit/AuditDrawer';

type WorkbenchTab = 'overview' | 'skill' | 'tools' | 'runs' | 'trace';

const tabs: { id: WorkbenchTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'skill', label: 'Skill' },
  { id: 'tools', label: 'Tools' },
  { id: 'runs', label: 'Runs' },
  { id: 'trace', label: 'Trace' },
];

function metaText(span: TraceSpan | undefined, key: string): string | undefined {
  const value = span?.metadata?.[key];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function findLatestSpan(trace: RunTrace | null, type: string) {
  return [...(trace?.spans || [])].reverse().find(span => span.type === type);
}

function durationLabel(ms?: number) {
  if (ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function Metric({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'green' | 'red' | 'blue' | 'purple' }) {
  const toneClass = {
    default: 'text-gray-100',
    green: 'text-emerald-300',
    red: 'text-red-300',
    blue: 'text-blue-300',
    purple: 'text-purple-300',
  }[tone];
  return (
    <div className="rounded-xl border border-border bg-background/70 p-3">
      <div className={cn('text-lg font-bold', toneClass)}>{value}</div>
      <div className="mt-1 text-[10px] text-gray-500">{label}</div>
    </div>
  );
}

function TraceDiagnostics({ trace }: { trace: RunTrace | null }) {
  const modelSpan = findLatestSpan(trace, 'model.route');
  const promptSpan = findLatestSpan(trace, 'prompt.build');
  const llmSpan = findLatestSpan(trace, 'llm.call');
  const toolSpans = trace?.spans.filter(span => span.type === 'tool.call') || [];
  const blockedSpans = trace?.spans.filter(span => span.status === 'blocked') || [];
  const failedSpans = trace?.spans.filter(span => span.status === 'failed' || span.error) || [];

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <DiagnosticCard
        label="Model"
        value={metaText(modelSpan, 'modelId') || '-'}
        detail={metaText(modelSpan, 'reason') || metaText(modelSpan, 'source') || 'No routing span yet'}
      />
      <DiagnosticCard
        label="Skill"
        value={metaText(promptSpan, 'skillVersionId') || metaText(promptSpan, 'skillId') || '-'}
        detail={metaText(promptSpan, 'skillChecksum') ? `checksum ${metaText(promptSpan, 'skillChecksum')?.slice(0, 12)}` : 'No skill checksum yet'}
      />
      <DiagnosticCard
        label="LLM"
        value={llmSpan?.status || '-'}
        detail={`${durationLabel(llmSpan?.durationMs)} · ${metaText(llmSpan, 'inputTokens') || 0}/${metaText(llmSpan, 'outputTokens') || 0} tokens`}
      />
      <DiagnosticCard
        label="Tools / Issues"
        value={`${toolSpans.length} tools`}
        detail={`${blockedSpans.length} blocked · ${failedSpans.length} failed`}
        tone={failedSpans.length ? 'red' : blockedSpans.length ? 'yellow' : 'green'}
      />
    </div>
  );
}

function DiagnosticCard({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'default' | 'green' | 'yellow' | 'red';
}) {
  const toneClass = {
    default: 'border-border',
    green: 'border-emerald-500/30',
    yellow: 'border-yellow-500/30',
    red: 'border-red-500/30',
  }[tone];
  return (
    <div className={cn('rounded-xl border bg-background p-3', toneClass)}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-gray-600">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-gray-100">{value}</div>
      <div className="mt-1 line-clamp-2 text-[11px] text-gray-500">{detail}</div>
    </div>
  );
}

export function AgentWorkbench({ agent, onEdit }: { agent: AgentSummary; onEdit: (agent: AgentSummary) => void }) {
  const {
    tasks,
    tools,
    toolExecutions,
    skills,
    skillAssignments,
    executions,
    setActiveView,
    setSelectedTaskId,
    loadTasks,
    loadTools,
    loadToolExecutions,
    loadSkills,
    loadSkillAssignments,
    loadExecutions,
  } = useStore();
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('overview');
  const [latestTrace, setLatestTrace] = useState<RunTrace | null>(null);

  useEffect(() => {
    void Promise.all([
      loadTasks(),
      loadTools(),
      loadToolExecutions(),
      loadSkills(),
      loadSkillAssignments(),
      loadExecutions(),
    ]);
  }, [agent.id]);

  const agentTools = agent.allowedTools || agent.config?.allowedTools || [];
  const assignment = skillAssignments.find(item => item.agentId === agent.id);
  const skill = skills.find(item => item.id === assignment?.skillId) || skills.find(item => item.sourcePath === agent.skillPath);
  const recentExecutions = useMemo(
    () => executions
      .filter(execution => execution.agentDefId === agent.id)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, 8),
    [executions, agent.id],
  );
  const latestExecution = recentExecutions[0];
  const recentToolExecutions = useMemo(
    () => toolExecutions
      .filter(execution => execution.agentId === agent.id)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, 8),
    [toolExecutions, agent.id],
  );
  const completed = agent.stats?.tasksCompleted || 0;
  const failed = agent.stats?.tasksFailed || 0;
  const successRate = completed + failed > 0 ? `${Math.round((completed / (completed + failed)) * 100)}%` : '-';

  useEffect(() => {
    if (!latestExecution?.id) {
      setLatestTrace(null);
      return;
    }
    let active = true;
    api.executions.trace(latestExecution.id)
      .then(trace => { if (active) setLatestTrace(trace); })
      .catch(() => { if (active) setLatestTrace(null); });
    return () => { active = false; };
  }, [latestExecution?.id]);

  const openExecution = (taskId: string) => {
    setSelectedTaskId(taskId);
    setActiveView('timeline');
  };

  const modelSpan = findLatestSpan(latestTrace, 'model.route');
  const promptSpan = findLatestSpan(latestTrace, 'prompt.build');

  return (
    <section className="rounded-2xl border border-accent/20 bg-gradient-to-br from-surface to-background p-5 shadow-lg shadow-accent/5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-background text-4xl">{agent.emoji || '🤖'}</span>
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.24em] text-accent-light">Agent Workbench</div>
            <h3 className="mt-1 truncate text-2xl font-bold">{agent.name}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span>{agent.role}</span>
              <span>·</span>
              <span>{agent.model || agent.config?.model || 'routed model'}</span>
              <span>·</span>
              <span>{agentTools.length} tools</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <AuditDrawer targetType="agent" targetId={agent.id} label="Audit" />
          <button
            type="button"
            onClick={() => onEdit(agent)}
            className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/90"
          >
            Edit Agent
          </button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-medium transition',
              activeTab === tab.id ? 'bg-accent/20 text-accent-light' : 'bg-background text-gray-500 hover:text-gray-300',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {activeTab === 'overview' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Metric label="Success Rate" value={successRate} tone="green" />
              <Metric label="Completed" value={completed} />
              <Metric label="Failed" value={failed} tone={failed ? 'red' : 'default'} />
              <Metric label="Avg Duration" value={agent.stats?.avgDurationMs ? durationLabel(agent.stats.avgDurationMs) : '-'} tone="blue" />
            </div>
            <TraceDiagnostics trace={latestTrace} />
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Runtime profile">
                <p className="text-xs leading-relaxed text-gray-400">{agent.description || agent.whenToUse || 'No description configured.'}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {(agent.capabilities || []).map(capability => (
                    <span key={capability} className="rounded-full bg-accent/10 px-2 py-1 text-[10px] text-accent-light">{capability}</span>
                  ))}
                  {(agent.capabilities || []).length === 0 && <span className="text-xs text-gray-600">No capabilities tagged</span>}
                </div>
              </Panel>
              <Panel title="Latest routing">
                <KeyValue label="Requested model" value={metaText(modelSpan, 'requestedModelId') || agent.model || agent.config?.model || '-'} />
                <KeyValue label="Selected model" value={metaText(modelSpan, 'modelId') || '-'} />
                <KeyValue label="Reason" value={metaText(modelSpan, 'reason') || metaText(modelSpan, 'source') || '-'} />
                <KeyValue label="Skill checksum" value={metaText(promptSpan, 'skillChecksum')?.slice(0, 16) || '-'} />
              </Panel>
            </div>
          </div>
        )}

        {activeTab === 'skill' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Assigned skill">
              <KeyValue label="Skill" value={skill?.name || assignment?.skillId || agent.skillPath || 'Unassigned'} />
              <KeyValue label="Version" value={assignment?.skillVersionId || metaText(promptSpan, 'skillVersionId') || '-'} />
              <KeyValue label="Source" value={metaText(promptSpan, 'skillSource') || (assignment ? 'assignment' : agent.skillPath ? 'skillPath' : '-')} />
              <KeyValue label="Markdown source" value={skill?.sourcePath || agent.skillPath || '-'} />
            </Panel>
            <Panel title="Execution proof">
              <KeyValue label="Trace skill id" value={metaText(promptSpan, 'skillId') || '-'} />
              <KeyValue label="Trace version" value={metaText(promptSpan, 'skillVersion') || '-'} />
              <KeyValue label="Trace checksum" value={metaText(promptSpan, 'skillChecksum') || '-'} />
              <KeyValue label="Prompt chars" value={metaText(promptSpan, 'systemPromptChars') || '-'} />
            </Panel>
          </div>
        )}

        {activeTab === 'tools' && (
          <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
            <Panel title="Allowed tools">
              <div className="grid gap-2 md:grid-cols-2">
                {agentTools.map(toolId => {
                  const definition = tools.find(tool => tool.id === toolId);
                  return (
                    <div key={toolId} className="rounded-lg border border-border bg-background p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-xs font-semibold text-gray-200">{definition?.name || toolId}</div>
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px]', definition?.enabled === false ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300')}>
                          {definition?.enabled === false ? 'disabled' : 'enabled'}
                        </span>
                      </div>
                      <div className="mt-1 text-[10px] text-gray-500">{toolId}</div>
                      {definition && <div className="mt-2 text-[11px] text-gray-500">{definition.riskLevel} risk · {definition.approvalRequired ? 'approval required' : 'auto allowed'}</div>}
                    </div>
                  );
                })}
                {agentTools.length === 0 && <div className="text-xs text-gray-600">No tools configured for this Agent.</div>}
              </div>
            </Panel>
            <Panel title="Recent tool calls">
              <div className="space-y-2">
                {recentToolExecutions.map(execution => (
                  <div key={execution.id} className="rounded-lg border border-border bg-background p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold">{execution.toolId}</span>
                      <span className={cn('text-[10px]', execution.status === 'done' ? 'text-emerald-300' : execution.status === 'failed' ? 'text-red-300' : 'text-yellow-300')}>{execution.status}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-gray-600">{new Date(execution.startedAt).toLocaleString()} · {durationLabel(execution.durationMs)}</div>
                  </div>
                ))}
                {recentToolExecutions.length === 0 && <div className="text-xs text-gray-600">No recent tool executions.</div>}
              </div>
            </Panel>
          </div>
        )}

        {activeTab === 'runs' && (
          <Panel title="Recent runs">
            <div className="grid gap-2">
              {recentExecutions.map(execution => {
                const task = tasks.find(item => item.id === execution.taskId);
                return (
                  <button
                    key={execution.id}
                    onClick={() => openExecution(execution.taskId)}
                    className="rounded-lg border border-border bg-background p-3 text-left transition hover:border-accent/40"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{task?.title || execution.taskId}</div>
                        <div className="mt-1 text-[10px] text-gray-600">{execution.id} · {new Date(execution.startedAt).toLocaleString()}</div>
                      </div>
                      <span className={cn('rounded px-2 py-1 text-[10px]', execution.status === 'done' ? 'bg-emerald-500/10 text-emerald-300' : execution.status === 'failed' ? 'bg-red-500/10 text-red-300' : 'bg-blue-500/10 text-blue-300')}>
                        {execution.status}
                      </span>
                    </div>
                    <div className="mt-2 text-[11px] text-gray-500">{execution.tokenCount} tokens · ${execution.costUSD.toFixed(4)} · skill {execution.skillVersionId || '-'}</div>
                  </button>
                );
              })}
              {recentExecutions.length === 0 && <div className="text-xs text-gray-600">No executions yet.</div>}
            </div>
          </Panel>
        )}

        {activeTab === 'trace' && (
          <div className="space-y-4">
            <TraceDiagnostics trace={latestTrace} />
            <Panel title="Latest trace spans">
              <div className="grid gap-2">
                {(latestTrace?.spans || []).map(span => (
                  <div key={span.id} className="rounded-lg border border-border bg-background p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-xs font-semibold">{span.name}</div>
                      <span className="text-[10px] text-gray-500">{span.status}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-gray-600">{span.type} · {durationLabel(span.durationMs)}</div>
                    {span.error && <div className="mt-2 text-[11px] text-red-300">{span.error}</div>}
                  </div>
                ))}
                {!latestTrace && <div className="text-xs text-gray-600">Run this Agent to generate structured trace diagnostics.</div>}
              </div>
            </Panel>
          </div>
        )}
      </div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface/80 p-4">
      <h4 className="mb-3 text-sm font-semibold text-gray-300">{title}</h4>
      {children}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/70 py-2 last:border-0">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="max-w-[70%] break-words text-right text-xs text-gray-300">{value}</span>
    </div>
  );
}
