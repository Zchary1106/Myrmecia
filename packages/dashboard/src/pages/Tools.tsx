import { useEffect, useMemo, useState } from 'react';
import type { AgentSummary, ToolDefinition, ToolExecution, ToolPermission } from '@myrmecia/shared';
import { api } from '../lib/api';
import { useStore } from '../stores/store';
import { cn } from '../lib/utils';
import { AuditDrawer } from '../components/audit/AuditDrawer';

const riskClass: Record<ToolDefinition['riskLevel'], string> = {
  low: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  medium: 'border-yellow-500/20 bg-yellow-500/10 text-yellow-300',
  high: 'border-red-500/20 bg-red-500/10 text-red-300',
};

const statusClass: Record<ToolExecution['status'], string> = {
  running: 'text-blue-300',
  done: 'text-emerald-300',
  failed: 'text-red-300',
  blocked: 'text-yellow-300',
};

export function ToolsPage() {
  const { tools, toolExecutions, agents, loadTools, loadToolExecutions, loadAgents } = useStore();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [savingToolId, setSavingToolId] = useState<string | null>(null);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [toolDetail, setToolDetail] = useState<(ToolDefinition & { permissions: ToolPermission[]; recentExecutions: ToolExecution[] }) | null>(null);
  const [savingPermission, setSavingPermission] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void loadTools();
    void loadToolExecutions();
  }, []);

  const categories = useMemo(() => Array.from(new Set(tools.map(tool => tool.category))).sort(), [tools]);
  const filteredTools = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tools.filter(tool => {
      const haystack = [tool.id, tool.name, tool.description, tool.category, tool.riskLevel].join(' ').toLowerCase();
      return (category === 'all' || tool.category === category) && (!needle || haystack.includes(needle));
    });
  }, [tools, query, category]);

  useEffect(() => {
    if (!selectedToolId && filteredTools.length > 0) setSelectedToolId(filteredTools[0].id);
  }, [filteredTools, selectedToolId]);

  useEffect(() => {
    if (!selectedToolId) {
      setToolDetail(null);
      return;
    }
    let active = true;
    api.tools.get(selectedToolId)
      .then(detail => { if (active) setToolDetail(detail); })
      .catch((err: any) => { if (active) setError(err.message || 'Load tool policy failed'); });
    return () => { active = false; };
  }, [selectedToolId]);

  const agentUsage = useMemo(() => {
    const usage = new Map<string, number>();
    for (const agent of agents) {
      for (const toolId of agent.allowedTools || agent.config?.allowedTools || []) {
        usage.set(toolId, (usage.get(toolId) || 0) + 1);
      }
    }
    return usage;
  }, [agents]);

  const toggleTool = async (tool: ToolDefinition, updates: { enabled?: boolean; approvalRequired?: boolean }) => {
    setError('');
    setSavingToolId(tool.id);
    try {
      await api.tools.update(tool.id, updates);
      await Promise.all([loadTools(), loadToolExecutions(), selectedToolId ? api.tools.get(selectedToolId).then(setToolDetail) : Promise.resolve()]);
    } catch (err: any) {
      setError(err.message || 'Update tool failed');
    } finally {
      setSavingToolId(null);
    }
  };

  const updateAgentToolRequest = async (tool: ToolDefinition, agent: AgentSummary, requested: boolean) => {
    setError('');
    setSavingPermission(`${tool.id}:${agent.id}:request`);
    try {
      const currentTools = agent.allowedTools || agent.config?.allowedTools || [];
      const nextTools = requested
        ? Array.from(new Set([...currentTools, tool.id]))
        : currentTools.filter(id => id !== tool.id);
      await api.agents.update(agent.id, {
        allowedTools: nextTools,
        config: { ...agent.config, allowedTools: nextTools },
      });
      await Promise.all([loadAgents(), selectedToolId ? api.tools.get(selectedToolId).then(setToolDetail) : Promise.resolve()]);
    } catch (err: any) {
      setError(err.message || 'Update agent tools failed');
    } finally {
      setSavingPermission(null);
    }
  };

  const updateToolPermission = async (
    tool: ToolDefinition,
    agent: AgentSummary,
    updates: { enabled?: boolean; approvalRequired?: boolean },
  ) => {
    setError('');
    setSavingPermission(`${tool.id}:${agent.id}:policy`);
    try {
      const permission = toolDetail?.permissions.find(item => item.agentId === agent.id);
      await api.tools.setPermission(tool.id, agent.id, {
        enabled: updates.enabled ?? permission?.enabled ?? true,
        approvalRequired: updates.approvalRequired ?? permission?.approvalRequired ?? tool.approvalRequired,
      });
      if (selectedToolId) setToolDetail(await api.tools.get(selectedToolId));
      await loadToolExecutions();
    } catch (err: any) {
      setError(err.message || 'Update tool permission failed');
    } finally {
      setSavingPermission(null);
    }
  };

  const recentByTool = useMemo(() => {
    const map = new Map<string, ToolExecution[]>();
    for (const execution of toolExecutions) {
      const list = map.get(execution.toolId) || [];
      if (list.length < 3) list.push(execution);
      map.set(execution.toolId, list);
    }
    return map;
  }, [toolExecutions]);

  return (
    <div className="p-6 space-y-6">
      <div className="rounded-2xl border border-border bg-gradient-to-br from-surface to-background p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.24em] text-accent-light">Tool Runtime</div>
            <h2 className="mt-2 text-3xl font-bold">Tool Catalog</h2>
            <p className="mt-2 max-w-2xl text-sm text-gray-400">
              管理平台内置工具、风险等级、启用状态和最近执行记录。Agent 运行前会经过这里的策略过滤。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <AuditDrawer targetType="tool" label="Audit" />
            <button
              onClick={() => Promise.all([loadTools(), loadToolExecutions()])}
              className="rounded-xl bg-surface-hover px-4 py-2 text-sm text-gray-300 hover:text-white"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Tools" value={tools.length} />
          <Metric label="Enabled" value={tools.filter(tool => tool.enabled).length} tone="green" />
          <Metric label="Approval Required" value={tools.filter(tool => tool.approvalRequired).length} tone="yellow" />
          <Metric label="Executions" value={toolExecutions.length} tone="blue" />
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 md:flex-row md:items-center">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search tool id, name, category..."
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <select
          value={category}
          onChange={event => setCategory(event.target.value)}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
        >
          <option value="all">All categories</option>
          {categories.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_440px]">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {filteredTools.map(tool => (
            <ToolCard
              key={tool.id}
              tool={tool}
              selected={selectedToolId === tool.id}
              saving={savingToolId === tool.id}
              usedBy={agentUsage.get(tool.id) || 0}
              recentExecutions={recentByTool.get(tool.id) || []}
              onInspect={() => setSelectedToolId(tool.id)}
              onToggle={updates => toggleTool(tool, updates)}
            />
          ))}
        </div>

        <ToolPolicyPanel
          tool={toolDetail || tools.find(tool => tool.id === selectedToolId) || null}
          permissions={toolDetail?.permissions || []}
          agents={agents}
          recentExecutions={toolDetail?.recentExecutions || (selectedToolId ? recentByTool.get(selectedToolId) || [] : toolExecutions.slice(0, 8))}
          savingKey={savingPermission}
          onToggleRequest={updateAgentToolRequest}
          onUpdatePermission={updateToolPermission}
        />
      </div>
    </div>
  );
}

