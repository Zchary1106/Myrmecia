import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronRight, CircleDot, Clock3, GitBranch, Inbox, Layers3, Plus, Sparkles, Users } from 'lucide-react';
import { api, type TeamDTO } from '../../lib/api';
import { useStore } from '../../stores/store';
import { cn } from '../../lib/utils';
import { WorkLauncher, type LaunchMode } from '../common/WorkLauncher';

const starterPrompts = [
  { label: 'Fix a GitHub issue', text: 'Inspect this GitHub issue, reproduce the problem, and prepare a focused fix.' },
  { label: 'Create social content', text: 'Turn this repository into a Xiaohongshu post, Douyin video brief, and WeChat article.' },
  { label: 'Review a codebase', text: 'Review the current project for high-impact bugs, missing tests, and release risks.' },
];

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
  const { agents, tasks, pipelines, templates, inboxEntries, health, setActiveView, setSelectedTaskId } = useStore();
  const [input, setInput] = useState('');
  const [showLauncher, setShowLauncher] = useState(false);
  const [launcherMode, setLauncherMode] = useState<LaunchMode>('direct');
  const [launcherTeamId, setLauncherTeamId] = useState('');
  const [launcherTemplateId, setLauncherTemplateId] = useState('');
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);

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
    api.teams.list().then(setTeams).catch(() => {});
  }, []);

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

        <form onSubmit={submit} className="app-panel mt-9 p-2 text-left transition focus-within:border-accent/60 focus-within:shadow-[0_20px_70px_rgb(86_145_255_/_0.12)]">
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
              <span className="hidden text-app-muted/60 sm:inline">⌘ Enter to run</span>
            </div>
            <button type="submit" disabled={!input.trim()} className="app-focus inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-white transition hover:-translate-y-px hover:bg-accent-light active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40">
              Start work <ArrowUpRight size={14} />
            </button>
          </div>
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
        <WorkLauncher initialInput={input} initialMode={launcherMode} initialTeamId={launcherTeamId} initialTemplateId={launcherTemplateId} onClose={() => setShowLauncher(false)} />
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
