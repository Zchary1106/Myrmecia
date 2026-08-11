import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Pipeline, PipelineArtifact, PipelineStage } from '@myrmecia/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useStore } from '../../stores/store';
import { StageOutputPreview } from './StageOutputPreview';

const CROSSPOST_TEMPLATE_NAME = 'Social Content Three Lanes';
const XIAOHONGSHU_TEMPLATE_NAME = 'Xiaohongshu Publish';
const DOUYIN_TEMPLATE_NAME = 'Douyin Video Publish';
const WECHAT_TEMPLATE_NAME = 'WeChat Article';

const xiaohongshuStages: Array<Pick<PipelineStage, 'name' | 'agentRole'>> = [
  { name: '小红书选题调研', agentRole: 'trend-scout' },
  { name: '小红书笔记创作', agentRole: 'xiaohongshu-writer' },
  { name: '自动合规初筛', agentRole: 'social-compliance-reviewer' },
  { name: '人工审核材料', agentRole: 'social-review-coordinator' },
  { name: '配图生成', agentRole: 'xiaohongshu-visual-designer' },
  { name: '媒体 QA', agentRole: 'media-qa' },
  { name: '发布预检', agentRole: 'social-preflight' },
  { name: '小红书发布', agentRole: 'social-publisher' },
];

const crosspostStages: Array<Pick<PipelineStage, 'name' | 'agentRole'>> = [
  { name: '选题证据包', agentRole: 'trend-scout' },
  { name: '内容核心包', agentRole: 'content-strategist' },
  { name: '抖音视频生产线', agentRole: 'douyin-writer' },
  { name: '小红书生产线', agentRole: 'xiaohongshu-writer' },
  { name: '公众号生产线', agentRole: 'wechat-writer' },
  { name: '自动合规初筛', agentRole: 'social-compliance-reviewer' },
  { name: '人工审核材料', agentRole: 'social-review-coordinator' },
  { name: '小红书卡片生成', agentRole: 'xiaohongshu-visual-designer' },
  { name: '公众号草稿箱同步', agentRole: 'wechat-writer' },
  { name: '媒体 QA', agentRole: 'media-qa' },
  { name: '发布预检', agentRole: 'social-preflight' },
  { name: '发布执行', agentRole: 'social-publisher' },
  { name: '发布补偿计划', agentRole: 'social-ops' },
  { name: '发布后监控计划', agentRole: 'social-analytics' },
];

const douyinStages: Array<Pick<PipelineStage, 'name' | 'agentRole'>> = [
  { name: '抖音选题调研', agentRole: 'trend-scout' },
  { name: '抖音视频脚本', agentRole: 'douyin-writer' },
  { name: '自动合规初筛', agentRole: 'social-compliance-reviewer' },
  { name: '人工审核材料', agentRole: 'social-review-coordinator' },
  { name: '视频媒体 QA', agentRole: 'media-qa' },
  { name: '发布预检', agentRole: 'social-preflight' },
  { name: '抖音视频发布', agentRole: 'social-publisher' },
  { name: '发布补偿计划', agentRole: 'social-ops' },
  { name: '发布后监控计划', agentRole: 'social-analytics' },
];

const wechatStages: Array<Pick<PipelineStage, 'name' | 'agentRole'>> = [
  { name: '选题分析', agentRole: 'product-manager' },
  { name: '内容创作', agentRole: 'wechat-writer' },
  { name: '内容审核', agentRole: 'reviewer' },
  { name: '排版优化', agentRole: 'wechat-writer' },
  { name: '草稿箱同步', agentRole: 'wechat-writer' },
  { name: '发布执行', agentRole: 'social-publisher' },
];

export function contentStudioWorkflow(selectedAgentId: string | null) {
  if (selectedAgentId === 'wechat-writer') {
    return {
      templateName: WECHAT_TEMPLATE_NAME,
      title: 'WeChat Official Account Studio',
      subtitle: '选题 · 写作 · 审核 · 排版 · 草稿箱 · 人工发布',
      stages: wechatStages,
      createLabel: 'Create WeChat article run',
    };
  }
  if (selectedAgentId === 'xiaohongshu-writer') {
    return {
      templateName: XIAOHONGSHU_TEMPLATE_NAME,
      title: 'Xiaohongshu Content Studio',
      subtitle: '小红书独立生产线 · 图文预览 · 人工审核发布',
      stages: xiaohongshuStages,
      createLabel: 'Create Xiaohongshu run',
    };
  }
  if (selectedAgentId === 'douyin-writer') {
    return {
      templateName: DOUYIN_TEMPLATE_NAME,
      title: 'Douyin Script & Publish Studio',
      subtitle: '脚本与发布工作台 · 需要用户提供真实本地视频 · 人工确认上传',
      stages: douyinStages,
      createLabel: 'Create Douyin video run',
    };
  }
  return {
      templateName: CROSSPOST_TEMPLATE_NAME,
    title: 'Social Three-Lane Studio',
    subtitle: 'Douyin + Xiaohongshu + WeChat · shared research · independent production lanes',
      stages: crosspostStages,
      createLabel: 'Create crosspost run',
  };
}

