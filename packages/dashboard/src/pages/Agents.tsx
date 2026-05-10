import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { AgentSummary, ModelDefinition } from '@agent-factory/shared';
import { useStore } from '../stores/store';
import { cn } from '../lib/utils';
import { api } from '../lib/api';
import { AgentPet } from '../components/agents/AgentPet';
import { AgentWorkbench } from '../components/agents/AgentWorkbench';
import { AgentSetupWizard } from '../components/agents/AgentSetupWizard';
import { AuditDrawer } from '../components/audit/AuditDrawer';

const statusColors: Record<string, string> = {
  idle: 'bg-emerald-500',
  working: 'bg-blue-500 animate-pulse',
};

const statusLabels: Record<string, string> = {
  idle: 'Ready',
  working: 'Working',
};

const TOOL_PRESETS = [
  { id: 'web.search', label: 'Web Search', hint: '搜索趋势、竞品、资料' },
  { id: 'web.fetch', label: 'Web Fetch', hint: '抓取网页正文' },
  { id: 'crawler.extract_links', label: 'Crawler Links', hint: '提取页面链接' },
  { id: 'content.wechat_layout', label: 'WeChat Layout', hint: '公众号排版 HTML' },
  { id: 'content.hashtag_plan', label: 'Hashtag Plan', hint: '标签/关键词策略' },
  { id: 'image.generate_svg', label: 'SVG Image', hint: '生成封面 SVG' },
];

