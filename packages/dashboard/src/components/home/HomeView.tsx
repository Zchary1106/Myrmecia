import { useEffect, useMemo, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronRight, CircleDot, Clock3, FolderOpen, GitBranch, Inbox, Layers3, Plus, Sparkles, Users, X } from 'lucide-react';
import { api, type TeamDTO } from '../../lib/api';
import { useStore } from '../../stores/store';
import { cn } from '../../lib/utils';
import { WorkLauncher, type LaunchMode } from '../common/WorkLauncher';
import type { ProviderModelOption } from '@myrmecia/shared';

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

function StatusDot({ status }: { status: string }) {
  return (
    <span className={cn(
      'h-2 w-2 shrink-0 rounded-full',
      status === 'running' || status === 'assigned' ? 'bg-blue-400 shadow-[0_0_0_3px_rgb(86_145_255_/_0.12)]' :
      status === 'failed' || status === 'blocked' ? 'bg-red-400' :
      status === 'done' ? 'bg-emerald-400' : 'bg-gray-500',
    )} />
  );
}

export function HomeView() {
  const { agents, tasks, pipelines, templates, inboxEntries, health, models, loadModels, setActiveView, setSelectedTaskId } = useStore();
  const [input, setInput] = useState('');
  const [showLauncher, setShowLauncher] = useState(false);
  const [launcherMode, setLauncherMode] = useState<LaunchMode>('direct');
  const [launcherTeamId, setLauncherTeamId] = useState('');
  const [launcherTemplateId, setLauncherTemplateId] = useState('');
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);
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

  const enabledModels = useMemo(() => models.filter(model => model.enabled && model.id !== 'auto'), [models]);
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

  const activeTasks = useMemo(
    () => tasks.filter(task => ['running', 'assigned', 'queued'].includes(task.status)).slice(0, 4),
    [tasks],
  );
  const activePipelines = useMemo(
    () => pipelines.filter(pipeline => ['running', 'paused', 'blocked'].includes(pipeline.status)).slice(0, 3),
    [pipelines],
  );
  const pendingReviews = inboxEntries.filter(entry => entry.status === 'pending').length;
  const runningAgents = agents.filter(agent => (agent.activeExecutions || 0) > 0).length;
  const recentTasks = useMemo(
    () => tasks.filter(task => !['running', 'assigned', 'queued'].includes(task.status)).slice(0, 4),
    [tasks],
  );

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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!input.trim()) return;
    setLauncherMode('direct');
    setLauncherTeamId('');
    setLauncherTemplateId('');
    setShowLauncher(true);
  };

  const openTeamLauncher = (teamId: string) => {
    setInput('');
    setLauncherMode('team');
    setLauncherTeamId(teamId);
    setLauncherTemplateId('');
    setTeamPickerOpen(false);
    setShowLauncher(true);
  };

  const openWorkflowLauncher = (templateId = '') => {
    setLauncherMode('pipeline');
    setLauncherTeamId('');
    setLauncherTemplateId(templateId);
    setShowLauncher(true);
  };

  const openTaskRun = (taskId: string) => {
    setSelectedTaskId(taskId);
    setActiveView('timeline');
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1320px] flex-col px-5 pb-12 pt-8 sm:px-8 lg:px-12 lg:pt-12">
      <section className="mx-auto w-full max-w-[900px] text-center">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-surface/70 px-3 py-1.5 text-[11px] font-medium text-app-secondary shadow-sm">
          <span className={cn('h-1.5 w-1.5 rounded-full', health?.status === 'ok' ? 'bg-emerald-400' : 'bg-amber-400')} />
          {health?.status === 'ok' ? 'Myrmecia is ready' : 'Connecting to runtime'}
        </div>
        <h1 className="text-balance text-3xl font-semibold tracking-[-0.04em] text-app-primary sm:text-5xl">
          What should your team work on?
        </h1>
        <p className="mx-auto mt-4 max-w-[620px] text-sm leading-6 text-app-secondary sm:text-base">
          Bring together Teams, Agents, Skills, and Workflows in one focused workspace.
        </p>

        <form onSubmit={submit} className="app-panel relative mt-9 p-2 text-left transition focus-within:border-accent/60 focus-within:shadow-[0_20px_70px_rgb(86_145_255_/_0.12)]">
          <textarea
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit(event);
            }}
            rows={3}
            aria-label="Describe work for your Agent Team"
            placeholder="Describe a goal, a bug, or a piece of content to create..."
            className="min-h-[92px] w-full resize-none bg-transparent px-4 py-3 text-sm leading-6 text-app-primary outline-none placeholder:text-app-muted"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-2 pt-2">
            <div className="flex items-center gap-1.5 text-[11px] text-app-muted">
              <button type="button" onClick={() => openWorkflowLauncher()} className="app-focus inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition hover:bg-surface-hover hover:text-app-primary">
                <Plus size={14} /> Choose workflow
              </button>
              <button
                type="button"
                onClick={openWorkspacePicker}
                title={workspace?.path || 'Set a workspace'}
                className={cn('app-focus inline-flex max-w-[190px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition hover:bg-surface-hover hover:text-app-primary', workspace && 'text-accent-light')}
              >
                <FolderOpen size={14} />
                <span className="truncate">{workspace?.name || 'Set workspace'}</span>
              </button>
              <div className="relative ml-1">
                <button
                  type="button"
                  onClick={() => setModelOptionsOpen(current => !current)}
                  aria-label="Model settings"
                  aria-expanded={modelOptionsOpen}
                  aria-controls="model-options"
                  title="Models are loaded from the model registry"
                  className={cn('app-focus inline-flex max-w-[320px] items-center gap-2 overflow-hidden rounded-lg border border-border bg-background/70 px-3 py-1.5 text-xs text-app-secondary transition hover:border-accent/50 hover:bg-surface-hover hover:text-app-primary', modelOptionsOpen && 'border-accent/60 bg-surface-hover text-app-primary')}
                >
                  <span className="truncate">{modelId === 'auto' ? 'Route by task' : selectedModelLabel}</span>
                  <span className="shrink-0 text-app-muted">{reasoningLabel}</span>
                  <span className="shrink-0 text-app-muted">{contextLabel}</span>
                  <ChevronDown size={13} className="shrink-0 text-app-muted" />
                </button>
                {modelOptionsOpen && (
                  <div id="model-options" className="absolute left-0 top-full z-30 mt-2 w-[min(320px,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-4 text-left shadow-2xl" role="dialog" aria-label="Model settings">
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
            <button type="submit" disabled={!input.trim()} className="app-focus inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-white transition hover:-translate-y-px hover:bg-accent-light active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40">
              Start work <ArrowUpRight size={14} />
            </button>
          </div>
          {workspacePickerOpen && (
            <div className="absolute bottom-14 left-3 z-30 w-[min(460px,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-4 text-left shadow-2xl" role="dialog" aria-label="Set workspace">
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

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {starterPrompts.map(prompt => (
            <button key={prompt.label} type="button" onClick={() => { setInput(prompt.text); setShowLauncher(true); }} className="app-focus rounded-full border border-border px-3 py-2 text-[11px] text-app-secondary transition hover:border-accent/50 hover:bg-accent/5 hover:text-app-primary">
              {prompt.label}
            </button>
          ))}
        </div>

        <div className="relative mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={() => setTeamPickerOpen(current => !current)} className="app-focus inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-2 text-[11px] text-app-secondary transition hover:border-accent/50 hover:text-app-primary">
            <Users size={13} /> Use a Team
          </button>
          {templates.slice(0, 2).map(template => (
            <button key={template.id} type="button" onClick={() => openWorkflowLauncher(template.id)} className="app-focus inline-flex max-w-[220px] items-center gap-1.5 truncate rounded-full border border-border px-3 py-2 text-[11px] text-app-secondary transition hover:border-accent/50 hover:text-app-primary">
              <GitBranch size={13} /> <span className="truncate">{template.name}</span>
            </button>
          ))}
          {teamPickerOpen && (
            <div className="absolute top-full z-20 mt-2 w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-2 text-left shadow-2xl">
              <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-app-muted">Choose a Team</div>
              {teams.length > 0 ? teams.slice(0, 6).map(team => (
                <button key={team.id} type="button" onClick={() => openTeamLauncher(team.id)} className="app-focus flex w-full items-center gap-2 rounded-xl px-2 py-2.5 text-left transition hover:bg-surface-hover">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent-light"><Users size={14} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-xs text-app-primary">{team.name}</span><span className="block truncate text-[10px] text-app-muted">{team.blurb || `${team.members.length} members`}</span></span>
                  <ChevronRight size={14} className="text-app-muted" />
                </button>
              )) : <div className="px-2 py-4 text-xs text-app-muted">No Teams available yet.</div>}
              <button type="button" onClick={() => setActiveView('teams')} className="app-focus mt-1 w-full rounded-xl px-2 py-2 text-left text-[11px] text-accent-light transition hover:bg-accent/10">Manage Teams</button>
            </div>
          )}
        </div>
      </section>

      <section className="mt-14 grid gap-4 sm:grid-cols-3">
        <Metric icon={<Users size={16} />} label="Active agents" value={`${runningAgents}/${agents.length || 0}`} detail="ready to collaborate" />
        <Metric icon={<CircleDot size={16} />} label="Running work" value={String(activeTasks.length)} detail="across your workspace" />
        <Metric icon={<Inbox size={16} />} label="Needs your input" value={String(pendingReviews)} detail="review gates and decisions" />
      </section>

      <section className="mt-8 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="app-panel overflow-hidden">
          <PanelHeader title="Active work" action="View queue" onClick={() => setActiveView('tasks')} />
          {activeTasks.length > 0 ? activeTasks.map(task => (
            <button key={task.id} type="button" onClick={() => openTaskRun(task.id)} className="app-focus flex w-full items-center gap-3 border-t border-border px-4 py-3.5 text-left transition hover:bg-surface-hover">
              <StatusDot status={task.status} />
              <span className="min-w-0 flex-1 truncate text-sm text-app-primary">{task.title}</span>
              <span className="hidden text-[10px] text-app-muted sm:inline">{task.mode}</span>
              <ChevronRight size={14} className="text-app-muted" />
            </button>
          )) : (
            <EmptyRow icon={<Sparkles size={17} />} text="No active work yet" detail="Start with a goal above." />
          )}
        </div>

        <div className="app-panel overflow-hidden">
          <PanelHeader title="Your workflows" action="Browse all" onClick={() => setActiveView('orchestrator')} />
          {activePipelines.length > 0 ? activePipelines.map(pipeline => (
            <button key={pipeline.id} type="button" onClick={() => setActiveView('orchestrator')} className="app-focus flex w-full items-center gap-3 border-t border-border px-4 py-3.5 text-left transition hover:bg-surface-hover">
              <Layers3 size={16} className="text-accent-light" />
              <span className="min-w-0 flex-1 truncate text-sm text-app-primary">{pipeline.name}</span>
              <span className="text-[10px] capitalize text-app-muted">{pipeline.status}</span>
            </button>
          )) : (
            <EmptyRow icon={<Clock3 size={17} />} text="No workflow runs" detail="Your next run will appear here." />
          )}
        </div>
      </section>

      <section className="app-panel mt-4 overflow-hidden">
        <PanelHeader title="Recent work" action="Open history" onClick={() => setActiveView('tasks')} />
        {recentTasks.length > 0 ? recentTasks.map(task => (
          <button key={task.id} type="button" onClick={() => openTaskRun(task.id)} className="app-focus flex w-full items-center gap-3 border-t border-border px-4 py-3 text-left transition hover:bg-surface-hover">
            <StatusDot status={task.status} />
            <span className="min-w-0 flex-1 truncate text-sm text-app-primary">{task.title}</span>
            <span className="text-[10px] capitalize text-app-muted">{task.status}</span>
            <ChevronRight size={14} className="text-app-muted" />
          </button>
        )) : <EmptyRow icon={<Clock3 size={17} />} text="No history yet" detail="Completed and failed work will appear here." />}
      </section>

      {showLauncher && (
        <WorkLauncher
          initialInput={input}
          initialMode={launcherMode}
          initialTeamId={launcherTeamId}
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

function Metric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-surface/55 px-4 py-3.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent-light">{icon}</span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2"><span className="text-lg font-semibold tabular-nums text-app-primary">{value}</span><span className="text-[11px] text-app-secondary">{label}</span></div>
        <div className="mt-0.5 truncate text-[10px] text-app-muted">{detail}</div>
      </div>
    </div>
  );
}

function PanelHeader({ title, action, onClick }: { title: string; action: string; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-app-secondary">{title}</h2>
      <button type="button" onClick={onClick} className="app-focus inline-flex items-center gap-1 text-[11px] text-app-muted transition hover:text-app-primary">{action}<ArrowUpRight size={13} /></button>
    </div>
  );
}

function EmptyRow({ icon, text, detail }: { icon: ReactNode; text: string; detail: string }) {
  return <div className="flex items-center gap-3 border-t border-border px-4 py-8 text-left"><span className="text-app-muted">{icon}</span><div><div className="text-sm text-app-secondary">{text}</div><div className="mt-1 text-[11px] text-app-muted">{detail}</div></div><Check size={15} className="ml-auto text-emerald-400/70" /></div>;
}
