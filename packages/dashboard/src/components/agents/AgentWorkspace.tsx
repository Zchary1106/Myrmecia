import { useEffect, useMemo, useState } from 'react';
import type { AgentSummary } from '@myrmecia/shared';
import { cn } from '../../lib/utils';
import { useStore } from '../../stores/store';
import { AgentChatPanel } from './AgentChatPanel';
import { ContentStudio } from './ContentStudio';

const contentAgentIds = new Set(['trend-scout', 'xiaohongshu-writer', 'douyin-writer', 'wechat-writer', 'social-publisher']);
const contentStudioAgentIds = new Set(['xiaohongshu-writer', 'douyin-writer', 'wechat-writer']);

export function isContentProductionAgent(agent: AgentSummary | undefined): boolean {
  if (!agent) return false;
  return contentAgentIds.has(agent.id)
    || agent.capabilities?.some(capability => ['xiaohongshu', 'douyin', 'tiktok', 'wechat', 'publishing', 'trend-research'].includes(capability));
}

export function usesContentStudio(agent: AgentSummary | undefined): boolean {
  return Boolean(agent && contentStudioAgentIds.has(agent.id));
}

function agentGroup(agent: AgentSummary): 'Core' | 'Content' | 'Specialists' {
  if (['orchestrator', 'product-manager', 'designer', 'developer', 'tester', 'devops', 'reviewer'].includes(agent.role)) {
    return 'Core';
  }
  if (agent.role === 'content-writer' || isContentProductionAgent(agent)) return 'Content';
  return 'Specialists';
}

