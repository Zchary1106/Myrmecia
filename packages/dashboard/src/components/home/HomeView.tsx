import { useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes } from 'react';
import { ArrowUpRight, AtSign, ChevronDown, ChevronRight, Clock3, FolderOpen, GitBranch, Inbox, MessageSquareText, Plus, Users, X } from 'lucide-react';
import { api, type TeamDTO } from '../../lib/api';
import { useStore } from '../../stores/store';
import { cn } from '../../lib/utils';
import { WorkLauncher, type LaunchMode } from '../common/WorkLauncher';
import { ServiceConnections } from './ServiceConnections';
import { compactTaskTitle, homeConversations, type HomeConversation } from './homeActivity';
import { useConversationStore, workflowConversationLabel } from '../../stores/conversations';
import { LiquidLens } from '../common/LiquidLens';
import type { ProviderModelOption, Task } from '@myrmecia/shared';

const starterPrompts = [
  { label: 'Fix a GitHub issue', text: 'Inspect this GitHub issue, reproduce the problem, and prepare a focused fix.' },
  { label: 'Create social content', text: 'Turn this repository into a Xiaohongshu post, Douyin video brief, and WeChat article.' },
  { label: 'Review a codebase', text: 'Review the current project for high-impact bugs, missing tests, and release risks.' },
];

const WORKSPACE_STORAGE_KEY = 'myrmecia.workspace-config';
const MODEL_PREFERENCES_STORAGE_KEY = 'myrmecia.model-preferences';
type WorkspaceSource = 'local' | 'remote';
type WorkspaceConfig = { source: WorkspaceSource; path: string; name: string; repository?: string; branch?: string };
type ReasoningChoice = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type ContextChoice = 'auto' | '32000' | '128000' | '200000' | '1050000';
type ModelPreferences = { modelId: string; reasoningEffort: ReasoningChoice; contextLength: ContextChoice };

type DirectoryInputAttributes = InputHTMLAttributes<HTMLInputElement> & {
  webkitdirectory?: string;
  directory?: string;
};

function DirectoryInput(props: DirectoryInputAttributes) {
  const { webkitdirectory, directory, ...inputProps } = props;
  return <input {...inputProps} {...({ webkitdirectory, directory } as Record<string, string | undefined>)} />;
}

function providerModelLabel(model: ProviderModelOption): string {
  // The provider's display name is enough here. Showing the id as a suffix
  // makes providers that use the same value for both fields look duplicated.
  return model.name || model.id;
}

function timeBasedGreeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function StatusDot({ status }: { status: string }) {
  return (
    <span className={cn(
      'h-2 w-2 shrink-0 rounded-full',
      status === 'running' || status === 'assigned' ? 'bg-blue-400 shadow-[0_0_0_3px_rgb(86_145_255_/_0.12)]' :
      status === 'failed' || status === 'blocked' ? 'bg-red-400' :
      status === 'paused' || status === 'awaiting_retry' ? 'bg-amber-400' :
      status === 'done' ? 'bg-emerald-400' : 'bg-gray-500',
    )} />
  );
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

export function HomeView() {
  const conversationStates = useConversationStore(state => state.states);
  const { agents, tasks, pipelines, executions, inboxEntries, health, models, loadModels, loadTasks, setActiveView, setSelectedTaskId } = useStore();
  const [input, setInput] = useState('');
  const [showLauncher, setShowLauncher] = useState(false);
  const [launcherMode, setLauncherMode] = useState<LaunchMode>('master');
  const [launcherTemplateId, setLauncherTemplateId] = useState('');
  const [launchBusy, setLaunchBusy] = useState(false);
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [workspaceSource, setWorkspaceSource] = useState<WorkspaceSource>('local');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteBranch, setRemoteBranch] = useState('');
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [modelId, setModelId] = useState('auto');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningChoice>('auto');
  const [contextLength, setContextLength] = useState<ContextChoice>('auto');
  const [modelPreferencesLoaded, setModelPreferencesLoaded] = useState(false);
  const [modelOptionsOpen, setModelOptionsOpen] = useState(false);
  const [providerModels, setProviderModels] = useState<ProviderModelOption[] | null>(null);
  const [providerName, setProviderName] = useState('');
  const [providerSource, setProviderSource] = useState<'provider' | 'registry'>('registry');
  const taskInputRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!teamPickerOpen && !modelOptionsOpen && !workspacePickerOpen) return;
    const close = () => {
      setTeamPickerOpen(false);
      setModelOptionsOpen(false);
      setWorkspacePickerOpen(false);
    };
    const onOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !composerRef.current?.contains(event.target)) close();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        taskInputRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [teamPickerOpen, modelOptionsOpen, workspacePickerOpen]);

  const enabledModels = useMemo(() => models.filter(model => model.enabled && model.id !== 'auto'), [models]);
  const selectedTeam = useMemo(
    () => selectedTeamId ? teams.find(team => team.id === selectedTeamId) : undefined,
    [selectedTeamId, teams],
  );
  const availableModels = providerModels || enabledModels.map(model => ({
    id: model.id,
    name: model.displayName,
    supportsReasoningEffort: model.capabilityTags.includes('reasoning') || model.capabilityTags.includes('reasoning-effort'),
    supportedReasoningEfforts: [],
    maxTokens: model.maxTokens,
    source: 'registry' as const,
    selectable: true,
  }));
  const selectedModel = enabledModels.find(model => model.id === modelId);
  const selectedProviderModel = availableModels.find(model => model.id === modelId);
  const selectedModelLabel = selectedModel?.displayName || selectedProviderModel?.name || 'Auto';
  const supportedReasoningEfforts = selectedProviderModel?.supportedReasoningEfforts || [];
  const reasoningLabel = reasoningEffort === 'auto'
    ? 'Default'
    : ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' } as Record<Exclude<ReasoningChoice, 'auto'>, string>)[reasoningEffort];
  const contextLabel = contextLength === 'auto' ? 'Default' : contextLength === '1050000' ? '1M' : `${Number(contextLength) / 1000}K`;

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(MODEL_PREFERENCES_STORAGE_KEY) || 'null') as Partial<ModelPreferences> | null;
      if (saved?.modelId) setModelId(saved.modelId);
      if (saved?.reasoningEffort && ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(saved.reasoningEffort)) setReasoningEffort(saved.reasoningEffort);
      if (saved?.contextLength && ['auto', '32000', '128000', '200000', '1050000'].includes(saved.contextLength)) setContextLength(saved.contextLength);
    } catch {
      // localStorage may be unavailable in restricted browser contexts.
    } finally {
      setModelPreferencesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!modelPreferencesLoaded) return;
    try {
      window.localStorage.setItem(MODEL_PREFERENCES_STORAGE_KEY, JSON.stringify({ modelId, reasoningEffort, contextLength } satisfies ModelPreferences));
    } catch {
      // localStorage may be unavailable in restricted browser contexts.
    }
  }, [contextLength, modelId, modelPreferencesLoaded, reasoningEffort]);

  useEffect(() => {
    let cancelled = false;
    api.models.providerSettings().then(settings => {
      if (cancelled) return;
      setProviderModels(settings.models);
      setProviderName(settings.provider);
      setProviderSource(settings.source || 'registry');
      setModelId(current => current !== 'auto' && settings.models.length > 0 && !settings.models.some(model => model.id === current)
        ? settings.selectedModelId || 'auto'
        : current);
      void loadModels();
    }).catch(() => {
      if (!cancelled) setProviderModels(null);
    });
    return () => { cancelled = true; };
  }, [loadModels]);

  useEffect(() => {
    if (providerModels !== null && reasoningEffort !== 'auto' && !supportedReasoningEfforts.includes(reasoningEffort)) {
      setReasoningEffort('auto');
    }
  }, [providerModels, reasoningEffort, selectedProviderModel?.id, supportedReasoningEfforts]);

  const conversations = useMemo(
    () => homeConversations(tasks, pipelines, agents, executions).filter(item => !conversationStates[item.id] && !conversationStates[`task:${item.task.id}`]),
    [tasks, pipelines, agents, executions, conversationStates],
  );
  const activeConversations = conversations.filter(conversation => conversation.active);
  const recentConversations = conversations.filter(conversation => !conversation.active).slice(0, 4);
  const runningPipelines = pipelines.filter(pipeline => pipeline.status === 'running').length;
  const waitingPipelines = pipelines.filter(pipeline => ['paused', 'blocked', 'awaiting_retry'].includes(pipeline.status)).length;
  const pendingReviews = inboxEntries.filter(entry => entry.status === 'pending').length;
  const greeting = timeBasedGreeting();

  useEffect(() => {
    if (models.length === 0) void loadModels();
    api.teams.list().then(setTeams).catch(() => {});
    void window.myrmeciaDesktopIntegrations?.getWorkspace().then(workspace => {
      if (workspace.configured) {
        setWorkspace({ source: 'local', path: workspace.path, name: workspace.name });
      }
    }).catch(() => {});
    try {
      const savedWorkspace = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) || 'null') as WorkspaceConfig | null;
      if (savedWorkspace?.path && savedWorkspace.name) setWorkspace(current => current || savedWorkspace);
    } catch {
      // localStorage may be unavailable in restricted browser contexts.
    }
  }, [loadModels, models.length]);

  const openWorkspacePicker = () => {
    setWorkspaceError(null);
    setTeamPickerOpen(false);
    setModelOptionsOpen(false);
    setWorkspaceSource(workspace?.source || 'local');
    setRemoteUrl(workspace?.repository || '');
    setRemoteBranch(workspace?.branch || '');
    setLocalFiles([]);
    setWorkspacePickerOpen(true);
  };

  const chooseWorkspace = async () => {
    if (!window.myrmeciaDesktopIntegrations || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    try {
      const workspace = await window.myrmeciaDesktopIntegrations.selectWorkspace();
      if (workspace.configured) {
        const next = { source: 'local' as const, path: workspace.path, name: workspace.name };
        setWorkspace(next);
        try { window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore storage errors */ }
        setWorkspacePickerOpen(false);
      }
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Unable to select workspace.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const saveLocalWorkspace = async () => {
    if (!localFiles.length || workspaceBusy) {
      setWorkspaceError('请选择一个包含文件的本地文件夹。');
      return;
    }
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    try {
      const rootName = localFiles[0].webkitRelativePath.split('/')[0] || 'local-workspace';
      const session = await api.workspaces.createLocal(rootName);
      for (const file of localFiles) {
        const relativePath = file.webkitRelativePath.split('/').slice(1).join('/') || file.name;
        await api.workspaces.uploadLocalFile(session.id, relativePath, file);
      }
      const imported = await api.workspaces.completeLocal(session.id);
      const next = { source: 'local' as const, path: imported.path, name: rootName };
      setWorkspace(next);
      try { window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore storage errors */ }
      setWorkspacePickerOpen(false);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Unable to import local workspace.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const saveRemoteWorkspace = async () => {
    if (!remoteUrl.trim() || workspaceBusy) {
      setWorkspaceError('请输入远程 Git 仓库地址。');
      return;
    }
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    try {
      const imported = await api.workspaces.cloneRemote(remoteUrl.trim(), remoteBranch.trim() || undefined);
      const next = { source: 'remote' as const, path: imported.path, name: imported.repository.split('/').pop()?.replace(/\.git$/, '') || imported.name, repository: imported.repository, branch: imported.branch };
      setWorkspace(next);
      try { window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore storage errors */ }
      setWorkspacePickerOpen(false);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Unable to clone remote workspace.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const clearWorkspace = async () => {
    setWorkspace(null);
    try { window.localStorage.removeItem(WORKSPACE_STORAGE_KEY); } catch { /* ignore storage errors */ }
    if (window.myrmeciaDesktopIntegrations) {
      try { await window.myrmeciaDesktopIntegrations.clearWorkspace(); } catch { /* keep the web state cleared */ }
    }
    setWorkspacePickerOpen(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const goal = input.trim();
    if (!goal || launchBusy) return;
    setLaunchBusy(true);
    setLaunchMessage(null);
    setLaunchError(null);
    try {
      const preferences = {
        modelId: modelId === 'auto' ? undefined : modelId,
        reasoningEffort: reasoningEffort === 'auto' ? undefined : reasoningEffort,
        contextLength: contextLength === 'auto' ? undefined : Number(contextLength),
      };
      const task = selectedTeam
        ? await api.teams.dispatch(selectedTeam.id, goal, workspace?.path, preferences)
          .then(async ({ run }) => run.parentTaskId ? api.tasks.get(run.parentTaskId) : undefined)
        : (await api.supervisor.dispatch(goal, {
            ...preferences,
            workspacePath: workspace?.path || undefined,
            workspaceMode: Boolean(workspace?.path),
          })).tasks[0];
      await loadTasks();
      if (task) {
        setSelectedTaskId(task.id);
        setInput('');
        setSelectedTeamId(null);
        setLaunchMessage(null);
        setActiveView('session');
      } else {
        setLaunchMessage(selectedTeam ? `${selectedTeam.name} 已开始处理这个目标。` : 'Agent 已处理这个目标。');
      }
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : 'Unable to start the Agent task.');
    } finally {
      setLaunchBusy(false);
    }
  };

  const selectTeam = (teamId: string) => {
    setSelectedTeamId(teamId);
    setTeamPickerOpen(false);
    requestAnimationFrame(() => taskInputRef.current?.focus());
  };

  const openWorkflowLauncher = (templateId = '') => {
    setLauncherMode('pipeline');
    setLauncherTemplateId(templateId);
    setTeamPickerOpen(false);
    setModelOptionsOpen(false);
    setWorkspacePickerOpen(false);
    setShowLauncher(true);
  };

  const openTaskRun = (taskId: string) => {
    setSelectedTaskId(taskId);
    setActiveView('session');
  };

  return (
    <div data-home-workspace className="home-canvas glass-home flex min-h-full w-full flex-col px-4 py-6 sm:px-8 sm:py-8 lg:px-12">
      <div data-home-content className="relative z-10 mx-auto my-auto w-full max-w-[880px]">
      <div className="relative z-40 mb-6 flex flex-wrap items-center justify-between gap-3 sm:mb-8">
        <div role="status" className="inline-flex items-center gap-2 text-[11px] text-app-muted">
          <span className={cn('h-1.5 w-1.5 rounded-full', health?.status === 'ok' ? 'bg-emerald-500' : 'bg-amber-500')} />
          {health?.status === 'ok' ? 'Server online' : health ? 'Server needs attention' : 'Checking server…'}
        </div>
        <ServiceConnections compact />
      </div>
      <section className="home-welcome-stage w-full">
        <h1 className="text-balance text-2xl font-semibold tracking-[-0.035em] text-app-primary sm:text-3xl">
          {greeting}. <span aria-hidden="true">👋</span>
        </h1>
        <h2 className="mt-2 text-sm font-normal leading-6 text-app-secondary">What should your team work on?</h2>
        <form ref={composerRef} onSubmit={event => void submit(event)} className="home-command-card relative mt-4 p-2 text-left transition sm:p-3">
          <LiquidLens />
          <textarea
            ref={taskInputRef}
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit(event);
            }}
            rows={3}
            aria-label="Describe work for your Agent Team"
            placeholder={selectedTeam ? `Describe work for ${selectedTeam.name}...` : 'Describe a goal, a bug, or a piece of content to create...'}
            className="min-h-[88px] w-full resize-none bg-transparent px-3 py-3 text-sm leading-6 text-app-primary outline-none placeholder:text-app-muted"
          />
          <div className="flex flex-wrap items-end justify-between gap-3 px-1 pb-1">
            <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-app-muted sm:w-auto sm:flex-1">
              <button type="button" onClick={() => openWorkflowLauncher()} className="home-tool-button app-focus" aria-label="Choose workflow" title="Choose workflow">
                <GitBranch size={15} />
              </button>
              <div className="static sm:relative">
                <button
                  type="button"
                  onClick={() => { setTeamPickerOpen(current => !current); setModelOptionsOpen(false); setWorkspacePickerOpen(false); }}
                  className={cn('home-tool-button app-focus gap-1.5 px-2.5', teamPickerOpen && 'border-accent/50 bg-accent/10 text-accent-light')}
                  aria-label="Choose a Team"
                  aria-expanded={teamPickerOpen}
                  aria-controls="team-picker"
                  title="Choose a Team"
                >
                  <AtSign size={15} />
                  {!selectedTeam && <span>Master Agent</span>}
                </button>
                {teamPickerOpen && (
                  <div id="team-picker" role="dialog" aria-label="Choose a Team" className="glass-popup absolute left-0 top-full z-30 mt-2 max-h-[min(320px,40dvh)] w-full overflow-y-auto rounded-xl border border-border bg-surface p-2 text-left shadow-xl sm:w-[360px]">
                    <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-app-muted">Choose a Team</div>
                    {teams.length > 0 ? teams.slice(0, 6).map(team => (
                      <button key={team.id} type="button" onClick={() => selectTeam(team.id)} className="app-focus flex w-full items-center gap-2 rounded-xl px-2 py-2.5 text-left transition hover:bg-surface-hover">
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent-light"><Users size={14} /></span>
                        <span className="min-w-0 flex-1"><span className="block truncate text-xs text-app-primary">{team.name}</span><span className="block truncate text-[10px] text-app-muted">{team.blurb || `${team.members.length} members`}</span></span>
                        <ChevronRight size={14} className="text-app-muted" />
                      </button>
                    )) : <div className="px-2 py-4 text-xs text-app-muted">No Teams available yet.</div>}
                    <button type="button" onClick={() => setActiveView('teams')} className="app-focus mt-1 w-full rounded-xl px-2 py-2 text-left text-[11px] text-accent-light transition hover:bg-accent/10">Manage Teams</button>
                  </div>
                )}
              </div>
              {selectedTeam && (
                <span className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[11px] font-medium text-accent-light">
                  <AtSign size={13} className="shrink-0" />
                  <span className="truncate">{selectedTeam.name}</span>
                  <button type="button" onClick={() => setSelectedTeamId(null)} className="app-focus -mr-1 rounded p-0.5 text-accent-light/75 transition hover:bg-accent/15 hover:text-app-primary" aria-label={`Clear selected team ${selectedTeam.name}`} title="Clear selected team">
                    <X size={12} />
                  </button>
                </span>
              )}
              <button
                type="button"
                onClick={openWorkspacePicker}
                title={workspace?.path || 'Set a workspace'}
                className={cn('home-tool-button app-focus min-w-0 max-w-[calc(100%-5rem)] gap-1.5 px-2.5 sm:max-w-[210px]', workspace && 'border-accent/30 text-accent-light')}
              >
                <FolderOpen size={14} />
                <span className="truncate">{workspace?.name || 'Set workspace'}</span>
              </button>
              <div className="relative mt-1 min-w-0 basis-full sm:ml-1 sm:mt-0 sm:basis-auto">
                <button
                  type="button"
                  onClick={() => { setModelOptionsOpen(current => !current); setTeamPickerOpen(false); setWorkspacePickerOpen(false); }}
                  aria-label="Model settings"
                  aria-expanded={modelOptionsOpen}
                  aria-controls="model-options"
                  title="Models are loaded from the model registry"
                  className={cn('glass-control app-focus inline-flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border bg-background/70 px-3 py-1.5 text-xs text-app-secondary transition hover:border-accent/50 hover:bg-surface-hover hover:text-app-primary sm:w-auto sm:max-w-[320px]', modelOptionsOpen && 'border-accent/60 bg-surface-hover text-app-primary')}
                >
                  <span className="truncate">{modelId === 'auto' ? 'Route by task' : selectedModelLabel}</span>
                  {reasoningEffort !== 'auto' && <span className="shrink-0 text-app-muted">{reasoningLabel}</span>}
                  {contextLength !== 'auto' && <span className="shrink-0 text-app-muted">{contextLabel}</span>}
                  <ChevronDown size={13} className="shrink-0 text-app-muted" />
                </button>
                {modelOptionsOpen && (
                  <div id="model-options" className="glass-popup absolute left-0 top-full z-30 mt-2 max-h-[50dvh] w-full overflow-y-auto rounded-xl border border-border bg-surface p-4 text-left shadow-xl sm:w-[320px]" role="dialog" aria-label="Model settings">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="text-sm font-semibold text-app-primary">Model settings</h2>
                        <p className="mt-1 text-[11px] leading-relaxed text-app-muted">{providerSource === 'provider' ? `Live models from ${providerName || 'the configured provider'}.` : 'Using the configured registry fallback; connect the provider to refresh live models.'}</p>
                      </div>
                      <button type="button" onClick={() => setModelOptionsOpen(false)} className="app-focus rounded-lg p-1 text-app-muted hover:bg-surface-hover hover:text-app-primary" aria-label="Close model settings"><X size={15} /></button>
                    </div>
                    <label className="mt-3 block text-[11px] text-app-secondary">
                      Model
                      <select value={modelId} onChange={event => setModelId(event.target.value)} aria-label="Model choice" className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs text-app-primary outline-none transition focus:border-accent">
                        <option value="auto">Route by task</option>
                        {availableModels.map(model => <option key={model.id} value={model.id}>{providerModelLabel(model)}</option>)}
                      </select>
                    </label>
                    <label className="mt-3 block text-[11px] text-app-secondary">
                      Reasoning effort
                      <select value={reasoningEffort} onChange={event => setReasoningEffort(event.target.value as ReasoningChoice)} aria-label="Reasoning effort" className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs text-app-primary outline-none transition focus:border-accent">
                        <option value="auto">Provider default</option>
                        {supportedReasoningEfforts.map(effort => <option key={effort} value={effort}>{({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' } as Record<string, string>)[effort] || effort}</option>)}
                      </select>
                    </label>
                    <label className="mt-3 block text-[11px] text-app-secondary">
                      Context length
                      <select value={contextLength} onChange={event => setContextLength(event.target.value as ContextChoice)} aria-label="Context length" className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs text-app-primary outline-none transition focus:border-accent">
                        <option value="auto">Default</option>
                        <option value="32000">32K tokens</option>
                        <option value="128000">128K tokens</option>
                        <option value="200000">200K tokens</option>
                        <option value="1050000" disabled={Boolean(selectedModel?.maxTokens && selectedModel.maxTokens < 1_050_000)}>1M tokens</option>
                      </select>
                    </label>
                  </div>
                )}
              </div>
            </div>
            <button type="submit" disabled={!input.trim() || launchBusy} className="home-primary-button app-focus inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-xs font-semibold text-white transition duration-200 hover:-translate-y-0.5 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto">
              {launchBusy ? 'Sending…' : selectedTeam ? `Send to ${selectedTeam.name}` : 'Send to Master Agent'} <ArrowUpRight size={14} />
            </button>
          </div>
          {workspace && <div className="truncate px-2 pt-2 text-[10px] text-app-muted">Working in {workspace.name}</div>}
          {launchError && <p className="px-2 pt-2 text-[11px] text-red-500">{launchError}</p>}
          {workspacePickerOpen && (
            <div className="glass-popup absolute left-0 top-full z-30 mt-2 max-h-[50dvh] w-full overflow-y-auto rounded-xl border border-border bg-surface p-4 text-left shadow-xl sm:w-[460px]" role="dialog" aria-label="Set workspace">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-app-primary">Set workspace</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-app-muted">Choose a local folder or import a remote Git repository for the next run.</p>
                </div>
                <button type="button" onClick={() => setWorkspacePickerOpen(false)} className="app-focus rounded-lg p-1 text-app-muted hover:bg-surface-hover hover:text-app-primary" aria-label="Close workspace picker"><X size={15} /></button>
              </div>
              <div className="mt-3 flex gap-1 rounded-lg bg-background p-1">
                {(['local', 'remote'] as const).map(source => <button key={source} type="button" onClick={() => { setWorkspaceSource(source); setWorkspaceError(null); }} className={cn('flex-1 rounded-md px-2 py-1.5 text-[11px] transition', workspaceSource === source ? 'bg-surface-hover text-app-primary' : 'text-app-muted hover:text-app-primary')}>{source === 'local' ? 'Local folder' : 'Remote Git repo'}</button>)}
              </div>
              {workspaceSource === 'local' ? (
                <div className="mt-3">
                  {window.myrmeciaDesktopIntegrations ? (
                    <button type="button" onClick={() => void chooseWorkspace()} disabled={workspaceBusy} className="app-focus w-full rounded-lg border border-dashed border-border px-3 py-4 text-xs text-app-secondary hover:border-accent/50 hover:text-app-primary disabled:opacity-50">{workspaceBusy ? 'Opening…' : 'Choose a folder from this computer'}</button>
                  ) : (
                    <label className="block cursor-pointer rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-app-secondary hover:border-accent/50 hover:text-app-primary">
                      <DirectoryInput type="file" className="sr-only" webkitdirectory="true" directory="true" multiple onChange={event => setLocalFiles(Array.from(event.target.files || []))} />
                      {localFiles.length ? `${localFiles.length} files selected` : 'Choose a local folder'}
                    </label>
                  )}
                </div>
              ) : (
                <div className="mt-3 space-y-2">
                  <input value={remoteUrl} onChange={event => { setRemoteUrl(event.target.value); setWorkspaceError(null); }} placeholder="https://github.com/owner/repository.git" aria-label="Remote repository URL" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-app-primary outline-none focus:border-accent" />
                  <input value={remoteBranch} onChange={event => setRemoteBranch(event.target.value)} placeholder="Branch (optional, default branch)" aria-label="Remote repository branch" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-app-primary outline-none focus:border-accent" />
                </div>
              )}
              {workspaceError && <p className="mt-2 text-[11px] text-red-500">{workspaceError}</p>}
              <div className="mt-3 flex items-center justify-between gap-2">
                <button type="button" onClick={() => void clearWorkspace()} className="app-focus rounded-lg px-2.5 py-1.5 text-[11px] text-app-muted hover:bg-surface-hover hover:text-app-primary">Clear</button>
                {workspaceSource === 'remote' || !window.myrmeciaDesktopIntegrations ? <button type="button" onClick={() => void (workspaceSource === 'remote' ? saveRemoteWorkspace() : saveLocalWorkspace())} disabled={workspaceBusy} className="app-focus rounded-lg bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-accent-light disabled:opacity-50">{workspaceBusy ? 'Preparing…' : 'Use workspace'}</button> : null}
              </div>
            </div>
          )}
        </form>

        {launchMessage && <p className="mt-3 text-center text-[11px] text-emerald-500">{launchMessage}</p>}

        <nav aria-label="Task shortcuts" className="mt-3 flex flex-wrap items-center gap-1 text-left">
          {starterPrompts.map(prompt => (
            <button key={prompt.label} type="button" onClick={() => { setInput(prompt.text); setLaunchMessage(null); setLaunchError(null); requestAnimationFrame(() => taskInputRef.current?.focus()); }} className="home-prompt-card app-focus group">
              <Plus size={12} className="shrink-0" />
              <span>{prompt.label}</span>
            </button>
          ))}
          <button type="button" aria-label="Browse workflows" onClick={() => setActiveView('orchestrator')} className="app-focus ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[11px] text-app-muted transition hover:bg-surface-hover hover:text-app-primary">
            Workflows <ArrowUpRight size={12} />
          </button>
        </nav>
      </section>

      {(pendingReviews > 0 || runningPipelines > 0 || waitingPipelines > 0) && (
        <nav aria-label="Work needing attention" className="mt-7 flex flex-wrap items-center gap-2">
          {pendingReviews > 0 && <button type="button" onClick={() => setActiveView('inbox')} className="app-focus inline-flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-app-secondary"><Inbox size={14} className="text-amber-500" />{pendingReviews} awaiting your input<ChevronRight size={12} /></button>}
          {(runningPipelines > 0 || waitingPipelines > 0) && <button type="button" onClick={() => setActiveView('orchestrator')} className="app-focus inline-flex flex-wrap items-center gap-2 rounded-lg bg-surface-hover/60 px-3 py-2 text-xs text-app-secondary"><GitBranch size={14} className="text-accent-light" />Workflow runs{runningPipelines > 0 && <span>{runningPipelines} running</span>}{waitingPipelines > 0 && <span className="text-app-muted">{waitingPipelines} paused / waiting</span>}<ChevronRight size={12} /></button>}
        </nav>
      )}

      {activeConversations.length > 0 && (
        <section aria-label="In progress" className="mt-7">
          <PanelHeader title={`In progress · ${activeConversations.length}`} action="View queue" onClick={() => setActiveView('tasks')} />
          <div className="divide-y divide-border/50 rounded-xl border border-accent/15 bg-surface/55">
            {activeConversations.slice(0, 3).map(conversation => <ConversationRow key={conversation.id} conversation={conversation} onClick={() => openTaskRun(conversation.task.id)} />)}
          </div>
        </section>
      )}

      <section aria-label="Recent conversations" className="mt-8">
        <PanelHeader title="Recent conversations" action="View all" onClick={() => setActiveView('session')} />
        <div className="divide-y divide-border/60 border-y border-border/60">
          {recentConversations.map(conversation => <ConversationRow key={conversation.id} conversation={conversation} onClick={() => openTaskRun(conversation.task.id)} />)}
        </div>
        {recentConversations.length === 0 && <div className="flex items-center gap-3 py-7 text-app-muted"><MessageSquareText size={20} strokeWidth={1.5} /><div><p className="text-sm text-app-secondary">Your conversations will appear here</p><p className="mt-1 text-xs">Start a task above, then come back to continue the conversation.</p></div></div>}
      </section>
      </div>

      {showLauncher && (
        <WorkLauncher
          initialInput={input}
          initialMode={launcherMode}
          initialTemplateId={launcherTemplateId}
          initialWorkspacePath={workspace?.path || ''}
          initialModelId={modelId}
          initialReasoningEffort={reasoningEffort}
          initialContextLength={contextLength}
          onClose={() => setShowLauncher(false)}
        />
      )}
    </div>
  );
}

function PanelHeader({ title, action, onClick }: { title: string; action: string; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 pb-3">
      <h2 className="text-sm font-semibold tracking-[-0.01em] text-app-primary">{title}</h2>
      <button type="button" onClick={onClick} className="app-focus inline-flex items-center gap-1 text-[11px] text-app-muted transition hover:text-app-primary">{action}<ArrowUpRight size={13} /></button>
    </div>
  );
}

function ConversationRow({ conversation, onClick }: { conversation: HomeConversation; onClick: () => void }) {
  const date = new Date(conversation.updatedAt);
  return (
    <button type="button" onClick={onClick} data-home-conversation={conversation.id} className="app-focus group flex w-full items-center gap-3 rounded-lg px-2 py-3.5 text-left transition hover:bg-surface/80 sm:px-3">
      <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-hover/65 text-app-muted sm:inline-flex"><MessageSquareText size={16} strokeWidth={1.6} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 title={conversation.title} className="min-w-0 truncate text-sm font-medium text-app-primary">{compactTaskTitle(conversation.title)}</h3>
          {conversation.turns > 1 && <span className="shrink-0 text-[10px] text-app-muted">{conversation.turns} turns</span>}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-app-muted">
          <span className="max-w-[45%] shrink-0 truncate text-app-secondary">{conversation.agent}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={date.toISOString()} title={date.toLocaleString()} className="shrink-0 tabular-nums">{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
          {conversation.preview && <span className="hidden min-w-0 truncate sm:inline">· {conversation.preview}</span>}
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-app-muted"><StatusDot status={conversation.workflowStatus || conversation.activity.status} /><span className="hidden sm:inline">{workflowConversationLabel(conversation.workflowStatus) || taskStatusLabel(conversation.activity.status)}</span><span className="sr-only sm:hidden">{workflowConversationLabel(conversation.workflowStatus) || taskStatusLabel(conversation.activity.status)}</span></span>
      <ChevronRight size={14} className="shrink-0 text-app-muted transition group-hover:translate-x-0.5 group-hover:text-accent-light" />
    </button>
  );
}
