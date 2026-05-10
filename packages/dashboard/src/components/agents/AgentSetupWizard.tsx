import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentSummary } from '@agent-factory/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useStore } from '../../stores/store';

interface AgentTemplate {
  name: string;
  emoji: string;
  role: string;
  description: string;
  capabilities: string;
  triggers: string;
  allowedTools: string[];
}

interface ToolPreset {
  id: string;
  label: string;
  hint: string;
}

interface ModelOption {
  value: string;
  label: string;
  hint: string;
}

function splitCSV(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

export function AgentSetupWizard({
  open,
  onClose,
  templates,
  toolPresets,
  modelOptions,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  templates: AgentTemplate[];
  toolPresets: ToolPreset[];
  modelOptions: ModelOption[];
  onCreated: (agentId: string) => void;
}) {
  const {
    tools,
    skills,
    loadTools,
    loadSkills,
    loadSkillAssignments,
    setActiveView,
    setSelectedTaskId,
  } = useStore();
  const [step, setStep] = useState(0);
  const [selectedTemplateRole, setSelectedTemplateRole] = useState(templates[0]?.role || '');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [emoji, setEmoji] = useState('🤖');
  const [description, setDescription] = useState('');
  const [capabilities, setCapabilities] = useState('');
  const [triggers, setTriggers] = useState('');
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [model, setModel] = useState(modelOptions[0]?.value || 'openai/claude-sonnet-4.6');
  const [skillVersionId, setSkillVersionId] = useState('');
  const [testPrompt, setTestPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedTemplate = useMemo(
    () => templates.find(template => template.role === selectedTemplateRole) || templates[0],
    [templates, selectedTemplateRole],
  );

  const availableTools = useMemo(() => {
    if (tools.length === 0) return toolPresets.map(tool => ({ id: tool.id, name: tool.label, description: tool.hint }));
    return tools.map(tool => ({ id: tool.id, name: tool.name, description: `${tool.category} · ${tool.riskLevel}` }));
  }, [tools, toolPresets]);

  const publishedSkillOptions = useMemo(
    () => skills.filter(skill => skill.publishedVersionId).map(skill => ({
      skillId: skill.id,
      versionId: skill.publishedVersionId!,
      label: skill.name,
      description: skill.description || skill.sourcePath || skill.id,
    })),
    [skills],
  );

  useEffect(() => {
    if (!open) return;
    void Promise.all([loadTools(), loadSkills()]);
    setStep(0);
    setError('');
    if (selectedTemplate) applyTemplate(selectedTemplate);
  }, [open]);

  useEffect(() => {
    if (!open || !selectedTemplate) return;
    applyTemplate(selectedTemplate);
  }, [selectedTemplateRole]);

  useEffect(() => {
    if (!modelOptions.some(option => option.value === model) && modelOptions[0]) {
      setModel(modelOptions[0].value);
    }
  }, [modelOptions, model]);

  if (!open) return null;

  function applyTemplate(template: AgentTemplate) {
    setName(template.name);
    setRole(template.role);
    setEmoji(template.emoji);
    setDescription(template.description);
    setCapabilities(template.capabilities);
    setTriggers(template.triggers);
    setAllowedTools(template.allowedTools);
  }

  function toggleTool(toolId: string) {
    setAllowedTools(current => current.includes(toolId)
      ? current.filter(id => id !== toolId)
      : [...current, toolId]);
  }

  async function createAgent() {
    if (!name.trim() || !role.trim() || !description.trim()) {
      setError('Name, role and description are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload: Partial<AgentSummary> & { name: string; role: string } = {
        name: name.trim(),
        role: role.trim(),
        emoji: emoji.trim() || '🤖',
        description: description.trim(),
        whenToUse: description.trim(),
        capabilities: splitCSV(capabilities),
        triggers: splitCSV(triggers),
        allowedTools,
        model,
        maxTurns: 50,
        config: {
          model,
          maxTurns: 50,
          timeout: 300,
          maxConcurrent: 1,
          allowedTools,
        },
      };
      const created = await api.agents.create(payload);
      if (skillVersionId) {
        await api.skills.assign(created.id, skillVersionId);
        await loadSkillAssignments();
      }
      if (testPrompt.trim()) {
        const run = await api.agents.execute(created.id, { prompt: testPrompt.trim() });
        setSelectedTaskId(run.taskId);
        setActiveView('timeline');
      }
      onCreated(created.id);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Create agent failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <button className="absolute inset-0 bg-black/60" onClick={onClose} aria-label="Close setup wizard" />
      <section className="absolute left-1/2 top-1/2 max-h-[90vh] w-[920px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="border-b border-border p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.24em] text-accent-light">One-click setup</div>
              <h3 className="mt-1 text-xl font-bold">Agent Setup Wizard</h3>
              <p className="mt-1 text-sm text-gray-500">按模板、Skill、Tools、Model、测试任务完成一个可运行 Agent。</p>
            </div>
            <button onClick={onClose} className="rounded-lg bg-background px-3 py-1.5 text-xs text-gray-400 hover:text-white">Close</button>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2">
            {['Template', 'Skill', 'Tools & Model', 'Test'].map((label, index) => (
              <button
                key={label}
                onClick={() => setStep(index)}
                className={cn(
                  'rounded-lg px-3 py-2 text-xs font-semibold',
                  step === index ? 'bg-accent/20 text-accent-light' : 'bg-background text-gray-500 hover:text-gray-300',
                )}
              >
                {index + 1}. {label}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-[62vh] overflow-y-auto p-5">
          {step === 0 && (
            <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
              <div className="space-y-2">
                {templates.map(template => (
                  <button
                    key={template.role}
                    onClick={() => setSelectedTemplateRole(template.role)}
                    className={cn(
                      'w-full rounded-xl border p-3 text-left',
                      selectedTemplateRole === template.role ? 'border-accent/50 bg-accent/10' : 'border-border bg-background hover:border-accent/30',
                    )}
                  >
                    <div className="text-sm font-semibold"><span className="mr-2">{template.emoji}</span>{template.name}</div>
                    <div className="mt-1 text-[11px] text-gray-500">{template.role}</div>
                  </button>
                ))}
              </div>
              <div className="space-y-3">
                <Field label="Name"><input value={name} onChange={event => setName(event.target.value)} className={inputClass} /></Field>
                <div className="grid grid-cols-[86px_1fr] gap-3">
                  <Field label="Emoji"><input value={emoji} onChange={event => setEmoji(event.target.value)} className={inputClass} /></Field>
                  <Field label="Role"><input value={role} onChange={event => setRole(event.target.value)} className={inputClass} /></Field>
                </div>
                <Field label="Description / Skill prompt">
                  <textarea value={description} onChange={event => setDescription(event.target.value)} rows={5} className={cn(inputClass, 'resize-none')} />
                </Field>
                <Field label="Capabilities"><input value={capabilities} onChange={event => setCapabilities(event.target.value)} className={inputClass} /></Field>
                <Field label="Triggers"><input value={triggers} onChange={event => setTriggers(event.target.value)} className={inputClass} /></Field>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="grid gap-3 md:grid-cols-2">
              <button
                onClick={() => setSkillVersionId('')}
                className={cn('rounded-xl border p-4 text-left', !skillVersionId ? 'border-accent/50 bg-accent/10' : 'border-border bg-background')}
              >
                <div className="text-sm font-semibold">Use inline description</div>
                <div className="mt-1 text-xs text-gray-500">直接使用上一步 Description 作为 Agent overlay，不绑定 Skill 版本。</div>
              </button>
              {publishedSkillOptions.map(skill => (
                <button
                  key={skill.versionId}
                  onClick={() => setSkillVersionId(skill.versionId)}
                  className={cn('rounded-xl border p-4 text-left', skillVersionId === skill.versionId ? 'border-accent/50 bg-accent/10' : 'border-border bg-background hover:border-accent/30')}
                >
                  <div className="text-sm font-semibold">{skill.label}</div>
                  <div className="mt-1 text-xs text-gray-500">{skill.description}</div>
                  <div className="mt-2 text-[10px] text-gray-600">{skill.versionId}</div>
                </button>
              ))}
            </div>
          )}

          {step === 2 && (
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <h4 className="mb-3 text-sm font-semibold text-gray-300">Allowed tools</h4>
                <div className="space-y-2">
                  {availableTools.map(tool => (
                    <label key={tool.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-background p-3 hover:border-accent/30">
                      <input type="checkbox" checked={allowedTools.includes(tool.id)} onChange={() => toggleTool(tool.id)} className="mt-1" />
                      <span>
                        <span className="block text-sm font-semibold">{tool.name}</span>
                        <span className="block text-[11px] text-gray-500">{tool.id} · {tool.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <h4 className="mb-3 text-sm font-semibold text-gray-300">Model</h4>
                <select value={model} onChange={event => setModel(event.target.value)} className={inputClass}>
                  {modelOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label} — {option.hint}</option>
                  ))}
                </select>
                <div className="mt-4 rounded-xl border border-border bg-background p-4 text-xs leading-relaxed text-gray-500">
                  推荐：高复杂度 Agent 使用 Claude Sonnet / GPT 大模型；工具型、内容型任务可优先使用均衡或 mini 模型降低成本。
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <Summary label="Agent" value={`${emoji} ${name || '-'}`} />
                <Summary label="Role" value={role || '-'} />
                <Summary label="Model" value={model || '-'} />
                <Summary label="Tools" value={`${allowedTools.length} selected`} />
                <Summary label="Skill" value={skillVersionId || 'inline'} />
                <Summary label="Capabilities" value={capabilities || '-'} />
              </div>
              <Field label="Optional test prompt">
                <textarea
                  value={testPrompt}
                  onChange={event => setTestPrompt(event.target.value)}
                  rows={5}
                  className={cn(inputClass, 'resize-none')}
                  placeholder="创建后立即运行一次测试；留空则只创建 Agent。"
                />
              </Field>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border p-5">
          <div className="text-xs text-red-300">{error}</div>
          <div className="flex gap-2">
            <button disabled={step === 0} onClick={() => setStep(step - 1)} className="rounded-lg bg-background px-4 py-2 text-sm text-gray-300 disabled:opacity-40">
              Back
            </button>
            {step < 3 ? (
              <button onClick={() => setStep(step + 1)} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Next</button>
            ) : (
              <button disabled={saving} onClick={createAgent} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? 'Creating...' : 'Create Agent'}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

const inputClass = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gray-600">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}