function ToolCard({
  tool,
  selected,
  saving,
  usedBy,
  recentExecutions,
  onInspect,
  onToggle,
}: {
  tool: ToolDefinition;
  selected: boolean;
  saving: boolean;
  usedBy: number;
  recentExecutions: ToolExecution[];
  onInspect: () => void;
  onToggle: (updates: { enabled?: boolean; approvalRequired?: boolean }) => void;
}) {
  return (
    <div className={cn(
      'rounded-xl border bg-surface p-5 transition hover:border-accent/30',
      selected ? 'border-accent/50 ring-1 ring-accent/20' : 'border-border',
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{tool.name}</div>
          <div className="mt-1 text-xs text-gray-500">{tool.id}</div>
        </div>
        <div className="flex items-center gap-2">
          <AuditDrawer targetType="tool" targetId={tool.id} label="Audit" />
          <span className={cn('rounded-full border px-2 py-1 text-[10px] font-semibold', riskClass[tool.riskLevel])}>
            {tool.riskLevel}
          </span>
        </div>
      </div>

      <p className="mt-3 min-h-10 text-xs leading-relaxed text-gray-400">{tool.description}</p>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <Metric label="Category" value={tool.category} small />
        <Metric label="Agents" value={usedBy} small />
        <Metric label="Recent" value={recentExecutions.length} small />
      </div>

      <div className="mt-4 space-y-2 rounded-lg border border-border bg-background p-3">
        <label className="flex cursor-pointer items-center justify-between text-xs">
          <span className="text-gray-300">Enabled</span>
          <input
            type="checkbox"
            checked={tool.enabled}
            disabled={saving}
            onChange={event => onToggle({ enabled: event.target.checked })}
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between text-xs">
          <span className="text-gray-300">Require approval</span>
          <input
            type="checkbox"
            checked={tool.approvalRequired}
            disabled={saving}
            onChange={event => onToggle({ approvalRequired: event.target.checked })}
          />
        </label>
      </div>

      <button
        type="button"
        onClick={onInspect}
        className="mt-3 w-full rounded-lg bg-accent/10 px-3 py-2 text-xs font-semibold text-accent-light hover:bg-accent/20"
      >
        Permissions
      </button>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {Object.entries(tool.metadata || {}).slice(0, 4).map(([key, value]) => (
          <span key={key} className="rounded bg-background px-1.5 py-1 text-[10px] text-gray-500">
            {key}: {String(value)}
          </span>
        ))}
      </div>
    </div>
  );
}

function ToolPolicyPanel({
  tool,
  permissions,
  agents,
  recentExecutions,
  savingKey,
  onToggleRequest,
  onUpdatePermission,
}: {
  tool: ToolDefinition | null;
  permissions: ToolPermission[];
  agents: AgentSummary[];
  recentExecutions: ToolExecution[];
  savingKey: string | null;
  onToggleRequest: (tool: ToolDefinition, agent: AgentSummary, requested: boolean) => void;
  onUpdatePermission: (tool: ToolDefinition, agent: AgentSummary, updates: { enabled?: boolean; approvalRequired?: boolean }) => void;
}) {
  const permissionByAgent = useMemo(() => new Map(permissions.map(permission => [permission.agentId, permission])), [permissions]);

  if (!tool) {
    return (
      <aside className="rounded-2xl border border-border bg-surface p-5">
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-gray-600">
          Select a tool to manage permissions
        </div>
      </aside>
    );
  }

  return (
    <aside className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-gray-300">Permission Matrix</h3>
          <div className="mt-1 truncate text-xs text-gray-500">{tool.id}</div>
        </div>
        <span className={cn('rounded-full border px-2 py-1 text-[10px] font-semibold', riskClass[tool.riskLevel])}>{tool.riskLevel}</span>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-background p-3 text-[11px] leading-relaxed text-gray-500">
        Requested 控制 Agent 配置中的 allowedTools；Policy 控制平台级 deny/allow；Approval 可覆盖该 Agent 对此工具的审批要求。
      </div>

      <div className="mt-4 space-y-2">
        {agents.map(agent => {
          const requestedTools = agent.allowedTools || agent.config?.allowedTools || [];
          const requested = requestedTools.includes(tool.id);
          const permission = permissionByAgent.get(agent.id);
          const policyAllowed = permission?.enabled ?? true;
          const approvalRequired = permission?.approvalRequired ?? tool.approvalRequired;
          const disabled = Boolean(savingKey?.startsWith(`${tool.id}:${agent.id}:`));
          const effectiveState = !tool.enabled
            ? 'tool disabled'
            : !requested
              ? 'not requested'
              : !policyAllowed
                ? 'blocked'
                : approvalRequired
                  ? 'approval'
                  : 'allowed';

          return (
            <div key={agent.id} className="rounded-xl border border-border bg-background p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold">{agent.emoji} {agent.name}</div>
                  <div className="mt-0.5 text-[10px] text-gray-600">{agent.role}</div>
                </div>
                <span className={cn(
                  'rounded px-2 py-0.5 text-[10px]',
                  effectiveState === 'allowed' && 'bg-emerald-500/10 text-emerald-300',
                  effectiveState === 'approval' && 'bg-yellow-500/10 text-yellow-300',
                  effectiveState === 'blocked' && 'bg-red-500/10 text-red-300',
                  ['not requested', 'tool disabled'].includes(effectiveState) && 'bg-gray-500/10 text-gray-500',
                )}>
                  {effectiveState}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[11px]">
                <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-2 py-2">
                  <span>Requested</span>
                  <input
                    type="checkbox"
                    checked={requested}
                    disabled={disabled}
                    onChange={event => onToggleRequest(tool, agent, event.target.checked)}
                  />
                </label>
                <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-2 py-2">
                  <span>Policy</span>
                  <input
                    type="checkbox"
                    checked={policyAllowed}
                    disabled={disabled}
                    onChange={event => onUpdatePermission(tool, agent, { enabled: event.target.checked })}
                  />
                </label>
                <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-2 py-2">
                  <span>Approval</span>
                  <input
                    type="checkbox"
                    checked={approvalRequired}
                    disabled={disabled}
                    onChange={event => onUpdatePermission(tool, agent, { approvalRequired: event.target.checked })}
                  />
                </label>
              </div>
            </div>
          );
        })}
        {agents.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-gray-600">
            No agents available
          </div>
        )}
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-gray-300">Recent Tool Executions</h3>
        <div className="mt-3 space-y-3">
          {recentExecutions.slice(0, 8).map(execution => (
            <div key={execution.id} className="rounded-lg border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-semibold">{execution.toolId}</span>
                <span className={cn('text-[10px] font-medium', statusClass[execution.status])}>{execution.status}</span>
              </div>
              <div className="mt-1 text-[10px] text-gray-600">
                {execution.agentId || 'unknown agent'} · {new Date(execution.startedAt).toLocaleString()}
              </div>
              {execution.inputSummary && (
                <div className="mt-2 line-clamp-2 text-[11px] text-gray-500">{execution.inputSummary}</div>
              )}
            </div>
          ))}
          {recentExecutions.length === 0 && (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-gray-600">
              No executions for this tool yet
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function Metric({
  label,
  value,
  tone = 'default',
  small = false,
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'green' | 'yellow' | 'blue';
  small?: boolean;
}) {
  const toneClass = {
    default: 'text-gray-100',
    green: 'text-emerald-300',
    yellow: 'text-yellow-300',
    blue: 'text-blue-300',
  }[tone];
  return (
    <div className={cn('rounded-xl border border-border bg-background/70 p-4', small && 'p-2')}>
      <div className={cn(small ? 'text-xs font-semibold' : 'text-2xl font-bold', toneClass)}>{value}</div>
      <div className="mt-1 text-[10px] text-gray-500">{label}</div>
    </div>
  );
}
