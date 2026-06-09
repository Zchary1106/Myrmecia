import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores/store';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { readOnlyControlMessage, runtimeControlsAllowed } from '../../lib/permissions';
import type { Pipeline, PipelineTemplate, PipelineTemplateValidationResult } from '@myrmecia/shared';

const stageStatusConfig: Record<string, { bg: string; text: string; icon: string }> = {
  pending: { bg: 'bg-gray-500/20', text: 'text-gray-500', icon: '⏸' },
  running: { bg: 'bg-blue-500/20', text: 'text-blue-400', icon: '⏳' },
  review: { bg: 'bg-purple-500/20', text: 'text-purple-400', icon: '👀' },
  done: { bg: 'bg-green-500/20', text: 'text-green-400', icon: '✅' },
  failed: { bg: 'bg-red-500/20', text: 'text-red-400', icon: '❌' },
  skipped: { bg: 'bg-gray-500/10', text: 'text-gray-600', icon: '⏭' },
};

function StageCard({ stage, isActive }: { stage: any; isActive: boolean }) {
  const config = stageStatusConfig[stage.status] || stageStatusConfig.pending;

  return (
    <div className={cn(
      'bg-surface border rounded-xl p-4 transition-all min-w-[180px]',
      isActive ? 'border-accent ring-1 ring-accent/20' : 'border-border'
    )}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">{config.icon}</span>
        <div className="flex-1">
          <div className="font-medium text-sm">{stage.name}</div>
          <div className="text-[10px] text-gray-500">{stage.agentRole}</div>
        </div>
      </div>
      <div className={cn('px-2 py-0.5 rounded text-[10px] font-medium w-fit', config.bg, config.text)}>
        {stage.status}
      </div>
      {stage.output && (
        <details className="mt-2">
          <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-300">
            View output
          </summary>
          <div className="mt-1 text-[11px] text-gray-400 bg-background rounded-lg p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">
            {stage.output}
          </div>
        </details>
      )}
    </div>
  );
}

