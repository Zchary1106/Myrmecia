import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ExternalAgent, ExternalAgentSchedule } from '@myrmecia/shared';
import { Activity, CalendarClock, CheckCircle2, CircleAlert, Clock3, Globe2, Pencil, Play, Plus, RefreshCw, TerminalSquare, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

type View = 'connected' | 'schedules' | 'history';

const cliProfiles = [
  ['codex', 'Codex CLI'],
  ['claude_code', 'Claude Code'],
  ['gemini_cli', 'Gemini CLI'],
  ['opencode', 'OpenCode'],
] as const;

function statusTone(status: string) {
  if (status === 'active' || status === 'healthy' || status === 'succeeded') return 'bg-emerald-500/10 text-emerald-600';
  if (status === 'running' || status === 'queued' || status === 'waiting_for_callback') return 'bg-blue-500/10 text-blue-600';
  if (status === 'degraded' || status === 'timed_out') return 'bg-amber-500/10 text-amber-600';
  if (status === 'failed' || status === 'unreachable') return 'bg-red-500/10 text-red-600';
  return 'bg-app-subtle text-app-muted';
}

function dateTime(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

function adapterLabel(agent: ExternalAgent) {
  if (agent.adapter.kind === 'local_cli') {
    const adapter = agent.adapter as Extract<ExternalAgent['adapter'], { kind: 'local_cli' }>;
    return cliProfiles.find(item => item[0] === adapter.profile)?.[1] || adapter.profile;
  }
  return agent.adapter.endpoint;
}

export function ExternalAgentsPanel({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>('connected');
  const [agents, setAgents] = useState<ExternalAgent[]>([]);
  const [schedules, setSchedules] = useState<ExternalAgentSchedule[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof api.externalAgents.runs>>>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [agentKind, setAgentKind] = useState<'local_cli' | 'http'>('local_cli');
  const [agentName, setAgentName] = useState('');
  const [agentDescription, setAgentDescription] = useState('');
  const [cliProfile, setCliProfile] = useState<ExternalAgent['adapter'] extends infer A ? A extends { kind: 'local_cli'; profile: infer P } ? P : never : never>('codex');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [credentialKey, setCredentialKey] = useState('');
  const [runObjective, setRunObjective] = useState('');
  const [runWorkdir, setRunWorkdir] = useState('');
  const [scheduleAgentId, setScheduleAgentId] = useState('');
  const [scheduleTrigger, setScheduleTrigger] = useState<'cron' | 'once' | 'task_event'>('cron');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [runAt, setRunAt] = useState('');
  const [taskEventType, setTaskEventType] = useState('task:done');
  const [scheduleObjective, setScheduleObjective] = useState('');

  const selected = useMemo(() => agents.find(agent => agent.id === selectedId) || agents[0], [agents, selectedId]);

  const refresh = async () => {
    try {
      setError('');
      const [nextAgents, nextSchedules] = await Promise.all([api.externalAgents.list(), api.externalAgentSchedules.list()]);
      setAgents(nextAgents);
      setSchedules(nextSchedules);
      setSelectedId(current => current || nextAgents[0]?.id || '');
      setScheduleAgentId(current => current || nextAgents[0]?.id || '');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load external Agents.');
    }
  };

  const refreshRuns = async (agentId?: string) => {
    if (!agentId) return setRuns([]);
    try {
      setRuns(await api.externalAgents.runs(agentId, 30));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load Agent runs.');
    }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { void refreshRuns(selected?.id); }, [selected?.id]);

  const resetAgentForm = () => {
    setEditingAgentId('');
    setAgentKind('local_cli');
    setAgentName('');
    setAgentDescription('');
    setCliProfile('codex');
    setWorkspaceRoot('');
    setEndpoint('');
    setCredentialKey('');
  };

  const editAgent = (agent: ExternalAgent) => {
    setEditingAgentId(agent.id);
    setAgentName(agent.name);
    setAgentDescription(agent.description || '');
    if (agent.adapter.kind === 'local_cli') {
      setAgentKind('local_cli');
      setCliProfile(agent.adapter.profile);
      setWorkspaceRoot(agent.adapter.allowedWorkspaceRoots?.[0] || '');
      setEndpoint('');
      setCredentialKey('');
    } else {
      setAgentKind('http');
      setEndpoint(agent.adapter.endpoint);
      setCredentialKey(agent.adapter.credentialRef?.key || '');
      setWorkspaceRoot('');
    }
    setShowCreate(true);
  };

  const createAgent = async () => {
    if (!agentName.trim()) return;
    const editing = Boolean(editingAgentId);
    setBusy(editing ? 'update' : 'create');
    try {
      const adapter: ExternalAgent['adapter'] = agentKind === 'local_cli'
        ? { kind: 'local_cli', profile: cliProfile as any, allowedWorkspaceRoots: workspaceRoot.trim() ? [workspaceRoot.trim()] : [] }
        : {
            kind: 'http',
            endpoint: endpoint.trim(),
            allowedHosts: endpoint.trim() ? [new URL(endpoint.trim()).hostname] : [],
            ...(credentialKey.trim() ? { credentialRef: { provider: 'env', key: credentialKey.trim() } } : {}),
          };
      const saved = editing
        ? await api.externalAgents.update(editingAgentId, { name: agentName.trim(), description: agentDescription.trim(), adapter })
        : await api.externalAgents.create({ name: agentName.trim(), description: agentDescription.trim(), adapter });
      resetAgentForm();
      setShowCreate(false);
      setSelectedId(saved.id);
      setNotice(editing ? `${saved.name} updated.` : `${saved.name} connected.`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : editing ? 'Unable to update external Agent.' : 'Unable to connect external Agent.');
    } finally {
      setBusy('');
    }
  };

  const runNow = async () => {
    if (!selected || !runObjective.trim()) return;
    setBusy('run');
    try {
      const run = await api.externalAgents.run(selected.id, {
        objective: runObjective.trim(),
        constraints: [],
        ...(runWorkdir.trim() ? { workdir: runWorkdir.trim() } : {}),
      });
      setNotice(run.status === 'succeeded' ? 'Agent run completed.' : `Agent run finished: ${run.status}.`);
      setRunObjective('');
      await refreshRuns(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to run external Agent.');
    } finally {
      setBusy('');
    }
  };

  const checkHealth = async (agent: ExternalAgent) => {
    setBusy(`health:${agent.id}`);
    try {
      const health = await api.externalAgents.health(agent.id);
      setNotice(`${agent.name}: ${health.status}${health.detail ? ` · ${health.detail}` : ''}`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Health check failed.');
    } finally {
      setBusy('');
    }
  };

  const disconnectAgent = async (agent: ExternalAgent) => {
    if (!window.confirm(`Disconnect ${agent.name}? Its schedules and run history will also be removed.`)) return;
    setBusy(`remove:${agent.id}`);
    try {
      await api.externalAgents.remove(agent.id);
      setSelectedId(current => current === agent.id ? '' : current);
      setScheduleAgentId(current => current === agent.id ? '' : current);
      setNotice(`${agent.name} disconnected.`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to disconnect external Agent.');
    } finally {
      setBusy('');
    }
  };

  const createSchedule = async () => {
    if (!scheduleAgentId || !scheduleObjective.trim()) return;
    setBusy('schedule');
    try {
      const common = {
        externalAgentId: scheduleAgentId,
        invocation: { objective: scheduleObjective.trim(), constraints: [] },
      };
      if (scheduleTrigger === 'cron') {
        await api.externalAgentSchedules.create({
          ...common,
          triggerType: 'cron',
          cron: cron.trim(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        });
      } else if (scheduleTrigger === 'once') {
        const scheduledAt = new Date(runAt);
        if (!Number.isFinite(scheduledAt.getTime())) throw new Error('Choose a valid future date and time.');
        await api.externalAgentSchedules.create({
          ...common,
          triggerType: 'once',
          runAt: scheduledAt.toISOString(),
        });
      } else {
        await api.externalAgentSchedules.create({
          ...common,
          triggerType: 'task_event',
          eventType: taskEventType,
        });
      }
      setScheduleObjective('');
      setRunAt('');
      setShowSchedule(false);
      setNotice(
        scheduleTrigger === 'cron'
          ? 'Recurring schedule created.'
          : scheduleTrigger === 'once'
            ? 'One-time run scheduled.'
            : 'Task event automation created.',
      );
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to create schedule.');
    } finally {
      setBusy('');
    }
  };

  const toggleSchedule = async (schedule: ExternalAgentSchedule) => {
    setBusy(`schedule:${schedule.id}`);
    try {
      await api.externalAgentSchedules.update(schedule.id, { enabled: !schedule.enabled });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update schedule.');
    } finally {
      setBusy('');
    }
  };

  const removeSchedule = async (schedule: ExternalAgentSchedule) => {
    if (!window.confirm(`Delete this ${schedule.triggerType.replace('_', ' ')} automation? This cannot be undone.`)) return;
    setBusy(`schedule:remove:${schedule.id}`);
    try {
      await api.externalAgentSchedules.remove(schedule.id);
      setNotice('Automation deleted.');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to delete automation.');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="rounded-2xl border border-indigo-100 bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,.12),transparent_38%),var(--app-panel)] p-5 shadow-[0_20px_50px_-42px_rgba(79,70,229,.75)]">
      <div className="flex flex-col gap-4 border-b border-app pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[.16em] text-indigo-600">Agent control plane</div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-app-primary">External Agents</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-app-muted">Connect governed CLI and HTTP Agents, run them in a workspace, and schedule repeatable work.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void refresh()} className="inline-flex h-9 items-center gap-2 rounded-xl border border-app bg-app-panel px-3 text-xs font-semibold text-app-secondary hover:bg-app-hover"><RefreshCw size={14} /> Refresh</button>
          <button type="button" onClick={() => setShowSchedule(true)} disabled={!agents.length} className="inline-flex h-9 items-center gap-2 rounded-xl border border-app bg-app-panel px-3 text-xs font-semibold text-app-secondary hover:bg-app-hover disabled:opacity-40"><CalendarClock size={14} /> Schedule</button>
          <button type="button" onClick={() => { resetAgentForm(); setShowCreate(true); }} className="inline-flex h-9 items-center gap-2 rounded-xl bg-indigo-600 px-3 text-xs font-semibold text-white hover:bg-indigo-700"><Plus size={14} /> Connect Agent</button>
          <button type="button" onClick={onClose} aria-label="Close external Agents" className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-app-muted hover:bg-app-hover"><X size={16} /></button>
        </div>
      </div>

      {(error || notice) && <div className={cn('mt-4 rounded-xl border px-3 py-2 text-xs', error ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700')}>{error || notice}</div>}

      <div className="mt-5 flex gap-5 border-b border-app">
        {([['connected', 'Connected Agents', agents.length], ['schedules', 'Schedules', schedules.length], ['history', 'Run History', runs.length]] as const).map(([id, label, count]) => <button key={id} type="button" onClick={() => setView(id)} className={cn('border-b-2 px-1 pb-3 text-xs font-semibold transition', view === id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-app-muted hover:text-app-primary')}>{label}<span className="ml-1.5 rounded-full bg-app-subtle px-1.5 py-0.5 text-[9px]">{count}</span></button>)}
      </div>

      {view === 'connected' && <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(19rem,.7fr)]">
        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map(agent => <article key={agent.id} className={cn('rounded-xl border p-4 transition', selected?.id === agent.id ? 'border-indigo-300 bg-indigo-50/40' : 'border-app bg-app-panel hover:border-indigo-200')}><button type="button" onClick={() => setSelectedId(agent.id)} className="w-full text-left"><div className="flex items-start justify-between gap-3"><span className={cn('rounded-lg p-2', agent.adapter.kind === 'local_cli' ? 'bg-slate-100 text-slate-700' : 'bg-sky-50 text-sky-700')}>{agent.adapter.kind === 'local_cli' ? <TerminalSquare size={17} /> : <Globe2 size={17} />}</span><span className={cn('rounded-full px-2 py-1 text-[10px] font-semibold capitalize', statusTone(agent.lastHealthStatus || agent.status))}>{agent.lastHealthStatus || agent.status}</span></div><h3 className="mt-3 truncate text-sm font-semibold text-app-primary">{agent.name}</h3><p className="mt-1 line-clamp-2 min-h-9 text-xs leading-5 text-app-muted">{agent.description || adapterLabel(agent)}</p></button><div className="mt-4 grid grid-cols-[1fr_1fr_auto_auto] gap-2"><button type="button" onClick={() => void checkHealth(agent)} disabled={Boolean(busy)} className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-app text-[11px] font-semibold text-app-secondary hover:bg-app-hover disabled:opacity-40"><Activity size={13} /> Test</button><button type="button" onClick={() => setSelectedId(agent.id)} className="inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-indigo-600 text-[11px] font-semibold text-white hover:bg-indigo-700"><Play size={13} /> Run</button><button type="button" onClick={() => editAgent(agent)} disabled={Boolean(busy)} aria-label={`Edit ${agent.name}`} title="Edit Agent" className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-app text-app-secondary hover:bg-app-hover disabled:opacity-40"><Pencil size={13} /></button><button type="button" onClick={() => void disconnectAgent(agent)} disabled={Boolean(busy)} aria-label={`Disconnect ${agent.name}`} title="Disconnect Agent" className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40"><Trash2 size={13} /></button></div></article>)}
          {!agents.length && <div className="col-span-full rounded-xl border border-dashed border-app px-5 py-12 text-center"><TerminalSquare size={26} className="mx-auto text-app-faint" /><h3 className="mt-3 text-sm font-semibold text-app-primary">No external Agents connected</h3><p className="mt-1 text-xs text-app-muted">Connect a governed CLI or HTTPS Agent to run repeatable work.</p></div>}
        </div>
        <aside className="rounded-xl border border-app bg-app-panel p-4">
          <div className="flex items-center gap-2"><Play size={15} className="text-indigo-600" /><h3 className="text-sm font-semibold text-app-primary">Run now</h3></div>
          <p className="mt-1 text-xs leading-5 text-app-muted">{selected ? `Run ${selected.name} with the current workspace policy.` : 'Select an Agent first.'}</p>
          <label className="mt-4 block text-xs font-medium text-app-secondary">Objective<textarea value={runObjective} onChange={event => setRunObjective(event.target.value)} rows={4} disabled={!selected} placeholder="Describe the outcome you need…" className="field mt-1.5 w-full resize-y text-sm" /></label>
          {selected?.adapter.kind === 'local_cli' && <label className="mt-3 block text-xs font-medium text-app-secondary">Workspace path<input value={runWorkdir} onChange={event => setRunWorkdir(event.target.value)} placeholder="Must be inside an allowed workspace root" className="field mt-1.5 w-full text-sm" /></label>}
          <button type="button" onClick={() => void runNow()} disabled={!selected || !runObjective.trim() || Boolean(busy)} className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"><Play size={15} /> {busy === 'run' ? 'Running…' : 'Run Agent now'}</button>
        </aside>
      </div>}

      {view === 'schedules' && <div className="mt-4 overflow-hidden rounded-xl border border-app bg-app-panel"><div className="grid grid-cols-[minmax(11rem,1fr)_8rem_10rem_10rem] gap-3 border-b border-app bg-app-subtle px-4 py-3 text-[10px] font-semibold uppercase tracking-[.08em] text-app-muted"><span>Agent and objective</span><span>Trigger</span><span>Next run</span><span /></div>{schedules.map(schedule => <div key={schedule.id} className="grid grid-cols-[minmax(11rem,1fr)_8rem_10rem_10rem] items-center gap-3 border-b border-app px-4 py-3 text-xs last:border-b-0"><div className="min-w-0"><div className="truncate font-semibold text-app-primary">{agents.find(agent => agent.id === schedule.externalAgentId)?.name || 'Unavailable Agent'}</div><div className="mt-1 truncate text-app-muted">{schedule.invocation.objective}</div></div><span className="capitalize text-app-secondary">{schedule.triggerType}</span><span className="text-app-muted">{dateTime(schedule.nextRunAt)}</span><div className="flex justify-self-end gap-2"><button type="button" onClick={() => void toggleSchedule(schedule)} disabled={Boolean(busy)} className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-40', schedule.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-app-subtle text-app-muted')}>{schedule.enabled ? 'Pause' : 'Enable'}</button><button type="button" onClick={() => void removeSchedule(schedule)} disabled={Boolean(busy)} aria-label={`Delete automation ${schedule.invocation.objective}`} title="Delete automation" className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40"><Trash2 size={13} /></button></div></div>)}{!schedules.length && <div className="px-5 py-12 text-center text-xs text-app-muted">No schedules yet. Use Schedule to run an external Agent automatically.</div>}</div>}

      {view === 'history' && <div className="mt-4 overflow-hidden rounded-xl border border-app bg-app-panel"><div className="grid grid-cols-[9rem_minmax(12rem,1fr)_8rem_10rem] gap-3 border-b border-app bg-app-subtle px-4 py-3 text-[10px] font-semibold uppercase tracking-[.08em] text-app-muted"><span>Status</span><span>Objective</span><span>Trigger</span><span>Started</span></div>{runs.map(run => <div key={run.id} className="grid grid-cols-[9rem_minmax(12rem,1fr)_8rem_10rem] gap-3 border-b border-app px-4 py-3 text-xs last:border-b-0"><span className={cn('w-fit rounded-full px-2 py-1 text-[10px] font-semibold', statusTone(run.status))}>{run.status}</span><div className="min-w-0"><div className="truncate font-medium text-app-primary">{run.invocation.objective}</div>{run.error && <div className="mt-1 truncate text-red-600">{run.error}</div>}</div><span className="capitalize text-app-muted">{run.triggerType}</span><span className="text-app-muted">{dateTime(run.startedAt || run.createdAt)}</span></div>)}{!runs.length && <div className="px-5 py-12 text-center text-xs text-app-muted">Select a connected Agent and run it to build history.</div>}</div>}

      {showCreate && <Dialog title={editingAgentId ? 'Edit external Agent' : 'Connect external Agent'} onClose={() => { resetAgentForm(); setShowCreate(false); }}><div className="grid gap-4"><label className="text-xs font-medium text-app-secondary">Name<input value={agentName} onChange={event => setAgentName(event.target.value)} autoFocus placeholder="Codex engineering agent" className="field mt-1.5 w-full text-sm" /></label><label className="text-xs font-medium text-app-secondary">Connection type<select value={agentKind} onChange={event => setAgentKind(event.target.value as 'local_cli' | 'http')} className="field mt-1.5 w-full text-sm"><option value="local_cli">Local CLI</option><option value="http">HTTPS Agent API</option></select></label>{agentKind === 'local_cli' ? <><label className="text-xs font-medium text-app-secondary">CLI profile<select value={cliProfile} onChange={event => setCliProfile(event.target.value as typeof cliProfile)} className="field mt-1.5 w-full text-sm">{cliProfiles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="text-xs font-medium text-app-secondary">Allowed workspace root<input value={workspaceRoot} onChange={event => setWorkspaceRoot(event.target.value)} placeholder="/Users/you/Projects" className="field mt-1.5 w-full text-sm" /></label></> : <><label className="text-xs font-medium text-app-secondary">HTTPS endpoint<input value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://agent.example.com/run" className="field mt-1.5 w-full text-sm" /></label><label className="text-xs font-medium text-app-secondary">Secret reference key <span className="font-normal text-app-muted">(optional)</span><input value={credentialKey} onChange={event => setCredentialKey(event.target.value)} placeholder="MY_EXTERNAL_AGENT_TOKEN" className="field mt-1.5 w-full text-sm" /></label></>}<label className="text-xs font-medium text-app-secondary">Description <span className="font-normal text-app-muted">(optional)</span><textarea value={agentDescription} onChange={event => setAgentDescription(event.target.value)} rows={3} className="field mt-1.5 w-full resize-y text-sm" /></label><button type="button" onClick={() => void createAgent()} disabled={!agentName.trim() || Boolean(busy)} className="inline-flex h-10 items-center justify-center rounded-xl bg-indigo-600 text-sm font-semibold text-white disabled:opacity-40">{busy === 'create' ? 'Connecting…' : busy === 'update' ? 'Saving…' : editingAgentId ? 'Save Agent' : 'Connect Agent'}</button></div></Dialog>}
      {showSchedule && (
        <Dialog title="Schedule external Agent" onClose={() => setShowSchedule(false)}>
          <div className="grid gap-4">
            <label className="text-xs font-medium text-app-secondary">
              Agent
              <select value={scheduleAgentId} onChange={event => setScheduleAgentId(event.target.value)} className="field mt-1.5 w-full text-sm">
                {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-app-secondary">
              When to run
              <select aria-label="Schedule trigger" value={scheduleTrigger} onChange={event => setScheduleTrigger(event.target.value as 'cron' | 'once' | 'task_event')} className="field mt-1.5 w-full text-sm">
                <option value="cron">Repeat on a schedule</option>
                <option value="once">Run once at a specific time</option>
                <option value="task_event">Run after a task event</option>
              </select>
            </label>
            {scheduleTrigger === 'cron' ? (
              <>
                <label className="text-xs font-medium text-app-secondary">
                  Cron expression
                  <input value={cron} onChange={event => setCron(event.target.value)} className="field mt-1.5 w-full text-sm" />
                </label>
                <p className="-mt-2 text-[11px] text-app-muted">Example: <code>0 9 * * 1-5</code> runs weekdays at 09:00 in your current timezone.</p>
              </>
            ) : scheduleTrigger === 'once' ? (
              <label className="text-xs font-medium text-app-secondary">
                Date and time
                <input type="datetime-local" value={runAt} onChange={event => setRunAt(event.target.value)} className="field mt-1.5 w-full text-sm" />
              </label>
            ) : (
              <>
                <label className="text-xs font-medium text-app-secondary">
                  Task event
                  <select aria-label="Task event type" value={taskEventType} onChange={event => setTaskEventType(event.target.value)} className="field mt-1.5 w-full text-sm">
                    <option value="task:started">Task starts</option>
                    <option value="task:done">Task completes</option>
                    <option value="task:failed">Task fails</option>
                    <option value="task:cancelled">Task is cancelled</option>
                  </select>
                </label>
                <p className="-mt-2 text-[11px] text-app-muted">The Agent receives the source task ID and workspace context after this event occurs.</p>
              </>
            )}
            <label className="text-xs font-medium text-app-secondary">
              Objective
              <textarea value={scheduleObjective} onChange={event => setScheduleObjective(event.target.value)} rows={4} placeholder="What should this Agent do on every run?" className="field mt-1.5 w-full resize-y text-sm" />
            </label>
            <button
              type="button"
              onClick={() => void createSchedule()}
              disabled={!scheduleObjective.trim() || (scheduleTrigger === 'cron' ? !cron.trim() : scheduleTrigger === 'once' ? !runAt : !taskEventType) || Boolean(busy)}
              className="inline-flex h-10 items-center justify-center rounded-xl bg-indigo-600 text-sm font-semibold text-white disabled:opacity-40"
            >
              {busy === 'schedule'
                ? 'Creating…'
                : scheduleTrigger === 'cron'
                  ? 'Create recurring schedule'
                  : scheduleTrigger === 'once'
                    ? 'Schedule one-time run'
                    : 'Create task event automation'}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg rounded-2xl border border-app bg-app-panel p-6 shadow-2xl"><div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-semibold text-app-primary">{title}</h2><button type="button" onClick={onClose} aria-label={`Close ${title}`} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-app-muted hover:bg-app-hover"><X size={16} /></button></div>{children}</section></div>;
}