function AgentDirectory() {
  const {
    agents,
    selectedAgentId,
    setSelectedAgentId,
    agentDirectoryCollapsed,
    setAgentDirectoryCollapsed,
    setActiveView,
  } = useStore();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return agents.filter(agent => !needle || [
      agent.name,
      agent.role,
      ...(agent.capabilities || []),
    ].join(' ').toLowerCase().includes(needle));
  }, [agents, query]);

  const grouped = useMemo(() => filtered.reduce<Record<string, AgentSummary[]>>((acc, agent) => {
    const group = agentGroup(agent);
    (acc[group] ||= []).push(agent);
    return acc;
  }, {}), [filtered]);

  useEffect(() => {
    if (!selectedAgentId && agents[0]) setSelectedAgentId(agents[0].id);
  }, [agents, selectedAgentId, setSelectedAgentId]);

  return (
    <aside
      data-testid="agent-directory"
      data-collapsed={agentDirectoryCollapsed}
      className={cn(
        'flex h-full flex-none flex-col border-r border-border bg-surface transition-[width] duration-200',
        agentDirectoryCollapsed ? 'w-16' : 'w-64 2xl:w-72',
      )}
    >
      <div className={cn('flex items-center border-b border-border', agentDirectoryCollapsed ? 'justify-center p-2' : 'justify-between p-4')}>
        {!agentDirectoryCollapsed && (
          <div className="min-w-0">
            <div className="font-semibold">Agent Directory</div>
            <div className="mt-1 text-[10px] text-gray-600">
              {agents.length} specialists · {agents.filter(agent => agent.activeExecutions > 0).length} running
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => setAgentDirectoryCollapsed(!agentDirectoryCollapsed)}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-gray-500 hover:border-accent/40 hover:text-gray-200"
          title={agentDirectoryCollapsed ? 'Expand Agent directory' : 'Collapse Agent directory'}
          aria-label={agentDirectoryCollapsed ? 'Expand Agent directory' : 'Collapse Agent directory'}
        >
          {agentDirectoryCollapsed ? '›' : '‹'}
        </button>
      </div>

      {!agentDirectoryCollapsed && (
        <div className="p-3">
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search Agent or capability"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:border-accent"
          />
        </div>
      )}

      <div className={cn('flex-1 overflow-y-auto', agentDirectoryCollapsed ? 'space-y-2 p-2' : 'space-y-4 px-2 pb-3')}>
        {agentDirectoryCollapsed ? (
          filtered.map(agent => (
            <button
              key={agent.id}
              type="button"
              onClick={() => setSelectedAgentId(agent.id)}
              title={`${agent.name} · ${agent.role}`}
              className={cn(
                'relative flex h-11 w-11 items-center justify-center rounded-xl border text-lg transition',
                selectedAgentId === agent.id
                  ? 'border-accent/50 bg-accent/15'
                  : 'border-transparent bg-background/60 hover:border-border hover:bg-surface-hover',
              )}
            >
              {agent.emoji || '🤖'}
              <span className={cn(
                'absolute right-1 top-1 h-2 w-2 rounded-full border border-surface',
                agent.activeExecutions > 0 ? 'animate-pulse bg-blue-400' : 'bg-emerald-400',
              )} />
            </button>
          ))
        ) : (
          ['Core', 'Content', 'Specialists'].filter(group => grouped[group]?.length).map(group => (
            <div key={group}>
              <div className="mb-1 px-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-gray-600">{group}</div>
              <div className="space-y-1">
                {grouped[group].map(agent => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => setSelectedAgentId(agent.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition',
                      selectedAgentId === agent.id
                        ? 'bg-accent/15 text-accent-light'
                        : 'text-gray-400 hover:bg-surface-hover hover:text-gray-200',
                    )}
                  >
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-background text-base">
                      {agent.emoji || '🤖'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{agent.name}</span>
                      <span className="mt-0.5 block truncate text-[9px] text-gray-600">{agent.role}</span>
                    </span>
                    <span className={cn(
                      'h-2 w-2 flex-none rounded-full',
                      agent.activeExecutions > 0 ? 'animate-pulse bg-blue-400' : 'bg-emerald-400',
                    )} />
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={() => setActiveView('agent-settings')}
          title="Manage Agents"
          className={cn(
            'flex w-full items-center rounded-lg text-gray-500 transition hover:bg-surface-hover hover:text-gray-200',
            agentDirectoryCollapsed ? 'h-10 justify-center' : 'gap-2 px-3 py-2 text-xs',
          )}
        >
          <span>⚙</span>
          {!agentDirectoryCollapsed && <span>Manage Agents</span>}
        </button>
      </div>
    </aside>
  );
}

function statusClass(status?: string) {
  if (status === 'done') return 'bg-emerald-500/10 text-emerald-300';
  if (status === 'failed' || status === 'cancelled') return 'bg-red-500/10 text-red-300';
  return 'bg-blue-500/10 text-blue-300';
}

function AgentInspector() {
  const {
    selectedAgentId,
    agents,
    tasks,
    executions,
    executionMessages,
    rightPanelTab,
    setRightPanelTab,
    setAgentInspectorOpen,
    setSelectedTaskId,
    setActiveView,
    loadExecutionMessages,
  } = useStore();
  const agent = agents.find(item => item.id === selectedAgentId);
  const agentTasks = useMemo(
    () => tasks
      .filter(task => task.assigneeId === selectedAgentId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tasks, selectedAgentId],
  );
  const agentExecutions = useMemo(
    () => executions
      .filter(execution => execution.agentDefId === selectedAgentId)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    [executions, selectedAgentId],
  );
  const latestExecution = agentExecutions[0];
  const hasActiveExecution = latestExecution?.status === 'running';
  const latestMessages = latestExecution ? executionMessages[latestExecution.id] || [] : [];

  useEffect(() => {
    if (latestExecution?.id) void loadExecutionMessages(latestExecution.id);
  }, [latestExecution?.id, loadExecutionMessages]);

  if (!agent) return null;

  const openTask = (taskId: string) => {
    setSelectedTaskId(taskId);
    setActiveView('timeline');
  };

  return (
    <aside
      data-testid="agent-inspector"
      className="absolute inset-y-0 right-0 z-30 flex w-80 flex-col border-l border-border bg-surface shadow-2xl xl:static xl:z-auto xl:shadow-none 2xl:w-[350px]"
    >
      <div className="flex items-center gap-2 border-b border-border p-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Agent Inspector</div>
          <div className="mt-0.5 truncate text-[10px] text-gray-600">{agent.name} · {agent.role}</div>
        </div>
        <button
          type="button"
          onClick={() => setAgentInspectorOpen(false)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-surface-hover hover:text-white"
          aria-label="Close Agent inspector"
        >
          ×
        </button>
      </div>
      <div className="flex gap-1 border-b border-border p-2">
        <button
          type="button"
          onClick={() => setRightPanelTab('chat')}
          className={cn(
            'flex-1 rounded-lg px-2 py-1.5 text-[10px] font-medium',
            rightPanelTab === 'chat' ? 'bg-accent/15 text-accent-light' : 'text-gray-500 hover:text-gray-300',
          )}
        >
          {hasActiveExecution ? 'Active Run' : 'Latest Run'}
        </button>
        <button
          type="button"
          onClick={() => setRightPanelTab('history')}
          className={cn(
            'flex-1 rounded-lg px-2 py-1.5 text-[10px] font-medium',
            rightPanelTab === 'history' ? 'bg-accent/15 text-accent-light' : 'text-gray-500 hover:text-gray-300',
          )}
        >
          History
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {rightPanelTab === 'chat' ? (
          <div className="space-y-3">
            {!latestExecution && (
              <div className="rounded-xl border border-border bg-background p-4 text-center text-xs text-gray-600">
                Run this Agent to populate execution details.
              </div>
            )}
            {latestExecution && (
              <>
                <div className="rounded-xl border border-border bg-background p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-gray-600">
                      {hasActiveExecution ? 'Active execution' : 'Latest execution'}
                    </span>
                    <span className={cn('rounded px-2 py-1 text-[9px]', statusClass(latestExecution.status))}>
                      {latestExecution.status}
                    </span>
                  </div>
                  <div className="mt-2 truncate text-xs font-semibold">{latestExecution.id}</div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
                    <div className="rounded-lg bg-surface p-2">
                      <div className="text-gray-600">Model</div>
                      <div className="mt-1 truncate text-gray-300">{latestExecution.modelId || '-'}</div>
                    </div>
                    <div className="rounded-lg bg-surface p-2">
                      <div className="text-gray-600">Tokens</div>
                      <div className="mt-1 text-gray-300">{latestExecution.tokenCount}</div>
                    </div>
                    <div className="rounded-lg bg-surface p-2">
                      <div className="text-gray-600">Cost</div>
                      <div className="mt-1 text-gray-300">{latestExecution.costUSD == null ? 'N/A · subscription' : `$${latestExecution.costUSD.toFixed(4)}`}</div>
                    </div>
                    <div className="rounded-lg bg-surface p-2">
                      <div className="text-gray-600">Started</div>
                      <div className="mt-1 truncate text-gray-300">{new Date(latestExecution.startedAt).toLocaleTimeString()}</div>
                    </div>
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-gray-600">Activity</div>
                  <div className="space-y-2">
                    {latestMessages.slice(-8).map(message => (
                      <div key={message.id} className="rounded-lg border border-border bg-background p-2.5">
                        <div className="text-[9px] text-gray-600">{message.type}{message.toolName ? ` · ${message.toolName}` : ''}</div>
                        <div className="mt-1 line-clamp-3 text-[10px] leading-relaxed text-gray-400">{message.content}</div>
                      </div>
                    ))}
                    {latestMessages.length === 0 && <div className="text-xs text-gray-600">No activity messages yet.</div>}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {agentTasks.map(task => (
              <button
                key={task.id}
                type="button"
                onClick={() => openTask(task.id)}
                className="w-full rounded-xl border border-border bg-background p-3 text-left transition hover:border-accent/30"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold">{task.title}</span>
                  <span className={cn('rounded px-1.5 py-0.5 text-[9px]', statusClass(task.status))}>{task.status}</span>
                </div>
                <div className="mt-1 text-[9px] text-gray-600">{new Date(task.createdAt).toLocaleString()}</div>
                {task.output && <div className="mt-2 line-clamp-2 text-[10px] text-gray-500">{task.output}</div>}
              </button>
            ))}
            {agentTasks.length === 0 && <div className="py-8 text-center text-xs text-gray-600">No task history</div>}
          </div>
        )}
      </div>
    </aside>
  );
}

export function AgentWorkspace() {
  const { agentInspectorOpen, selectedAgentId, agents } = useStore();
  const selectedAgent = agents.find(agent => agent.id === selectedAgentId);
  const showContentStudio = usesContentStudio(selectedAgent);

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-background">
      <AgentDirectory />
      <section className="min-w-0 flex-1 bg-background">
        {showContentStudio ? <ContentStudio key={selectedAgentId} /> : <AgentChatPanel key={selectedAgentId} />}
      </section>
      {!showContentStudio && agentInspectorOpen && <AgentInspector />}
    </div>
  );
}