const stageStyle: Record<string, { dot: string; badge: string; label: string }> = {
  pending: { dot: 'bg-gray-600', badge: 'bg-gray-500/10 text-gray-500', label: 'Pending' },
  running: { dot: 'bg-blue-400 animate-pulse', badge: 'bg-blue-500/10 text-blue-300', label: 'Working' },
  review: { dot: 'bg-purple-400', badge: 'bg-purple-500/10 text-purple-300', label: 'Review' },
  done: { dot: 'bg-emerald-400', badge: 'bg-emerald-500/10 text-emerald-300', label: 'Ready' },
  failed: { dot: 'bg-red-400', badge: 'bg-red-500/10 text-red-300', label: 'Failed' },
  skipped: { dot: 'bg-gray-500', badge: 'bg-gray-500/10 text-gray-500', label: 'Skipped' },
  rolled_back: { dot: 'bg-orange-400', badge: 'bg-orange-500/10 text-orange-300', label: 'Rolled back' },
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isActivePipeline(pipeline: Pipeline) {
  return ['running', 'paused', 'blocked', 'awaiting_retry'].includes(pipeline.status);
}

function isCrosspostPipeline(pipeline: Pipeline, templateId?: string) {
  if (templateId && pipeline.templateId === templateId) return true;
  const roles = pipeline.stages.map(stage => String(stage.agentRole));
  return roles.includes('xiaohongshu-writer') && roles.includes('douyin-writer') && roles.includes('social-publisher');
}

function isXiaohongshuPipeline(pipeline: Pipeline, templateId?: string) {
  if (templateId && pipeline.templateId === templateId) return true;
  const roles = pipeline.stages.map(stage => String(stage.agentRole));
  // Keep legacy crosspost runs visible so their copy/images can still be
  // inspected or regenerated. New runs use the standalone template above.
  return roles.includes('xiaohongshu-writer') && roles.includes('social-publisher');
}

function isDouyinPipeline(pipeline: Pipeline, templateId?: string) {
  if (templateId && pipeline.templateId === templateId) return true;
  const roles = pipeline.stages.map(stage => String(stage.agentRole));
  return roles.includes('douyin-writer')
    && roles.includes('social-publisher')
    && !roles.includes('xiaohongshu-writer');
}

function isWeChatPipeline(pipeline: Pipeline, templateId?: string) {
  if (templateId && pipeline.templateId === templateId) return true;
  const names = pipeline.stages.map(stage => stage.name);
  return names.includes('草稿箱同步') && names.includes('发布执行');
}

function StageStepper({
  pipeline,
  workflowStages,
  selectedStageIndex,
  onSelect,
}: {
  pipeline: Pipeline;
  workflowStages: Array<Pick<PipelineStage, 'name' | 'agentRole'>>;
  selectedStageIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div data-testid="content-stage-stepper" className="overflow-x-auto border-b border-border bg-surface/60 px-4 py-4">
      <div className="mx-auto flex min-w-[760px] max-w-[1280px] items-start">
        {workflowStages.map((fallback, index) => {
          const stage = pipeline.stages[index];
          const name = stage?.name || fallback.name;
          const role = stage?.agentRole || fallback.agentRole;
          const status = stage?.status || 'pending';
          const style = stageStyle[status] || stageStyle.pending;
          const isCurrent = index === pipeline.currentStageIndex;
          const isSelected = index === selectedStageIndex;

          return (
            <div key={`${index}-${name}`} className="flex min-w-0 flex-1 items-start last:flex-none">
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-pressed={isSelected}
                className={cn(
                  'group relative flex min-w-0 flex-col items-center text-center outline-none',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                )}
              >
                <span className={cn(
                  'relative flex h-8 w-8 items-center justify-center rounded-full border text-[11px] font-bold transition',
                  isSelected ? 'border-accent bg-accent text-white shadow-lg shadow-accent/20' : 'border-border bg-background text-gray-500 group-hover:border-accent/50',
                )}>
                  {status === 'done' ? '✓' : index + 1}
                  <span className={cn('absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface', style.dot)} />
                </span>
                <span className={cn('mt-2 max-w-[110px] truncate text-[10px] font-semibold', isSelected ? 'text-gray-100' : 'text-gray-400')}>
                  {name}
                </span>
                <span className="mt-0.5 max-w-[110px] truncate text-[9px] text-gray-600">{role}</span>
                {isCurrent && <span className="mt-1 text-[8px] font-semibold uppercase tracking-[0.14em] text-accent-light">Current</span>}
              </button>
              {index < workflowStages.length - 1 && (
                <div className={cn(
                  'mt-4 h-px flex-1 bg-border',
                  status === 'done' && pipeline.stages[index + 1]?.status !== 'pending' ? 'bg-emerald-500/60' : '',
                )} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PipelineStatus({ status }: { status: Pipeline['status'] }) {
  const style = status === 'done'
    ? 'bg-emerald-500/10 text-emerald-300'
    : status === 'failed'
      ? 'bg-red-500/10 text-red-300'
      : status === 'paused'
        ? 'bg-amber-500/10 text-amber-300'
        : 'bg-blue-500/10 text-blue-300';

  return <span className={cn('rounded-full px-2 py-1 text-[9px] font-semibold uppercase tracking-wider', style)}>{status}</span>;
}

export function ContentStudio() {
  const {
    agents,
    tasks,
    pipelines,
    templates,
    activePipelineId,
    setActivePipelineId,
    upsertPipeline,
    loadPipelines,
    loadTemplates,
    loadTasks,
    selectedAgentId,
  } = useStore();
  const [initialLoading, setInitialLoading] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedStageIndex, setSelectedStageIndex] = useState(0);
  const [artifacts, setArtifacts] = useState<PipelineArtifact[]>([]);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [runName, setRunName] = useState('');
  const [runInput, setRunInput] = useState('');
  const [gateMode, setGateMode] = useState<'manual' | 'auto'>('manual');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showPublishConfirm, setShowPublishConfirm] = useState(false);
  const [publishConfirmAction, setPublishConfirmAction] = useState<'approve' | 'retry'>('approve');
  const [publishPhrase, setPublishPhrase] = useState('');
  const [cancelArmed, setCancelArmed] = useState(false);
  const [revisionPrompt, setRevisionPrompt] = useState('');
  const [revisionState, setRevisionState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [revisionMessage, setRevisionMessage] = useState('');
  const [artifactView, setArtifactView] = useState<'preview' | 'raw'>('preview');
  const [previewArtifact, setPreviewArtifact] = useState<PipelineArtifact | null>(null);

  useEffect(() => {
    let mounted = true;
    void Promise.all([loadPipelines(), loadTemplates()]).finally(() => {
      if (mounted) setInitialLoading(false);
    });
    return () => { mounted = false; };
  }, [loadPipelines, loadTemplates]);

  const isWeChatMode = selectedAgentId === 'wechat-writer';
  const isXiaohongshuMode = selectedAgentId === 'xiaohongshu-writer';
  const isDouyinMode = selectedAgentId === 'douyin-writer';
  const workflow = contentStudioWorkflow(selectedAgentId);
  const workflowTemplate = useMemo(
    () => templates.find(template => template.name === workflow.templateName),
    [templates, workflow.templateName],
  );
  const contentPipelines = useMemo(
    () => pipelines
      .filter(pipeline => isWeChatMode
        ? isWeChatPipeline(pipeline, workflowTemplate?.id)
        : isXiaohongshuMode
          ? isXiaohongshuPipeline(pipeline, workflowTemplate?.id)
          : isDouyinMode
            ? isDouyinPipeline(pipeline, workflowTemplate?.id)
            : isCrosspostPipeline(pipeline, workflowTemplate?.id))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [pipelines, isWeChatMode, isXiaohongshuMode, isDouyinMode, workflowTemplate?.id],
  );
  const pipeline = contentPipelines.find(item => item.id === selectedRunId) || null;
  const currentTask = pipeline?.stages[pipeline.currentStageIndex]?.taskId
    ? tasks.find(task => task.id === pipeline.stages[pipeline.currentStageIndex].taskId)
    : undefined;
  const artifactVersion = pipeline?.stages
    .map(stage => `${stage.index}:${stage.status}:${stage.output?.length || 0}`)
    .join('|') || '';

  useEffect(() => {
    if (!contentPipelines.length) {
      if (selectedRunId) setSelectedRunId(null);
      return;
    }
    if (contentPipelines.some(item => item.id === selectedRunId)) return;
    const next = contentPipelines.find(item => item.id === activePipelineId) || contentPipelines[0];
    setSelectedRunId(next.id);
    setActivePipelineId(next.id);
  }, [activePipelineId, contentPipelines, selectedRunId, setActivePipelineId]);

  useEffect(() => {
    if (!pipeline) return;
    setSelectedStageIndex(Math.min(Math.max(pipeline.currentStageIndex, 0), pipeline.stages.length - 1));
    setRevisionPrompt('');
    setRevisionMessage('');
    setRevisionState('idle');
    setCancelArmed(false);
    setArtifactView('preview');
  }, [
    pipeline?.id,
    pipeline?.status,
    pipeline?.stages.map(stage => `${stage.index}:${stage.status}:${stage.output?.length || 0}`).join('|'),
  ]);

  const refreshArtifacts = useCallback(async () => {
    if (!pipeline) {
      setArtifacts([]);
      setArtifactError(null);
      return;
    }
    setArtifactLoading(true);
    setArtifactError(null);
    try {
      setArtifacts(await api.pipelines.artifacts(pipeline.id));
    } catch (error) {
      setArtifactError(errorMessage(error, 'Could not load generated artifacts.'));
    } finally {
      setArtifactLoading(false);
    }
  }, [pipeline?.id]);

  useEffect(() => {
    void refreshArtifacts();
  }, [refreshArtifacts, artifactVersion]);

  const selectedStage = pipeline?.stages[selectedStageIndex];
  const selectedStageDetails = selectedStage || (pipeline ? {
    index: selectedStageIndex,
    ...workflow.stages[selectedStageIndex],
    status: 'pending' as const,
  } : null);
  const selectedAgent = agents.find(agent =>
    agent.id === selectedStageDetails?.agentRole || agent.role === selectedStageDetails?.agentRole,
  );
  const imageArtifacts = artifacts.filter(artifact => artifact.kind === 'image' && /\.png$/i.test(artifact.name));
  const videoArtifacts = artifacts.filter(artifact => artifact.kind === 'video');
  const participantRoles = Array.from(new Set(workflow.stages.map(stage => String(stage.agentRole))));
  const publishStageAhead = pipeline
    ? (pipeline.stages[pipeline.currentStageIndex + 1] || workflow.stages[pipeline.currentStageIndex + 1])?.agentRole === 'social-publisher'
    : false;
  const currentStage = pipeline?.stages[pipeline.currentStageIndex];
  const retryableStage = pipeline?.status === 'awaiting_retry' && currentStage?.status === 'rolled_back'
    ? currentStage
    : null;
  const retryRequiresPublishConfirmation = Boolean(
    retryableStage
    && (
      retryableStage.agentRole === 'social-publisher'
      || (retryableStage.publishTools?.length || 0) > 0
    )
  );
  const canRegenerateSelectedStage = Boolean(
    pipeline
    && selectedStageDetails?.status === 'done'
    && /配图|image/i.test(selectedStageDetails.name)
    && selectedStageDetails.agentRole !== 'social-publisher'
    && !(selectedStageDetails.publishTools?.length)
  );

  const selectRun = (id: string) => {
    setSelectedRunId(id);
    setActivePipelineId(id);
    setActionError(null);
  };

  const openCreate = () => {
    setGateMode('manual');
    setActionError(null);
    setShowCreate(true);
  };

  const refreshPipeline = async (id: string) => {
    const fresh = await api.pipelines.get(id);
    upsertPipeline(fresh);
    await loadPipelines();
  };

  const createRun = async () => {
    if (!workflowTemplate || !runInput.trim() || busyAction) return;
    setBusyAction('create');
    setActionError(null);
    try {
      const created = await api.pipelines.create({
        name: runName.trim() || `${isWeChatMode ? 'WeChat' : isXiaohongshuMode ? 'Xiaohongshu' : isDouyinMode ? 'Douyin' : 'Crosspost'} · ${runInput.trim().slice(0, 42)}`,
        templateId: workflowTemplate.id,
        input: runInput.trim(),
        gateMode,
      });
      upsertPipeline(created);
      setSelectedRunId(created.id);
      setActivePipelineId(created.id);
      setShowCreate(false);
      setRunName('');
      setRunInput('');
      await loadPipelines();
    } catch (error) {
      setActionError(errorMessage(error, 'Could not create the content run.'));
    } finally {
      setBusyAction(null);
    }
  };

  const runPipelineAction = async (action: 'approve' | 'skip' | 'cancel', confirmPublish = false) => {
    if (!pipeline || busyAction) return;
    setBusyAction(action);
    setActionError(null);
    try {
      if (action === 'approve') await api.pipelines.approve(pipeline.id, confirmPublish);
      if (action === 'skip') await api.pipelines.skip(pipeline.id);
      if (action === 'cancel') await api.pipelines.cancel(pipeline.id, true);
      await refreshPipeline(pipeline.id);
      if (action === 'cancel') setCancelArmed(false);
    } catch (error) {
      setActionError(errorMessage(error, `Could not ${action} this run.`));
    } finally {
      setBusyAction(null);
    }
  };

  const approve = () => {
    if (!pipeline) return;
    if (publishStageAhead) {
      setPublishPhrase('');
      setPublishConfirmAction('approve');
      setShowPublishConfirm(true);
      return;
    }
    void runPipelineAction('approve');
  };

  const retryCurrentStage = async (confirmPublish = false) => {
    if (!pipeline || !retryableStage || busyAction) return;
    setBusyAction('retry');
    setActionError(null);
    try {
      await api.pipelines.retryStage(pipeline.id, retryableStage.index, confirmPublish);
      await refreshPipeline(pipeline.id);
    } catch (error) {
      setActionError(errorMessage(error, 'Could not retry this stage.'));
    } finally {
      setBusyAction(null);
    }
  };

  const requestRetry = () => {
    if (!retryableStage) return;
    if (retryRequiresPublishConfirmation) {
      setPublishPhrase('');
      setPublishConfirmAction('retry');
      setShowPublishConfirm(true);
      return;
    }
    void retryCurrentStage();
  };

  const regenerateSelectedStage = async () => {
    if (!pipeline || !selectedStageDetails || !canRegenerateSelectedStage || busyAction) return;
    setBusyAction('regenerate');
    setActionError(null);
    try {
      await api.pipelines.rerunStage(pipeline.id, selectedStageDetails.index);
      await refreshPipeline(pipeline.id);
      setArtifacts([]);
    } catch (error) {
      setActionError(errorMessage(error, 'Could not regenerate this stage.'));
    } finally {
      setBusyAction(null);
    }
  };

  const submitRevision = async () => {
    if (!pipeline || !selectedStageDetails || !selectedAgent || !revisionPrompt.trim() || revisionState === 'sending') return;
    setRevisionState('sending');
    setRevisionMessage('');
    try {
      const previousOutput = selectedStageDetails.output
        ? `\n\nCurrent stage output:\n${selectedStageDetails.output}`
        : '';
      const result = await api.agents.execute(selectedAgent.id, {
        prompt: `Revision request for "${selectedStageDetails.name}" in content run "${pipeline.name}".\n\n${revisionPrompt.trim()}${previousOutput}\n\nReturn a complete revised replacement for this stage.`,
      });
      setRevisionState('sent');
      setRevisionMessage(`Revision task ${result.taskId} started with ${selectedAgent.name}.`);
      await loadTasks();
    } catch (error) {
      setRevisionState('error');
      setRevisionMessage(errorMessage(error, 'Could not start the revision task.'));
    }
  };

  if (initialLoading) {
    return (
      <div data-testid="content-studio" className="flex h-full items-center justify-center bg-background text-sm text-gray-500">
        <div className="flex items-center gap-2"><span className="h-3 w-3 animate-pulse rounded-full bg-accent" /> Loading Content Studio…</div>
      </div>
    );
  }

  return (
    <div data-testid="content-studio" className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-lg">✦</span>
            <h2 className="truncate text-sm font-bold">{workflow.title}</h2>
            {pipeline && <PipelineStatus status={pipeline.status} />}
          </div>
          <p className="mt-0.5 truncate text-[10px] text-gray-500">{workflow.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {contentPipelines.length > 0 && (
            <select
              value={selectedRunId || ''}
              onChange={event => selectRun(event.target.value)}
              aria-label="Select content production run"
              className="max-w-52 rounded-lg border border-border bg-background px-2.5 py-2 text-[11px] text-gray-300 outline-none focus:border-accent"
            >
              {contentPipelines.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          )}
          <button
            type="button"
            onClick={openCreate}
            className="rounded-lg bg-accent px-3 py-2 text-[11px] font-semibold text-white transition hover:bg-accent-light"
          >
            + New run
          </button>
        </div>
      </header>

      {actionError && (
        <div role="alert" className="mx-4 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {actionError}
        </div>
      )}

      {!pipeline ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-2xl border border-border bg-surface p-7 text-center">
            <div className="text-3xl">🧩</div>
            <h3 className="mt-3 text-base font-bold">{workflow.createLabel}</h3>
            <p className="mt-2 text-xs leading-relaxed text-gray-500">
              {isDouyinMode
                ? 'Research, write the video script, validate a real local video file, then explicitly approve the Douyin upload.'
                : 'Research, write, review, generate images, and explicitly approve publication from one artifact-first workspace.'}
            </p>
            {!workflowTemplate && <p className="mt-3 text-xs text-amber-300">The “{workflow.templateName}” template is not available yet.</p>}
            <button
              type="button"
              disabled={!workflowTemplate}
              onClick={openCreate}
              className="mt-5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-40"
            >
              {workflow.createLabel}
            </button>
          </div>
        </div>
      ) : (
        <>
          <StageStepper
            pipeline={pipeline}
            workflowStages={pipeline.stages.length ? pipeline.stages : workflow.stages}
            selectedStageIndex={selectedStageIndex}
            onSelect={setSelectedStageIndex}
          />
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto 2xl:grid-cols-[minmax(0,1fr)_300px] 2xl:overflow-hidden">
            <main className="min-w-0 space-y-4 p-4 2xl:overflow-y-auto">
              <section data-testid="content-artifact-canvas" className="rounded-2xl border border-border bg-surface shadow-lg shadow-black/10">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-light">Stage artifact</div>
                    <h3 className="mt-1 truncate text-base font-bold">{selectedStageDetails?.name}</h3>
                    <p className="mt-1 text-[11px] text-gray-500">{selectedAgent?.name || selectedStageDetails?.agentRole} · output captured from this workflow stage</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedStageDetails?.output && (
                      <div className="flex rounded-lg border border-border bg-background p-0.5">
                        {(['preview', 'raw'] as const).map(view => (
                          <button
                            key={view}
                            type="button"
                            onClick={() => setArtifactView(view)}
                            className={cn(
                              'rounded-md px-2.5 py-1 text-[10px] font-medium capitalize',
                              artifactView === view ? 'bg-accent/15 text-accent-light' : 'text-gray-500 hover:text-gray-300',
                            )}
                          >
                            {view}
                          </button>
                        ))}
                      </div>
                    )}
                    {selectedStageDetails && (
                      <span className={cn('rounded-full px-2 py-1 text-[10px] font-medium', (stageStyle[selectedStageDetails.status] || stageStyle.pending).badge)}>
                        {(stageStyle[selectedStageDetails.status] || stageStyle.pending).label}
                      </span>
                    )}
                  </div>
                </div>
                <div className="p-4">
                  {selectedStageDetails?.output ? (
                    artifactView === 'preview'
                      ? <StageOutputPreview output={selectedStageDetails.output} />
                      : (
                        <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-background p-4 font-mono text-xs leading-6 text-gray-300">
                          {selectedStageDetails.output}
                        </pre>
                      )
                  ) : (
                    <div className="rounded-xl border border-dashed border-border bg-background/60 px-4 py-10 text-center text-xs text-gray-600">
                      {selectedStageDetails?.status === 'running'
                        ? 'This stage is working. Its readable output will appear here when it is complete.'
                        : 'No stage output is available yet. Select a completed stage to inspect its artifact.'}
                    </div>
                  )}
                </div>
              </section>

              <section data-testid="content-media-gallery" className="rounded-2xl border border-border bg-surface p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-light">
                      {isDouyinMode ? 'Local video files' : 'Generated PNGs'}
                    </div>
                    <h3 className="mt-1 text-sm font-bold">{isDouyinMode ? 'Video artifact gallery' : 'Image artifact gallery'}</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-600">{isDouyinMode ? videoArtifacts.length : imageArtifacts.length} files</span>
                    <button
                      type="button"
                      onClick={() => void refreshArtifacts()}
                      disabled={artifactLoading}
                      className="rounded-md border border-border bg-background px-2 py-1 text-[9px] font-medium text-gray-500 hover:text-gray-200 disabled:opacity-40"
                    >
                      {artifactLoading ? 'Loading…' : 'Refresh'}
                    </button>
                  </div>
                </div>
                {artifactLoading && <div className="py-8 text-center text-xs text-gray-500">Loading generated artifacts…</div>}
                {artifactError && <div role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{artifactError}</div>}
                {!artifactLoading && !artifactError && (isDouyinMode ? videoArtifacts.length === 0 : imageArtifacts.length === 0) && (
                  <div className="mt-3 rounded-xl border border-dashed border-border bg-background/60 px-4 py-8 text-center text-xs text-gray-600">
                    {isDouyinMode
                      ? 'Add a real local MP4/MOV/WebM path to the production brief. Video files copied into this run workspace will appear here.'
                      : 'PNG cards generated by the image stage will appear here.'}
                  </div>
                )}
                {!isDouyinMode && imageArtifacts.length > 0 && (
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                    {imageArtifacts.map(artifact => (
                      <button key={artifact.id} type="button" onClick={() => setPreviewArtifact(artifact)} className={cn('group overflow-hidden rounded-xl border border-border bg-background text-left hover:border-accent/50', isWeChatMode && 'col-span-2')}>
                        <img src={artifact.url} alt={artifact.name} className={cn('w-full object-cover transition duration-200 group-hover:scale-[1.02]', isWeChatMode ? 'aspect-[900/383]' : 'aspect-[3/4]')} />
                        <span className="block truncate px-2 py-1.5 text-[10px] text-gray-500">{artifact.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {isDouyinMode && videoArtifacts.length > 0 && (
                  <div className="mt-4 grid gap-3 xl:grid-cols-2">
                    {videoArtifacts.map(artifact => (
                      <div key={artifact.id} className="overflow-hidden rounded-xl border border-border bg-background">
                        <video src={artifact.url} controls preload="metadata" className="aspect-video w-full bg-black object-contain" />
                        <span className="block truncate px-3 py-2 text-[10px] text-gray-500">{artifact.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </main>

            <aside className="border-t border-border bg-surface p-4 2xl:overflow-y-auto 2xl:border-l 2xl:border-t-0">
              {pipeline.status === 'awaiting_retry' && retryableStage && (
                <section className="mb-5 rounded-xl border border-orange-500/30 bg-orange-500/10 p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-orange-300">Recovery required</div>
                  <div className="mt-2 text-[12px] font-medium text-orange-100">{retryableStage.name}</div>
                  <p className="mt-1 text-[10px] leading-relaxed text-orange-200/80">
                    {currentTask?.error || 'This stage was rolled back and is waiting for an operator decision.'}
                  </p>
                  <p className="mt-2 text-[10px] leading-relaxed text-gray-400">
                    Review the failed input or credentials, then retry from this stage. Completed upstream artifacts will be preserved.
                  </p>
                  <button type="button" onClick={requestRetry} disabled={!!busyAction}
                    className="mt-3 w-full rounded-lg bg-orange-400 px-3 py-2 text-[10px] font-semibold text-black disabled:opacity-40">
                    {busyAction === 'retry' ? 'Retrying…' : `Retry from ${retryableStage.name}`}
                  </button>
                </section>
              )}
              <section>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-600">Run controls</div>
                <div className="mt-3 grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={requestRetry}
                    disabled={!retryableStage || !!busyAction}
                    title={!retryableStage ? 'Retry is available for a rolled-back stage awaiting confirmation.' : undefined}
                    className="rounded-lg bg-blue-500/10 px-2 py-2 text-[10px] font-semibold text-blue-300 transition hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busyAction === 'retry' ? '…' : 'Retry'}
                  </button>
                  <button
                    type="button"
                    onClick={approve}
                    disabled={pipeline.status !== 'paused' || !!busyAction}
                    title={pipeline.status !== 'paused' ? 'Approval is available when this run is paused at a manual gate.' : undefined}
                    className="rounded-lg bg-emerald-500/10 px-2 py-2 text-[10px] font-semibold text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busyAction === 'approve' ? '…' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void runPipelineAction('skip')}
                    title={publishStageAhead ? 'The publish gate cannot be bypassed with Skip.' : undefined}
                    disabled={
                      !isActivePipeline(pipeline)
                      || !!busyAction
                      || publishStageAhead
                    }
                    className="rounded-lg bg-amber-500/10 px-2 py-2 text-[10px] font-semibold text-amber-300 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busyAction === 'skip' ? '…' : 'Skip'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCancelArmed(true)}
                    disabled={!isActivePipeline(pipeline) || !!busyAction}
                    className="rounded-lg bg-red-500/10 px-2 py-2 text-[10px] font-semibold text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
                {canRegenerateSelectedStage && (
                  <button
                    type="button"
                    onClick={() => void regenerateSelectedStage()}
                    disabled={!!busyAction}
                    className="mt-2 w-full rounded-lg border border-blue-400/20 bg-blue-500/10 px-3 py-2 text-[10px] font-semibold text-blue-300 hover:bg-blue-500/20 disabled:opacity-40"
                  >
                    {busyAction === 'regenerate' ? 'Regenerating images…' : 'Regenerate images'}
                  </button>
                )}
                {cancelArmed && (
                  <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
                    <p className="text-[11px] leading-relaxed text-red-200">Cancel this run and stop its active workflow stage?</p>
                    <div className="mt-2 flex gap-2">
                      <button type="button" onClick={() => void runPipelineAction('cancel')} className="rounded-md bg-red-500 px-2.5 py-1.5 text-[10px] font-semibold text-white">Cancel run</button>
                      <button type="button" onClick={() => setCancelArmed(false)} className="rounded-md px-2.5 py-1.5 text-[10px] text-gray-400 hover:text-white">Keep run</button>
                    </div>
                  </div>
                )}
              </section>

              <section className="mt-5 border-t border-border pt-5">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-600">Participants</div>
                  <span className="text-[9px] text-gray-600">{participantRoles.length} roles</span>
                </div>
                <div className="mt-3 space-y-2">
                  {participantRoles.map(role => {
                    const agent = agents.find(item => item.id === role || item.role === role);
                    const isStageAgent = role === selectedStageDetails?.agentRole;
                    return (
                      <div key={role} className={cn('flex items-center gap-2 rounded-lg border p-2', isStageAgent ? 'border-accent/40 bg-accent/10' : 'border-border bg-background')}>
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface text-sm">{agent?.emoji || '✦'}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-medium text-gray-300">{agent?.name || role}</span>
                          <span className="block truncate text-[9px] text-gray-600">{role}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="mt-5 border-t border-border pt-5">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-600">Request a revision</div>
                <p className="mt-1 text-[10px] leading-relaxed text-gray-500">
                  Launches a direct task for {selectedAgent?.name || selectedStageDetails?.agentRole || 'the selected stage agent'} without advancing this run.
                </p>
                <textarea
                  value={revisionPrompt}
                  onChange={event => { setRevisionPrompt(event.target.value); setRevisionState('idle'); }}
                  placeholder="What should change in this stage?"
                  rows={4}
                  disabled={!selectedAgent || !selectedStageDetails || revisionState === 'sending'}
                  className="mt-3 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[11px] leading-relaxed text-gray-200 outline-none placeholder:text-gray-700 focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => void submitRevision()}
                  disabled={!selectedAgent || !revisionPrompt.trim() || revisionState === 'sending'}
                  className="mt-2 w-full rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-[11px] font-semibold text-accent-light hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {revisionState === 'sending' ? 'Starting revision…' : 'Launch revision task'}
                </button>
                {revisionMessage && <p className={cn('mt-2 text-[10px] leading-relaxed', revisionState === 'error' ? 'text-red-300' : 'text-emerald-300')}>{revisionMessage}</p>}
              </section>
            </aside>
          </div>
        </>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={() => setShowCreate(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="content-run-title" className="w-full max-w-xl rounded-2xl border border-border bg-surface p-5 shadow-2xl" onMouseDown={event => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-light">New workflow</div>
                <h3 id="content-run-title" className="mt-1 text-lg font-bold">{workflow.createLabel}</h3>
              </div>
              <button type="button" onClick={() => setShowCreate(false)} aria-label="Close create run dialog" className="text-gray-500 hover:text-white">×</button>
            </div>
            {!workflowTemplate ? (
              <p className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">The required “{workflow.templateName}” template is unavailable. Refresh templates and try again.</p>
            ) : (
              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="text-[11px] font-medium text-gray-300">Run name <span className="text-gray-600">(optional)</span></span>
                  <input value={runName} onChange={event => setRunName(event.target.value)} placeholder="e.g. Productivity tips · July" className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent" />
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium text-gray-300">
                    {isDouyinMode ? 'Video production brief and local video path' : 'Production brief'}
                  </span>
                  <textarea
                    value={runInput}
                    onChange={event => setRunInput(event.target.value)}
                    rows={isDouyinMode ? 7 : 5}
                    placeholder={isDouyinMode
                      ? 'Describe the topic and audience, then provide the real absolute video path, for example:\nvideo_path: /Users/me/Videos/final.mp4\nThe path must exist before media QA and publishing.'
                      : 'Describe the audience, topic, evidence to cover, and desired outcome…'}
                    className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-gray-700 focus:border-accent"
                  />
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-accent/20 bg-accent/5 p-3">
                  <input type="checkbox" checked={gateMode === 'manual'} onChange={event => setGateMode(event.target.checked ? 'manual' : 'auto')} className="mt-0.5 accent-[var(--color-accent)]" />
                  <span>
                    <span className="block text-xs font-semibold text-gray-200">Manual gates</span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-gray-500">Enabled by default. Review every completed stage, with an additional typed confirmation before publish execution.</span>
                  </span>
                </label>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setShowCreate(false)} className="rounded-lg px-3 py-2 text-xs text-gray-400 hover:text-white">Cancel</button>
                  <button type="button" onClick={() => void createRun()} disabled={!runInput.trim() || busyAction === 'create'} className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-40">
                    {busyAction === 'create' ? 'Creating…' : 'Create manual-gated run'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showPublishConfirm && pipeline && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="publish-confirm-title" className="w-full max-w-md rounded-2xl border border-amber-500/40 bg-surface p-5 shadow-2xl">
            <div className="text-xl">⚠</div>
            <h3 id="publish-confirm-title" className="mt-2 text-lg font-bold">
              {publishConfirmAction === 'retry' ? 'Retry the publish stage?' : 'Approve into publish execution?'}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-gray-400">
              {publishConfirmAction === 'retry'
                ? `This creates a new publisher task for “${pipeline.name}”. Check the platform first because the interrupted attempt may have reached it.`
                : `This advances “${pipeline.name}” to the social publisher. Verify the final copy and ${isDouyinMode ? 'local video file' : 'generated PNGs'} before allowing platform publishing tools to run.`}
            </p>
            <label className="mt-4 block text-[11px] font-medium text-gray-300">
              Type <span className="rounded bg-background px-1.5 py-0.5 font-mono text-amber-200">PUBLISH</span> to continue
              <input value={publishPhrase} onChange={event => setPublishPhrase(event.target.value)} autoFocus className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-amber-400" />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setShowPublishConfirm(false)} className="rounded-lg px-3 py-2 text-xs text-gray-400 hover:text-white">Go back</button>
              <button
                type="button"
                onClick={() => {
                  setShowPublishConfirm(false);
                  if (publishConfirmAction === 'retry') void retryCurrentStage(true);
                  else void runPipelineAction('approve', true);
                }}
                disabled={publishPhrase !== 'PUBLISH' || busyAction === publishConfirmAction}
                className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-bold text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {publishConfirmAction === 'retry' ? 'Retry publish stage' : 'Approve publish stage'}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewArtifact && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-6" onClick={() => setPreviewArtifact(null)}>
          <div className="flex max-h-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl" onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.18em] text-accent-light">
                  {previewArtifact.kind === 'video' ? 'Video preview' : 'Image preview'}
                </div>
                <div className="mt-1 truncate text-sm font-semibold">{previewArtifact.name}</div>
              </div>
              <button type="button" onClick={() => setPreviewArtifact(null)} className="rounded-lg px-3 py-1.5 text-sm text-gray-400 hover:bg-surface-hover hover:text-white">✕</button>
            </div>
            <div className="min-h-0 overflow-auto bg-black/30 p-4">
              {previewArtifact.kind === 'video'
                ? <video src={previewArtifact.url} controls autoPlay className="mx-auto max-h-[78vh] max-w-full object-contain" />
                : <img src={previewArtifact.url} alt={previewArtifact.name} className="mx-auto max-h-[78vh] max-w-full object-contain" />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