function PipelineFlow({ pipeline }: { pipeline: Pipeline }) {
  const { diagnostics, loadPipelines, loadTasks } = useStore();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canControl = runtimeControlsAllowed(diagnostics);

  const runAction = async (action: 'approve' | 'skip' | 'cancel') => {
    if (action === 'cancel' && !window.confirm(`Cancel pipeline "${pipeline.name}"? Running stages will be stopped.`)) return;
    setBusyAction(action);
    setError(null);
    try {
      if (action === 'approve') await api.pipelines.approve(pipeline.id);
      if (action === 'skip') await api.pipelines.skip(pipeline.id);
      if (action === 'cancel') await api.pipelines.cancel(pipeline.id, true);
      await Promise.all([loadPipelines(), loadTasks()]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="bg-surface border border-border rounded-xl p-5 mb-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="font-semibold">{pipeline.name}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            {pipeline.input?.slice(0, 100)}{pipeline.input?.length > 100 ? '...' : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn(
            'px-2 py-0.5 rounded text-[10px] font-medium',
            pipeline.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
            pipeline.status === 'done' ? 'bg-green-500/20 text-green-400' :
            pipeline.status === 'failed' ? 'bg-red-500/20 text-red-400' :
            'bg-gray-500/20 text-gray-400'
          )}>
            {pipeline.status}
          </span>
          {pipeline.status === 'paused' && (
              <button
                onClick={() => runAction('approve')}
                disabled={!!busyAction || !canControl}
                title={canControl ? undefined : readOnlyControlMessage}
                className="px-2 py-0.5 rounded bg-green-500/10 text-green-400 text-[10px] hover:bg-green-500/20 disabled:opacity-50"
              >
              Approve
            </button>
          )}
          {(pipeline.status === 'running' || pipeline.status === 'paused' || pipeline.status === 'blocked') && (
            <>
              <button
                onClick={() => runAction('skip')}
                disabled={!!busyAction || !canControl}
                title={canControl ? undefined : readOnlyControlMessage}
                className="px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-400 text-[10px] hover:bg-yellow-500/20 disabled:opacity-50"
              >
                Skip
              </button>
              <button
                onClick={() => runAction('cancel')}
                disabled={!!busyAction || !canControl}
                title={canControl ? undefined : readOnlyControlMessage}
                className="px-2 py-0.5 rounded bg-red-500/10 text-red-400 text-[10px] hover:bg-red-500/20 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}
      {!canControl && (
        <div className="mb-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 text-xs text-yellow-400">
          {readOnlyControlMessage}
        </div>
      )}

      {/* Flow diagram */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        {pipeline.stages?.map((stage: any, i: number) => (
          <div key={i} className="flex items-center gap-2">
            <StageCard
              stage={stage}
              isActive={i === pipeline.currentStageIndex && pipeline.status === 'running'}
            />
            {i < (pipeline.stages?.length || 0) - 1 && (
              <div className={cn(
                'text-xl flex-shrink-0',
                stage.status === 'done' ? 'text-green-500' : 'text-gray-600'
              )}>
                →
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div className="mt-4">
        <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
          <span>Progress</span>
          <span>
            {pipeline.stages?.filter((s: any) => s.status === 'done').length || 0} / {pipeline.stages?.length || 0} stages
          </span>
        </div>
        <div className="h-1.5 bg-background rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-500"
            style={{
              width: `${((pipeline.stages?.filter((s: any) => s.status === 'done').length || 0) / (pipeline.stages?.length || 1)) * 100}%`
            }}
          />
        </div>
      </div>
    </div>
  );
}

const emptyStage: PipelineTemplate['stages'][number] = {
  name: 'New Stage',
  role: 'developer',
  promptTemplate: 'Use the previous context and user input to complete this stage:\n\n{input}',
};

function PipelineBuilder() {
  const { templates, agents, diagnostics, loadTemplates, loadPipelines, loadTasks } = useStore();
  const canControl = runtimeControlsAllowed(diagnostics);
  const roles = useMemo(() => Array.from(new Set(agents.map(agent => agent.role))).sort(), [agents]);
  const [templateId, setTemplateId] = useState<string>('new');
  const [name, setName] = useState('Custom Pipeline');
  const [description, setDescription] = useState('');
  const [stages, setStages] = useState<PipelineTemplate['stages']>([{ ...emptyStage }]);
  const [selectedStageIndex, setSelectedStageIndex] = useState(0);
  const [gateMode, setGateMode] = useState<'auto' | 'manual'>('auto');
  const [runInput, setRunInput] = useState('');
  const [validation, setValidation] = useState<PipelineTemplateValidationResult | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (templateId === 'new') return;
    const template = templates.find(item => item.id === templateId);
    if (!template) return;
    setName(template.name);
    setDescription(template.description || '');
    setStages(template.stages.length ? template.stages : [{ ...emptyStage }]);
    setSelectedStageIndex(0);
    setValidation(null);
  }, [templateId, templates]);

  const selectedStage = stages[selectedStageIndex] || stages[0];
  const stageIssues = (index: number) => validation?.errors.filter(error => error.stageIndex === index) || [];
  const stageWarnings = (index: number) => validation?.warnings.filter(warning => warning.stageIndex === index) || [];

  const updateStage = (updates: Partial<PipelineTemplate['stages'][number]>) => {
    setStages(current => current.map((stage, index) => index === selectedStageIndex ? { ...stage, ...updates } : stage));
  };

  const addStage = () => {
    setStages(current => [...current, { ...emptyStage, name: `Stage ${current.length + 1}` }]);
    setSelectedStageIndex(stages.length);
  };

  const removeStage = (index: number) => {
    setStages(current => current.length <= 1 ? current : current.filter((_, itemIndex) => itemIndex !== index));
    setSelectedStageIndex(index > 0 ? index - 1 : 0);
  };

  const moveStage = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= stages.length) return;
    setStages(current => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
    setSelectedStageIndex(target);
  };

  const validateDraft = async () => {
    const result = await api.templates.validateDraft({ name, description, stages });
    setValidation(result);
    return result;
  };

  const saveTemplate = async () => {
    setError('');
    setSaving(true);
    try {
      const result = await validateDraft();
      if (!result.valid) return null;
      const payload = { name, description, stages };
      const saved = templateId === 'new'
        ? await api.templates.create(payload)
        : await api.templates.update(templateId, payload);
      setTemplateId(saved.id);
      await loadTemplates();
      return saved.id;
    } catch (err: any) {
      setError(err.message || 'Save template failed');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const runPipeline = async () => {
    if (!runInput.trim()) {
      setError('Pipeline input is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const savedId = templateId === 'new' ? await saveTemplate() : templateId;
      if (!savedId) return;
      await api.pipelines.create({
        name: `${name} Run`,
        templateId: savedId,
        input: runInput,
        gateMode,
      });
      setRunInput('');
      await Promise.all([loadPipelines(), loadTasks()]);
    } catch (err: any) {
      setError(err.message || 'Run pipeline failed');
    } finally {
      setSaving(false);
    }
  };

  const resetNew = () => {
    setTemplateId('new');
    setName('Custom Pipeline');
    setDescription('');
    setStages([{ ...emptyStage }]);
    setSelectedStageIndex(0);
    setValidation(null);
    setError('');
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.24em] text-accent-light">Pipeline Builder</div>
          <h3 className="mt-2 text-2xl font-bold">Visual Template Builder</h3>
          <p className="mt-1 max-w-2xl text-xs text-gray-500">
            创建/编辑 stage 流程、选择 Agent role、配置 prompt 和 gate mode，保存后可立即运行。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={templateId}
            onChange={event => setTemplateId(event.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          >
            <option value="new">New template</option>
            {templates.map(template => (
              <option key={template.id} value={template.id}>{template.name}</option>
            ))}
          </select>
          <button onClick={resetNew} className="rounded-lg bg-surface-hover px-3 py-2 text-sm text-gray-300 hover:text-white">New</button>
        </div>
      </div>

      {!canControl && (
        <div className="mt-4 rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
          {readOnlyControlMessage}
        </div>
      )}
      {error && <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      <div className="mt-5 grid gap-4 xl:grid-cols-[300px_1fr_340px]">
        <div className="space-y-3">
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <textarea
            value={description}
            onChange={event => setDescription(event.target.value)}
            placeholder="Template description"
            rows={3}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <div className="space-y-2">
            {stages.map((stage, index) => (
              <button
                key={`${stage.name}-${index}`}
                onClick={() => setSelectedStageIndex(index)}
                className={cn(
                  'w-full rounded-xl border p-3 text-left transition',
                  selectedStageIndex === index ? 'border-accent/50 bg-accent/10' : 'border-border bg-background hover:border-accent/30',
                  stageIssues(index).length && 'border-red-500/50',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-sm font-semibold">{index + 1}. {stage.name}</div>
                  <div className="flex gap-1 text-[10px] text-gray-500">
                    <span>{stage.role}</span>
                  </div>
                </div>
                {stageIssues(index).map(issue => <div key={issue.message} className="mt-1 text-[10px] text-red-300">{issue.message}</div>)}
                {stageWarnings(index).map(warning => <div key={warning.message} className="mt-1 text-[10px] text-yellow-300">{warning.message}</div>)}
              </button>
            ))}
          </div>
          <button onClick={addStage} className="w-full rounded-lg border border-dashed border-border px-3 py-2 text-xs text-gray-400 hover:border-accent hover:text-accent-light">
            + Add stage
          </button>
        </div>

        <div className="rounded-xl border border-border bg-background p-4">
          <div className="mb-4 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-gray-300">Stage Config</h4>
            <div className="flex gap-1">
              <button onClick={() => moveStage(selectedStageIndex, -1)} className="rounded bg-surface px-2 py-1 text-xs text-gray-400">↑</button>
              <button onClick={() => moveStage(selectedStageIndex, 1)} className="rounded bg-surface px-2 py-1 text-xs text-gray-400">↓</button>
              <button onClick={() => removeStage(selectedStageIndex)} className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-300">Remove</button>
            </div>
          </div>
          {selectedStage && (
            <div className="space-y-3">
              <input
                value={selectedStage.name}
                onChange={event => updateStage({ name: event.target.value })}
                placeholder="Stage name"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <select
                value={selectedStage.role}
                onChange={event => updateStage({ role: event.target.value })}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              >
                {!roles.includes(selectedStage.role) && <option value={selectedStage.role}>{selectedStage.role}</option>}
                {roles.map(role => <option key={role} value={role}>{role}</option>)}
              </select>
              <textarea
                value={selectedStage.promptTemplate}
                onChange={event => updateStage({ promptTemplate: event.target.value })}
                rows={12}
                placeholder="Prompt template. Use {input} to include pipeline context."
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs outline-none focus:border-accent"
              />
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <div className="rounded-xl border border-border bg-background p-4">
            <h4 className="text-sm font-semibold text-gray-300">Flow Preview</h4>
            <div className="mt-4 space-y-2">
              {stages.map((stage, index) => (
                <div key={index} className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/20 text-xs text-accent-light">{index + 1}</div>
                  <div className="min-w-0 flex-1 rounded-lg border border-border bg-surface p-2">
                    <div className="truncate text-xs font-semibold">{stage.name}</div>
                    <div className="text-[10px] text-gray-500">{stage.role}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-background p-4">
            <h4 className="text-sm font-semibold text-gray-300">Save & Run</h4>
            <select
              value={gateMode}
              onChange={event => setGateMode(event.target.value as 'auto' | 'manual')}
              className="mt-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            >
              <option value="auto">Auto advance</option>
              <option value="manual">Manual gates</option>
            </select>
            <textarea
              value={runInput}
              onChange={event => setRunInput(event.target.value)}
              rows={5}
              placeholder="Input for a new pipeline run"
              className="mt-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={saveTemplate}
                disabled={saving || !canControl}
                className="rounded-lg bg-surface-hover px-3 py-2 text-sm text-gray-200 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={runPipeline}
                disabled={saving || !canControl}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Run
              </button>
            </div>
            {validation && (
              <div className="mt-3 text-[11px]">
                <div className={validation.valid ? 'text-emerald-300' : 'text-red-300'}>
                  {validation.valid ? 'Template is valid' : `${validation.errors.length} validation error(s)`}
                </div>
                {validation.warnings.length > 0 && <div className="mt-1 text-yellow-300">{validation.warnings.length} warning(s)</div>}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export function OrchestratorView() {
  const { pipelines } = useStore();
  const activePipelines = pipelines.filter(p => p.status === 'running' || p.status === 'paused');
  const completedPipelines = pipelines.filter(p => p.status === 'done' || p.status === 'failed');

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Orchestrator</h2>
          <p className="text-[12px] text-gray-500 mt-0.5">Pipeline orchestration and multi-agent workflows</p>
        </div>
        <div className="flex gap-2 text-[11px]">
          <span className="bg-blue-500/10 text-blue-400 px-2 py-1 rounded-lg">
            {activePipelines.length} active
          </span>
          <span className="bg-green-500/10 text-green-400 px-2 py-1 rounded-lg">
            {completedPipelines.length} completed
          </span>
        </div>
      </div>

      <PipelineBuilder />

      {/* Active pipelines */}
      {activePipelines.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-400 mb-3 flex items-center gap-2">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            Active Pipelines
          </h3>
          {activePipelines.map(p => (
            <PipelineFlow key={p.id} pipeline={p} />
          ))}
        </div>
      )}

      {/* Completed */}
      {completedPipelines.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-400 mb-3">Completed</h3>
          {completedPipelines.map(p => (
            <PipelineFlow key={p.id} pipeline={p} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {pipelines.length === 0 && (
        <div className="text-center py-16 text-gray-600">
          <div className="text-4xl mb-3 opacity-30">🔗</div>
          <p className="text-sm">No pipelines yet</p>
          <p className="text-[11px] text-gray-700 mt-1">
            Switch to Orchestrate mode and describe a complex task
          </p>
        </div>
      )}
    </div>
  );
}