const COPILOT_MODEL_OPTIONS = [
  { value: 'openai/claude-opus-4.7', label: 'Claude Opus 4.7', hint: '最强复杂推理，适合 Master / 深度架构 / 高风险 Review' },
  { value: 'openai/claude-opus-4.6', label: 'Claude Opus 4.6', hint: '复杂规划和长上下文分析' },
  { value: 'openai/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', hint: '高质量均衡模型，适合 PM / Review / 内容创作' },
  { value: 'openai/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', hint: '稳定均衡模型，适合多数 Agent' },
  { value: 'openai/claude-haiku-4.5', label: 'Claude Haiku 4.5', hint: '快速低成本任务，适合 QA / i18n / 简单处理' },
  { value: 'openai/claude-sonnet-4', label: 'Claude Sonnet 4', hint: 'Claude Sonnet 备选' },
  { value: 'openai/gpt-5.5', label: 'GPT-5.5', hint: '最强通用推理，适合 Master / Review / 复杂规划' },
  { value: 'openai/gpt-5.4', label: 'GPT-5.4', hint: '默认均衡模型，适合 PM / 内容 / 多数任务' },
  { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', hint: '低成本快速任务，适合 QA / i18n / 简单文档' },
  { value: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex', hint: '代码实现、重构、工程任务' },
  { value: 'openai/gpt-5.2-codex', label: 'GPT-5.2 Codex', hint: '代码任务备选' },
  { value: 'openai/gpt-5.2', label: 'GPT-5.2', hint: '通用任务备选' },
  { value: 'openai/gpt-5-mini', label: 'GPT-5 mini', hint: '便宜快速的轻量任务' },
  { value: 'openai/gpt-4.1', label: 'GPT-4.1', hint: '兼容性强的快速模型' },
];

function modelOptionFromDefinition(model: ModelDefinition) {
  return {
    value: model.id,
    label: model.displayName,
    hint: `${model.fallbackGroup} · ${model.healthStatus} · ${model.capabilityTags.join(', ')}`,
  };
}

const QUICK_AGENT_TEMPLATES = [
  {
    name: '研究助理',
    emoji: '🔎',
    role: 'researcher',
    description: '面向热点、竞品、技术方案的资料搜索、事实查证和摘要整理',
    capabilities: 'web-research, summarization, fact-checking',
    triggers: '调研, research, 搜索, 资料',
    allowedTools: ['web.search', 'web.fetch', 'crawler.extract_links'],
  },
  {
    name: '视觉内容助手',
    emoji: '🖼️',
    role: 'visual-designer',
    description: '为文章、落地页和社媒内容生成封面图 brief 与 SVG 草稿',
    capabilities: 'cover-design, image-generation, layout',
    triggers: '封面, 图片, 视觉, cover',
    allowedTools: ['image.generate_svg'],
  },
  {
    name: '公众号运营助手',
    emoji: '📰',
    role: 'content-operator',
    description: '负责公众号选题、写作、排版、封面和标签优化的一体化交付',
    capabilities: 'wechat, copywriting, seo, layout, image-generation',
    triggers: '公众号, 排版, 推文, 文章',
    allowedTools: ['web.search', 'web.fetch', 'content.wechat_layout', 'content.hashtag_plan', 'image.generate_svg'],
  },
];

const inputClass = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

interface AgentFormState {
  name: string;
  role: string;
  emoji: string;
  description: string;
  capabilities: string;
  triggers: string;
  model: string;
  maxTurns: number;
  timeout: number;
  allowedTools: string[];
}

const emptyForm: AgentFormState = {
  name: '',
  role: 'custom',
  emoji: '🤖',
  description: '',
  capabilities: '',
  triggers: '',
  model: 'openai/claude-sonnet-4.6',
  maxTurns: 50,
  timeout: 300,
  allowedTools: [],
};

function derivedStatus(agent: { activeExecutions?: number }): 'idle' | 'working' {
  return (agent.activeExecutions || 0) > 0 ? 'working' : 'idle';
}

function splitCSV(value: string): string[] {
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

function uniqueRoles(agents: AgentSummary[]) {
  return Array.from(new Set(agents.map(agent => agent.role))).sort();
}

function formFromAgent(agent: AgentSummary): AgentFormState {
  const allowedTools = agent.allowedTools || agent.config?.allowedTools || [];
  return {
    name: agent.name,
    role: agent.role,
    emoji: agent.emoji || '🤖',
    description: agent.description || agent.whenToUse || '',
    capabilities: (agent.capabilities || []).join(', '),
    triggers: (agent.triggers || []).join(', '),
    model: agent.model || agent.config?.model || emptyForm.model,
    maxTurns: agent.maxTurns || agent.config?.maxTurns || emptyForm.maxTurns,
    timeout: agent.config?.timeout || emptyForm.timeout,
    allowedTools,
  };
}

export function AgentsPage() {
  const { agents, loadAgents, models, loadModels } = useStore();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [isBuilderOpen, setIsBuilderOpen] = useState(true);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [workbenchAgentId, setWorkbenchAgentId] = useState<string | null>(null);
  const [form, setForm] = useState<AgentFormState>(emptyForm);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const roles = useMemo(() => uniqueRoles(agents), [agents]);
  const modelOptions = useMemo(() => {
    const dynamicOptions = models.filter(model => model.enabled).map(modelOptionFromDefinition);
    const options = dynamicOptions.length > 0 ? dynamicOptions : COPILOT_MODEL_OPTIONS;
    return options.some(option => option.value === form.model)
      ? options
      : [{ value: form.model, label: form.model, hint: 'current saved model' }, ...options];
  }, [models, form.model]);
  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter(agent => {
      const matchesRole = roleFilter === 'all' || agent.role === roleFilter;
      const text = [
        agent.name,
        agent.role,
        agent.description,
        ...(agent.capabilities || []),
        ...(agent.allowedTools || agent.config?.allowedTools || []),
      ].join(' ').toLowerCase();
      return matchesRole && (!q || text.includes(q));
    });
  }, [agents, query, roleFilter]);

  const runningCount = agents.filter(a => (a.activeExecutions || 0) > 0).length;
  const toolEnabledCount = agents.filter(a => (a.allowedTools || a.config?.allowedTools || []).length > 0).length;
  const workbenchAgent = agents.find(agent => agent.id === workbenchAgentId) || filteredAgents[0] || agents[0];

  useEffect(() => {
    if (models.length === 0) void loadModels();
  }, [models.length]);

  useEffect(() => {
    if (!workbenchAgentId && agents.length > 0) setWorkbenchAgentId(agents[0].id);
  }, [agents.length, workbenchAgentId]);

  const updateForm = <K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const toggleTool = (toolId: string) => {
    setForm(prev => ({
      ...prev,
      allowedTools: prev.allowedTools.includes(toolId)
        ? prev.allowedTools.filter(id => id !== toolId)
        : [...prev.allowedTools, toolId],
    }));
  };

  const applyTemplate = (template: typeof QUICK_AGENT_TEMPLATES[number]) => {
    setEditingAgentId(null);
    setForm({
      ...emptyForm,
      ...template,
      model: emptyForm.model,
      maxTurns: emptyForm.maxTurns,
      timeout: emptyForm.timeout,
    });
    setIsBuilderOpen(true);
  };

  const startEditing = (agent: AgentSummary) => {
    setEditingAgentId(agent.id);
    setForm(formFromAgent(agent));
    setError('');
    setIsBuilderOpen(true);
  };

  const resetBuilder = () => {
    setEditingAgentId(null);
    setForm(emptyForm);
    setError('');
  };

  const submitAgent = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const payload = {
        name: form.name.trim(),
        role: form.role.trim(),
        emoji: form.emoji.trim() || '🤖',
        description: form.description.trim(),
        whenToUse: form.description.trim(),
        capabilities: splitCSV(form.capabilities),
        triggers: splitCSV(form.triggers),
        allowedTools: form.allowedTools,
        model: form.model.trim(),
        maxTurns: form.maxTurns,
        config: {
          model: form.model.trim(),
          maxTurns: form.maxTurns,
          timeout: form.timeout,
          maxConcurrent: 1,
          allowedTools: form.allowedTools,
        },
      };
      if (editingAgentId) {
        await api.agents.update(editingAgentId, payload);
      } else {
        await api.agents.create(payload);
      }
      resetBuilder();
      await loadAgents();
    } catch (err: any) {
      setError(err.message || (editingAgentId ? 'Update agent failed' : 'Create agent failed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="rounded-2xl border border-border bg-gradient-to-br from-surface to-background p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.24em] text-accent-light">Agent Control Center</div>
            <h2 className="mt-2 text-3xl font-bold">Agents</h2>
            <p className="mt-2 max-w-2xl text-sm text-gray-400">
              管理内置 Agent、自定义 Agent、能力标签和工具白名单。动态创建的 Agent 会直接进入 DB，并通过 runtime 传入对应 skill 与 tools。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <AuditDrawer targetType="agent" label="Audit" />
            <button
              onClick={() => setIsWizardOpen(true)}
              className="rounded-xl bg-purple-500/20 px-4 py-2 text-sm font-semibold text-purple-200 hover:bg-purple-500/30"
            >
              Setup Wizard
            </button>
            <button
              onClick={() => {
                if (!isBuilderOpen) resetBuilder();
                setIsBuilderOpen(v => !v);
              }}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/90"
            >
              {isBuilderOpen ? 'Hide Builder' : '+ Create Agent'}
            </button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Total Agents" value={agents.length} />
          <Metric label="Running" value={runningCount} tone="blue" />
          <Metric label="Tool Enabled" value={toolEnabledCount} tone="purple" />
          <Metric label="Roles" value={roles.length} tone="green" />
        </div>
      </div>

      <div className={cn('grid gap-6', isBuilderOpen ? 'xl:grid-cols-[1fr_420px]' : 'grid-cols-1')}>
        <div className="space-y-4">
          {workbenchAgent && (
            <AgentWorkbench agent={workbenchAgent} onEdit={startEditing} />
          )}

          <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 md:flex-row md:items-center">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, role, capability, tool..."
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <select
              value={roleFilter}
              onChange={(event) => setRoleFilter(event.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            >
              <option value="all">All roles</option>
              {roles.map(role => <option key={role} value={role}>{role}</option>)}
            </select>
            <button
              onClick={() => loadAgents()}
              className="rounded-lg bg-surface-hover px-3 py-2 text-sm text-gray-300 hover:text-white"
            >
              Refresh
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {filteredAgents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                selected={workbenchAgent?.id === agent.id}
                onInspect={setWorkbenchAgentId}
                onEdit={startEditing}
              />
            ))}
          </div>
        </div>

        {isBuilderOpen && (
          <aside className="rounded-2xl border border-border bg-surface p-5">
            <div className="mb-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold">{editingAgentId ? 'Edit Agent' : 'Create Custom Agent'}</h3>
                  <p className="mt-1 text-xs text-gray-500">
                    {editingAgentId
                      ? `正在编辑 ${editingAgentId}：保存后 runtime 会使用新的 skill overlay 和 tools。`
                      : '选择模板或从空白开始，给 Agent 绑定专属工具。'}
                  </p>
                </div>
                {editingAgentId && (
                  <button
                    type="button"
                    onClick={resetBuilder}
                    className="rounded-lg bg-background px-2 py-1 text-xs text-gray-400 hover:text-white"
                  >
                    New
                  </button>
                )}
              </div>
            </div>

            {!editingAgentId && (
              <div className="mb-4 grid grid-cols-1 gap-2">
                {QUICK_AGENT_TEMPLATES.map(template => (
                  <button
                    key={template.role}
                    type="button"
                    onClick={() => applyTemplate(template)}
                    className="rounded-lg border border-border bg-background p-3 text-left text-xs hover:border-accent/40"
                  >
                    <span className="mr-2 text-base">{template.emoji}</span>
                    <span className="font-medium text-gray-200">{template.name}</span>
                    <span className="ml-2 text-gray-500">{template.role}</span>
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={submitAgent} className="space-y-3">
              <div className="grid grid-cols-[72px_1fr] gap-2">
                <Field label="Emoji">
                  <input value={form.emoji} onChange={e => updateForm('emoji', e.target.value)} className={inputClass} />
                </Field>
                <Field label="Name">
                  <input required value={form.name} onChange={e => updateForm('name', e.target.value)} className={inputClass} />
                </Field>
              </div>
              <Field label="Role">
                <input required value={form.role} onChange={e => updateForm('role', e.target.value)} className={inputClass} />
              </Field>
              <Field label="Description / Skill">
                <textarea
                  required
                  value={form.description}
                  onChange={e => updateForm('description', e.target.value)}
                  className={cn(inputClass, 'min-h-24 resize-none')}
                  placeholder="这个 Agent 的工作方式、边界、输出格式..."
                />
              </Field>
              <Field label="Capabilities">
                <input value={form.capabilities} onChange={e => updateForm('capabilities', e.target.value)} className={inputClass} placeholder="web-research, copywriting, layout" />
              </Field>
              <Field label="Triggers">
                <input value={form.triggers} onChange={e => updateForm('triggers', e.target.value)} className={inputClass} placeholder="调研, 文章, research" />
              </Field>

              <div>
                <div className="mb-2 text-xs font-medium text-gray-400">Allowed Tools</div>
                <div className="grid grid-cols-1 gap-2">
                  {TOOL_PRESETS.map(tool => (
                    <label key={tool.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-background p-2 hover:border-accent/30">
                      <input
                        type="checkbox"
                        checked={form.allowedTools.includes(tool.id)}
                        onChange={() => toggleTool(tool.id)}
                        className="mt-1"
                      />
                      <span>
                        <span className="block text-xs font-semibold text-gray-200">{tool.label}</span>
                        <span className="block text-[11px] text-gray-500">{tool.id} · {tool.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <Field label="Model">
                  <select value={form.model} onChange={e => updateForm('model', e.target.value)} className={inputClass}>
                    {modelOptions.map(model => (
                      <option key={model.value} value={model.value}>
                        {model.label} — {model.hint}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Turns">
                  <input type="number" min={1} value={form.maxTurns} onChange={e => updateForm('maxTurns', Number(e.target.value))} className={inputClass} />
                </Field>
                <Field label="Timeout">
                  <input type="number" min={30} value={form.timeout} onChange={e => updateForm('timeout', Number(e.target.value))} className={inputClass} />
                </Field>
              </div>

              {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-2 text-xs text-red-300">{error}</div>}
              <button
                disabled={isSubmitting}
                className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-60"
              >
                {isSubmitting
                  ? (editingAgentId ? 'Saving...' : 'Creating...')
                  : (editingAgentId ? 'Save Agent' : 'Create Agent')}
              </button>
            </form>
          </aside>
        )}
      </div>
      <AgentSetupWizard
        open={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        templates={QUICK_AGENT_TEMPLATES}
        toolPresets={TOOL_PRESETS}
        modelOptions={modelOptions}
        onCreated={async (agentId) => {
          setWorkbenchAgentId(agentId);
          setIsBuilderOpen(false);
          await loadAgents();
        }}
      />
    </div>
  );
}

function Metric({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'blue' | 'purple' | 'green' }) {
  const toneClass = {
    default: 'text-gray-100',
    blue: 'text-blue-300',
    purple: 'text-purple-300',
    green: 'text-emerald-300',
  }[tone];
  return (
    <div className="rounded-xl border border-border bg-background/70 p-4">
      <div className={cn('text-2xl font-bold', toneClass)}>{value}</div>
      <div className="mt-1 text-xs text-gray-500">{label}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function AgentCard({
  agent,
  selected,
  onInspect,
  onEdit,
}: {
  agent: AgentSummary;
  selected: boolean;
  onInspect: (agentId: string) => void;
  onEdit: (agent: AgentSummary) => void;
}) {
  const status = derivedStatus(agent);
  const tools = agent.allowedTools || agent.config?.allowedTools || [];
  const topCapabilities = (agent.capabilities || []).slice(0, 4);

  return (
    <div className={cn(
      'rounded-xl border bg-surface p-5 transition hover:border-accent/30 hover:shadow-lg hover:shadow-accent/5',
      selected ? 'border-accent/50 ring-1 ring-accent/20' : 'border-border',
    )}>
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-background text-3xl">{agent.emoji || '🤖'}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{agent.name}</div>
          <div className="text-xs text-gray-500">{agent.role}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full', statusColors[status])} />
          <span className="text-xs text-gray-400">{statusLabels[status]}</span>
        </div>
      </div>

      {agent.description && (
        <p className="mb-4 line-clamp-2 text-xs leading-relaxed text-gray-400">{agent.description}</p>
      )}

      <div className="mb-4 flex items-center gap-3">
        <AgentPet agent={agent} size={52} />
        <div className="grid flex-1 grid-cols-3 gap-2">
          <Stat label="Done" value={agent.stats?.tasksCompleted || 0} tone="text-emerald-400" />
          <Stat label="Failed" value={agent.stats?.tasksFailed || 0} tone="text-red-400" />
          <Stat label="Avg" value={agent.stats?.avgDurationMs ? `${Math.round(agent.stats.avgDurationMs / 1000)}s` : '-'} />
        </div>
      </div>

      {topCapabilities.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {topCapabilities.map(capability => (
            <span key={capability} className="rounded-full bg-accent/10 px-2 py-1 text-[10px] text-accent-light">{capability}</span>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-border bg-background p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-gray-300">Tools</span>
          <span className="text-[10px] text-gray-500">{tools.length} enabled</span>
        </div>
        {tools.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {tools.slice(0, 5).map(tool => (
              <span key={tool} className="rounded bg-surface-hover px-1.5 py-1 text-[10px] text-gray-300">{tool}</span>
            ))}
            {tools.length > 5 && <span className="text-[10px] text-gray-500">+{tools.length - 5}</span>}
          </div>
        ) : (
          <div className="text-[11px] text-gray-600">No external tools</div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onInspect(agent.id)}
          className="rounded-lg bg-surface-hover px-3 py-2 text-xs font-semibold text-gray-300 hover:text-white"
        >
          Workbench
        </button>
        <button
          type="button"
          onClick={() => onEdit(agent)}
          className="rounded-lg bg-accent/10 px-3 py-2 text-xs font-semibold text-accent-light hover:bg-accent/20"
        >
          Edit
        </button>
      </div>

      {(agent.activeExecutions || 0) > 0 && (
        <div className="mt-3 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-300">
          {agent.activeExecutions} active execution{agent.activeExecutions === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone = 'text-gray-300' }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-lg bg-background p-2 text-center">
      <div className={cn('text-lg font-bold', tone)}>{value}</div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  );
}
