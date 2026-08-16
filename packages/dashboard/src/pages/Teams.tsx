import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type TeamDTO, type TeamRunDTO, type TeamBoardItem, type TeamInputDTO, type TeamRoleSlotDTO, type TeamPreflightResultDTO } from '../lib/api';
import { wsClient } from '../lib/ws';
import { useStore } from '../stores/store';
import { cn } from '../lib/utils';
import type { GitHubConnectionStatus, GitHubFixDiff, GitHubFixRun } from '@myrmecia/shared';

const statusStyle: Record<string, string> = {
  done: 'border-emerald-500/70 bg-emerald-500/5',
  completed: 'border-emerald-500/70 bg-emerald-500/5',
  failed: 'border-red-500/70 bg-red-500/5',
  running: 'border-blue-500 ring-2 ring-blue-500/30 animate-pulse bg-blue-500/5',
  assigned: 'border-cyan-500/70 bg-cyan-500/5',
  pending: 'border-gray-500/40',
  queued: 'border-gray-600/40 opacity-70',
  cancelled: 'border-yellow-500/40 opacity-60',
};
const statusIcon: Record<string, string> = {
  done: '✓', completed: '✓', failed: '✗', running: '▸', assigned: '◆', pending: '·', queued: '⋯', cancelled: '⊘',
};
const dot: Record<TeamRunDTO['status'], string> = {
  planning: 'bg-yellow-400', running: 'bg-blue-400 animate-pulse', done: 'bg-emerald-400', failed: 'bg-red-400',
};

export function TeamsPage() {
  const { agents, loadAgents, setCanvasTeamId, setActiveView } = useStore();
  const [source, setSource] = useState<'workspace' | 'github'>('workspace');
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [workspaceIsGit, setWorkspaceIsGit] = useState(false);
  const [githubConnection, setGitHubConnection] = useState<GitHubConnectionStatus | null>(null);
  const [githubRuns, setGitHubRuns] = useState<GitHubFixRun[]>([]);
  const [repository, setRepository] = useState('');
  const [issue, setIssue] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [githubDiff, setGitHubDiff] = useState<GitHubFixDiff | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [creatingPr, setCreatingPr] = useState(false);
  const [runs, setRuns] = useState<TeamRunDTO[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [run, setRun] = useState<TeamRunDTO | null>(null);
  const [board, setBoard] = useState<TeamBoardItem[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [redirect, setRedirect] = useState(false);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<TeamDTO | 'new' | null>(null);
  const [copying, setCopying] = useState<TeamDTO | null>(null);
  const activeRunRef = useRef<string | null>(null);
  activeRunRef.current = activeRunId;

  const team = useMemo(() => teams.find(t => t.id === picked) || null, [teams, picked]);
  const roles = useMemo(() => [...new Set(agents.map(a => a.role))].sort(), [agents]);

  const reloadTeams = () => api.teams.list().then(setTeams).catch(e => setError(e.message));

  useEffect(() => {
    if (!agents.length) loadAgents();
    api.teams.list().then(ts => {
      setTeams(ts);
      if (ts.length && !picked) setPicked(ts.find(team => team.id === 'bugfix')?.id || ts[0].id);
    }).catch(e => setError(e.message));
    api.teams.runs().then(setRuns).catch(() => {});
    void window.myrmeciaDesktopIntegrations?.getWorkspace().then(workspace => {
      setWorkspacePath(workspace.path);
      setWorkspaceIsGit(workspace.isGitRepository);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const refreshGitHub = () => Promise.all([
      api.githubFixes.status(),
      api.githubFixes.list(),
    ]).then(([connection, nextRuns]) => {
      setGitHubConnection(connection);
      setGitHubRuns(nextRuns);
    }).catch(() => {});
    void refreshGitHub();
    const timer = window.setInterval(refreshGitHub, 5000);
    return () => clearInterval(timer);
  }, []);

  // Live updates: refetch the active run's board on WS team/task events
  // (debounced), with a slow safety poll as a fallback.
  useEffect(() => {
    if (!activeRunId) return;
    let stop = false;
    let timer: number | null = null;
    const refetch = async () => {
      try {
        const { run, board } = await api.teams.run(activeRunId);
        if (!stop) { setRun(run); setBoard(board); }
      } catch { /* ignore */ }
    };
    const schedule = () => {
      if (timer) return;
      timer = window.setTimeout(() => { timer = null; refetch(); }, 350);
    };

    refetch();
    wsClient.connect();
    wsClient.subscribe('teams');
    wsClient.subscribe('tasks');
    const onEvent = () => schedule();
    wsClient.on('*', onEvent);

    // Safety net in case some events are missed.
    const iv = window.setInterval(() => {
      if (run && ['done', 'failed'].includes(run.status)) return;
      refetch();
    }, 8000);

    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      clearInterval(iv);
      wsClient.off('*', onEvent);
    };
  }, [activeRunId, run?.status]);

  // Refresh the runs list on team events (+ a slow fallback).
  useEffect(() => {
    const refresh = () => api.teams.runs().then(setRuns).catch(() => {});
    wsClient.connect();
    wsClient.subscribe('teams');
    const onTeam = () => refresh();
    wsClient.on('team:run_created', onTeam);
    wsClient.on('team:run_done', onTeam);
    const iv = window.setInterval(refresh, 10000);
    return () => { wsClient.off('team:run_created', onTeam); wsClient.off('team:run_done', onTeam); clearInterval(iv); };
  }, []);

  const activeGitHubRun = useMemo(
    () => githubRuns.find(item => item.teamRunId === activeRunId) || null,
    [githubRuns, activeRunId],
  );

  useEffect(() => {
    if (!activeGitHubRun) {
      setGitHubDiff(null);
      setShowDiff(false);
      setConfirmPhrase('');
      return;
    }
    if (activeGitHubRun.status !== 'preparing') {
      api.githubFixes.diff(activeGitHubRun.id).then(setGitHubDiff).catch(() => {});
    }
  }, [activeGitHubRun?.id, activeGitHubRun?.status]);

  const dispatch = async () => {
    const description = goal.trim();
    if (!team) return;
    if (source === 'workspace' && !description) return;
    if (source === 'github' && (!repository.trim() || (!issue.trim() && !description))) return;
    setBusy(true); setError('');
    try {
      const run = source === 'github'
        ? await api.githubFixes.create({
          repository: repository.trim(),
          issue: issue.trim() || undefined,
          bugDescription: description || undefined,
          baseBranch: baseBranch.trim() || undefined,
          teamId: team.id,
        }).then(githubRun => {
          setGitHubRuns(current => [githubRun, ...current.filter(item => item.id !== githubRun.id)]);
          if (!githubRun.teamRunId) throw new Error('The repository workspace was created without a team run');
          return api.teams.run(githubRun.teamRunId).then(result => result.run);
        })
        : await api.teams.dispatch(team.id, description, workspacePath.trim()).then(result => result.run);
      setGoal('');
      setActiveRunId(run.id);
      setRun(run);
      setBoard([]);
      api.teams.runs().then(setRuns).catch(() => {});
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const refreshDiff = async () => {
    if (!activeGitHubRun) return;
    try {
      setGitHubDiff(await api.githubFixes.diff(activeGitHubRun.id));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const createPullRequest = async () => {
    if (!activeGitHubRun || confirmPhrase !== 'CREATE PR') return;
    setCreatingPr(true); setError('');
    try {
      const updated = await api.githubFixes.createPullRequest(activeGitHubRun.id, {
        confirm: true,
        title: activeGitHubRun.issueTitle ? `fix: ${activeGitHubRun.issueTitle}` : undefined,
      });
      setGitHubRuns(current => current.map(item => item.id === updated.id ? updated : item));
      setConfirmPhrase('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreatingPr(false);
    }
  };

  const sendMessage = async () => {
    if (!activeRunId || !selectedTask || !message.trim()) return;
    const item = board.find(b => b.taskId === selectedTask);
    const to = item?.assigneeId || selectedTask;
    try {
      const r = await api.teams.message(activeRunId, { to, content: message.trim(), redirect });
      const live = r.delivered.filter(d => d.live).length;
      const queued = r.delivered.length - live;
      const red = r.redirected.length;
      const parts = [live && `${live} live`, queued && `${queued} queued`, red && `${red} redirected`].filter(Boolean);
      setToast(`✉ to ${to}: ${parts.join(' · ') || 'no live teammate'}`);
      setMessage('');
      setTimeout(() => setToast(''), 3500);
    } catch (e: any) { setError(e.message); }
  };

  const activeCount = board.filter(b => ['running', 'assigned'].includes(b.status.toLowerCase())).length;
  const doneCount = board.filter(b => ['done', 'failed'].includes(b.status.toLowerCase())).length;
  const selected = board.find(b => b.taskId === selectedTask) || null;
  const selectTeam = (teamId: string) => {
    setPicked(teamId);
    setActiveRunId(null);
    setRun(null);
    setBoard([]);
    setSelectedTask(null);
    setShowDiff(false);
    setGitHubDiff(null);
  };

  const selectRun = (nextRun: TeamRunDTO) => {
    setPicked(nextRun.teamId);
    setActiveRunId(nextRun.id);
    setRun(nextRun);
    setBoard([]);
    setSelectedTask(null);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto p-3 sm:p-4 xl:overflow-hidden">
      <div className="mx-auto flex min-h-full w-full max-w-[1680px] flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Agent Teams</h1>
          <p className="max-w-3xl text-[12px] leading-relaxed text-gray-500">Choose a squad to preview its roster and workflow. Dispatch work to open a live, shared execution board.</p>
        </div>
        {toast && <div className="text-[12px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-1.5">{toast}</div>}
      </div>

      {error && <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
        {/* Left: team picker + dispatch + recent runs */}
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Squads</span>
            <button onClick={() => setEditing('new')}
              className="text-[11px] text-accent hover:text-accent-light flex items-center gap-1">+ New team</button>
          </div>
          <div className="grid max-h-[320px] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:max-h-none xl:flex-1 xl:grid-cols-1">
            {teams.map(t => (
              <div key={t.id}
                onClick={() => selectTeam(t.id)}
                className={cn('group min-w-0 w-full text-left rounded-xl border p-3 transition-colors cursor-pointer',
                  picked === t.id ? 'border-accent bg-accent/10' : 'border-border hover:border-gray-600 bg-surface')}>
                <div className="flex items-center gap-2">
                  <span className="text-lg">{t.emoji}</span>
                  <span className="font-medium text-gray-100 text-[13px]">{t.name}</span>
                  <span className="text-gray-600 text-[11px]">@{t.id}</span>
                  {t.builtin && <span className="text-[9px] text-gray-600 border border-border rounded px-1">built-in</span>}
                  <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                    <button title="Edit" onClick={e => { e.stopPropagation(); setEditing(t); }}
                      className="text-gray-500 hover:text-gray-200 text-[12px] px-1">✎</button>
                    {!t.builtin && (
                      <button title="Delete" onClick={async e => { e.stopPropagation(); if (confirm(`Delete team "${t.name}"?`)) { await api.teams.remove(t.id).catch(() => {}); reloadTeams(); } }}
                        className="text-gray-500 hover:text-red-400 text-[12px] px-1">🗑</button>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-gray-500 mt-1 leading-snug">{t.blurb}</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {(t.roster?.length ? t.roster.map(r => r.agentId) : t.members).map(m => (
                    <span key={m} className="text-[10px] text-cyan-300/90 bg-cyan-500/10 rounded px-1.5 py-0.5">{m}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="shrink-0 rounded-xl border border-dashed border-border bg-surface/60 p-3 text-[10px] leading-relaxed text-gray-600">
            Select a squad here, then use the Team Workbench on the right to brief and dispatch it.
          </div>
        </div>

        {/* Right: live shared board */}
        <div className="flex min-h-[430px] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface xl:min-h-0">
          {!activeRunId ? (
            <TeamPreview
              team={team}
              onCopy={team ? () => { setCopying(team); setEditing('new'); } : undefined}
              onOpenCanvas={team ? () => {
                setCanvasTeamId(team.id);
                setActiveView('orchestrate');
              } : undefined}
              launchPanel={(
                <TeamLaunchPanel
                  team={team}
                  source={source}
                  setSource={setSource}
                  githubConnection={githubConnection}
                  repository={repository}
                  setRepository={setRepository}
                  issue={issue}
                  setIssue={setIssue}
                  baseBranch={baseBranch}
                  setBaseBranch={setBaseBranch}
                  goal={goal}
                  setGoal={setGoal}
                  workspacePath={workspacePath}
                  setWorkspacePath={setWorkspacePath}
                  workspaceIsGit={workspaceIsGit}
                  setWorkspaceIsGit={setWorkspaceIsGit}
                  setError={setError}
                  busy={busy}
                  onDispatch={dispatch}
                />
              )}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-3 sm:px-4">
                <span className={cn('w-2 h-2 rounded-full', run ? dot[run.status] : 'bg-gray-500')} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-gray-200 truncate">{run?.goal}</div>
                  <div className="text-[11px] text-gray-500">{run?.status} · {activeCount} working · {doneCount}/{board.length} done</div>
                </div>
                {activeGitHubRun && (
                  <div className="max-w-full text-left sm:text-right">
                    <div className="truncate text-[10px] text-blue-300">{activeGitHubRun.repository}</div>
                    <div className="truncate text-[9px] text-gray-600">{activeGitHubRun.workBranch}</div>
                  </div>
                )}
                <button type="button" onClick={() => team && selectTeam(team.id)}
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[10px] text-gray-400 hover:text-white">
                  Team overview
                </button>
              </div>

              <div className="grid flex-1 auto-rows-min grid-cols-1 gap-2.5 overflow-y-auto p-3 md:grid-cols-2 2xl:grid-cols-3">
                {board.length === 0 && <div className="col-span-full text-gray-600 text-[12px] py-8 text-center">the lead is splitting the goal into parallel tasks…</div>}
                {board.map(b => {
                  const st = b.status.toLowerCase();
                  return (
                    <button key={b.taskId} onClick={() => setSelectedTask(b.taskId)}
                      className={cn('text-left rounded-lg border p-2.5 transition-all',
                        statusStyle[st] || 'border-border',
                        selectedTask === b.taskId && 'ring-2 ring-accent')}>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px]">{statusIcon[st] || '·'}</span>
                        <span className="text-[11px] font-medium text-cyan-300">{b.assigneeId || '?'}</span>
                        <span className="ml-auto text-[10px] text-gray-500">{st}</span>
                      </div>
                      <div className="text-[12px] text-gray-200 mt-1 leading-snug line-clamp-2">{b.title}</div>
                      {b.dependsOn.length > 0 && <div className="text-[10px] text-gray-600 mt-1">⟂ waits on {b.dependsOn.length}</div>}
                    </button>
                  );
                })}
              </div>

              {/* Teammate detail / message composer */}
              {selected && (
                <div className="border-t border-border p-3 space-y-2">
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="text-cyan-300 font-medium">{selected.assigneeId}</span>
                    <span className="text-gray-500">{selected.title}</span>
                    <span className="ml-auto text-[10px] text-gray-500">{selected.status}</span>
                  </div>
                  {selected.output && <div className="text-[11px] text-gray-500 bg-background rounded-lg p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">{selected.output.slice(0, 600)}</div>}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input value={message} onChange={e => setMessage(e.target.value)}
                      placeholder={`Message ${selected.assigneeId}…`}
                      onKeyDown={e => { if (e.key === 'Enter') sendMessage(); }}
                      className="flex-1 text-[12px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-accent" />
                    <label className="flex items-center gap-1 text-[11px] text-gray-500 select-none">
                      <input type="checkbox" checked={redirect} onChange={e => setRedirect(e.target.checked)} />
                      redirect
                    </label>
                    <button onClick={sendMessage} disabled={!message.trim()}
                      className="rounded-lg bg-accent/90 hover:bg-accent text-white text-[12px] px-3 py-1.5 disabled:opacity-40">Send</button>
                  </div>
                  <p className="text-[10px] text-gray-600">A running teammate gets it live; “redirect” spawns a follow-up task for a finished one.</p>
                </div>
              )}

              {run?.result && ['done', 'failed'].includes(run.status) && (
                <div className="border-t border-border p-3">
                  <div className="text-[11px] text-gray-500 mb-1">Result</div>
                  <div className="text-[11px] text-gray-400 bg-background rounded-lg p-2 max-h-40 overflow-y-auto whitespace-pre-wrap">{run.result.slice(0, 4000)}</div>
                </div>
              )}

              {activeGitHubRun && (
                <div className="border-t border-border bg-background/30 p-3 space-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-300">{activeGitHubRun.status}</span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-gray-500" title={activeGitHubRun.localPath}>{activeGitHubRun.localPath}</span>
                    <button type="button" onClick={() => { setShowDiff(value => !value); if (!showDiff) void refreshDiff(); }}
                      className="ml-auto rounded-lg border border-border px-2 py-1 text-[10px] text-gray-400 hover:text-white">
                      {showDiff ? 'Hide diff' : 'Review diff'}
                    </button>
                  </div>
                  {activeGitHubRun.issueUrl && (
                    <a href={activeGitHubRun.issueUrl} target="_blank" rel="noreferrer" className="block text-[10px] text-blue-300 hover:underline">
                      Issue #{activeGitHubRun.issueNumber}: {activeGitHubRun.issueTitle}
                    </a>
                  )}
                  {activeGitHubRun.error && <div className="text-[10px] text-red-300">{activeGitHubRun.error}</div>}
                  {showDiff && (
                    <div className="space-y-2">
                      {githubDiff?.stat && <pre className="max-h-20 overflow-auto rounded-lg border border-border bg-[#090b10] p-2 text-[10px] text-gray-400">{githubDiff.stat}</pre>}
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-[#090b10] p-2 font-mono text-[10px] leading-4 text-gray-300">
                        {githubDiff?.patch || githubDiff?.status || 'No changes yet.'}
                      </pre>
                    </div>
                  )}
                  {activeGitHubRun.status === 'ready' && githubDiff?.hasChanges && (
                    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 sm:flex-row sm:items-center">
                      <input value={confirmPhrase} onChange={e => setConfirmPhrase(e.target.value)}
                        placeholder="Type CREATE PR"
                        className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-[11px] text-gray-200 focus:border-amber-400 focus:outline-none" />
                      <button type="button" onClick={createPullRequest}
                        disabled={confirmPhrase !== 'CREATE PR' || creatingPr}
                        className="rounded-lg bg-amber-500/90 px-3 py-1.5 text-[11px] font-semibold text-black disabled:opacity-40">
                        {creatingPr ? 'Creating…' : 'Create PR'}
                      </button>
                    </div>
                  )}
                  {activeGitHubRun.prUrl && (
                    <a href={activeGitHubRun.prUrl} target="_blank" rel="noreferrer" className="inline-flex text-[10px] font-semibold text-purple-300 hover:underline">
                      Open pull request ↗
                    </a>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Recent runs strip */}
      {runs.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto pb-1">
          <span className="text-[11px] text-gray-600 shrink-0">Recent:</span>
          {runs.slice(0, 12).map(r => (
            <button key={r.id} onClick={() => selectRun(r)}
              className={cn('shrink-0 flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-colors',
                activeRunId === r.id ? 'border-accent bg-accent/10' : 'border-border hover:border-gray-600')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', dot[r.status])} />
              <span className="text-gray-400">{teams.find(t => t.id === r.teamId)?.emoji || '•'}</span>
              <span className="text-gray-300 max-w-[160px] truncate">{r.goal}</span>
            </button>
          ))}
        </div>
      )}

      {editing && (
        <TeamEditor
          team={editing === 'new' ? null : editing}
          copySource={copying}
          roles={roles}
          onClose={() => { setCopying(null); setEditing(null); }}
          onSaved={() => { setCopying(null); setEditing(null); reloadTeams(); }}
        />
      )}
      </div>
    </div>
  );
}

function TeamPreflightPanel({ team }: { team: TeamDTO }) {
  const [result, setResult] = useState<{ pass: boolean; issues: TeamPreflightResultDTO['issues'] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let stopped = false;
    if (!team.roles?.length) { setResult(null); return; }
    setLoading(true);
    setResult(null);
    api.teams.preflight(team.id).then(data => { if (!stopped) setResult(data); })
      .catch(() => { if (!stopped) setResult({ pass: false, issues: [{ code: 'preflight_error', message: 'Preflight check could not be run', severity: 'error' }] }); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [team.id, team.roles?.length]);

  if (!team.roles?.length) return null;
  return (
    <div data-testid="team-preflight" className="mt-4 rounded-xl border border-border bg-background p-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-600">Preflight</span>
        {loading && <span className="text-[10px] text-gray-500">checking…</span>}
        {result && (
          <span className={cn('ml-auto rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider',
            result.pass ? 'bg-emerald-500/10 text-emerald-300' : 'bg-red-500/10 text-red-300')}>
            {result.pass ? 'Pass' : 'Blocked'}
          </span>
        )}
      </div>
      {result && !result.pass && (
        <ul className="mt-2 space-y-1">
          {result.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} className="text-[10px] leading-relaxed text-red-300">
              {issue.severity === 'error' ? '✗' : '△'} {issue.message}
            </li>
          ))}
        </ul>
      )}
      {result?.pass && (
        <p className="mt-1.5 text-[10px] text-emerald-300/80">All role slots, skills, tools, and domains resolve before dispatch.</p>
      )}
    </div>
  );
}

function TeamPreview({
  team,
  launchPanel,
  onCopy,
  onOpenCanvas,
}: {
  team: TeamDTO | null;
  launchPanel?: ReactNode;
  onCopy?: () => void;
  onOpenCanvas?: () => void;
}) {
  if (!team) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-[13px] text-gray-600">
        Select a team to inspect its roster and workflow.
      </div>
    );
  }

  const roster = team.roster?.length
    ? team.roster
    : team.members.map(role => ({ role, agentId: role, name: role }));
  const roleSlots = team.roles || [];
  const policyApprovals = team.policy?.requireHumanApprovalBefore || [];
  const teamDomains = team.domainIds || [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="border-b border-border p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xl">{team.emoji}</span>
              <h2 className="text-lg font-semibold tracking-tight text-gray-100">{team.name}</h2>
              <span className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-gray-500">@{team.id}</span>
              {team.builtin && <span className="rounded-md bg-white/5 px-2 py-0.5 text-[9px] text-gray-500">built-in</span>}
              {team.contractVersion === 2 && (
                <span data-testid="contract-v2-badge" className="rounded-md bg-accent/10 px-2 py-0.5 text-[9px] font-semibold text-accent-light">Contract v2</span>
              )}
            </div>
            <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-gray-400">{team.blurb}</p>
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            <div className="grid grid-cols-2 gap-2 text-[10px] sm:min-w-[220px]">
              <div className="rounded-lg border border-border bg-background p-2.5">
                <div className="text-gray-600">Lead</div>
                <div className="mt-1 font-medium text-gray-300">{team.lead}</div>
              </div>
              <div className="rounded-lg border border-border bg-background p-2.5">
                <div className="text-gray-600">Template</div>
                <div className="mt-1 truncate font-medium text-gray-300">{team.template || 'Dynamic'}</div>
              </div>
            </div>
            {(onCopy || onOpenCanvas) && (
              <div className="flex gap-2">
                {onCopy && (
                  <button onClick={onCopy}
                    className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-[10px] text-gray-300 hover:border-accent/40 hover:text-accent-light">
                    ⧉ 复制并定制
                  </button>
                )}
                {onOpenCanvas && (
                  <button onClick={onOpenCanvas}
                    className="flex-1 rounded-lg bg-accent/10 px-2 py-1.5 text-[10px] font-semibold text-accent-light hover:bg-accent/20">
                    ◇ 在 Canvas 打开
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.42fr)]">
        <section className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-600">
            {roleSlots.length ? 'Team workflow · v2 role slots' : 'Team workflow'}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {roleSlots.length ? (
              roleSlots.map((slot, index) => (
                <div key={`${slot.slot}-${index}`} className="contents">
                  <div className="min-w-[190px] flex-1 rounded-xl border border-border bg-background p-3 sm:max-w-[250px]">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-cyan-300">{slot.slot}</span>
                      <span className="ml-auto rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-gray-500">{slot.agentId}</span>
                    </div>
                    {slot.skills && slot.skills.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {slot.skills.map(skill => <span key={skill} className="rounded bg-accent/10 px-1.5 py-0.5 text-[9px] text-accent-light">{skill}</span>)}
                      </div>
                    )}
                    {slot.tools && slot.tools.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {slot.tools.map(tool => <span key={tool} className="rounded bg-purple-500/10 px-1.5 py-0.5 font-mono text-[9px] text-purple-300">{tool}</span>)}
                      </div>
                    )}
                    {slot.domainIds && slot.domainIds.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {slot.domainIds.map(domain => <span key={domain} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-300">{domain}</span>)}
                      </div>
                    )}
                  </div>
                  {index < roleSlots.length - 1 && <span className="text-[12px] text-gray-700">→</span>}
                </div>
              ))
            ) : (
              roster.map((member, index) => (
                <div key={`${member.role}-${member.agentId}`} className="contents">
                  <div className="min-w-[150px] flex-1 rounded-xl border border-border bg-background p-3 sm:max-w-[220px]">
                    <div className="text-[11px] font-semibold text-cyan-300">{member.name}</div>
                    <div className="mt-1 font-mono text-[9px] text-gray-600">{member.role}</div>
                    <div className="mt-2 text-[10px] text-gray-500">Agent: {member.agentId}</div>
                  </div>
                  {index < roster.length - 1 && <span className="text-[12px] text-gray-700">→</span>}
                </div>
              ))
            )}
          </div>
          <p className="mt-3 max-w-3xl text-[11px] leading-relaxed text-gray-600">
            {roleSlots.length
              ? 'Each role slot binds a stable agent to its skills, tools, and domain packs. The lead coordinates the roster; publish-grade actions require human approval.'
              : 'The master agent dynamically decomposes the goal across this roster. Independent work runs in parallel; dependencies are added only when a teammate needs another result.'}
          </p>
          <TeamPreflightPanel team={team} />
        </section>

        <section className="rounded-xl border border-border bg-background p-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-600">Best for</div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(team.triggers.length ? team.triggers : ['custom work']).map(trigger => (
              <span key={trigger} className="rounded-md bg-accent/10 px-2 py-1 text-[10px] text-accent-light">{trigger}</span>
            ))}
          </div>
          {policyApprovals.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-600">Human approval</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {policyApprovals.map(action => (
                  <span key={action} className="rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">👤 {action}</span>
                ))}
              </div>
            </div>
          )}
          {teamDomains.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-600">Domain packs</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {teamDomains.map(domain => (
                  <span key={domain} className="rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">📘 {domain}</span>
                ))}
              </div>
            </div>
          )}
          <div className="mt-4 border-t border-border pt-4">
            <div className="text-[11px] font-medium text-gray-300">Start a run</div>
            <p className="mt-1 text-[10px] leading-relaxed text-gray-600">
              Choose the current workspace or a GitHub repository on the left, describe the goal, then dispatch this team.
            </p>
          </div>
        </section>
      </div>
      {launchPanel && (
        <div className="border-t border-border bg-background/20 p-4 sm:p-5">
          {launchPanel}
        </div>
      )}
    </div>
  );
}

function TeamLaunchPanel({
  team,
  source,
  setSource,
  githubConnection,
  repository,
  setRepository,
  issue,
  setIssue,
  baseBranch,
  setBaseBranch,
  goal,
  setGoal,
  workspacePath,
  setWorkspacePath,
  workspaceIsGit,
  setWorkspaceIsGit,
  setError,
  busy,
  onDispatch,
}: {
  team: TeamDTO | null;
  source: 'workspace' | 'github';
  setSource: (source: 'workspace' | 'github') => void;
  githubConnection: GitHubConnectionStatus | null;
  repository: string;
  setRepository: (value: string) => void;
  issue: string;
  setIssue: (value: string) => void;
  baseBranch: string;
  setBaseBranch: (value: string) => void;
  goal: string;
  setGoal: (value: string) => void;
  workspacePath: string;
  setWorkspacePath: (value: string) => void;
  workspaceIsGit: boolean;
  setWorkspaceIsGit: (value: boolean) => void;
  setError: (value: string) => void;
  busy: boolean;
  onDispatch: () => void;
}) {
  const disabled = busy || !team
    || (source === 'workspace'
      ? !goal.trim() || !workspacePath.trim()
      : !repository.trim() || (!issue.trim() && !goal.trim()))
    || (source === 'github' && githubConnection?.authenticated === false);
  const chooseWorkspace = async () => {
    const desktop = window.myrmeciaDesktopIntegrations;
    if (!desktop) return;
    try {
      const workspace = await desktop.selectWorkspace();
      setWorkspacePath(workspace.path);
      setWorkspaceIsGit(workspace.isGitRepository);
    } catch (e: any) {
      setError(e.message || 'Unable to select workspace');
    }
  };

  return (
    <section>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-light">Team workbench</div>
          <h3 className="mt-1 text-sm font-semibold text-gray-200">
            Brief {team ? `${team.emoji} ${team.name}` : 'the selected team'}
          </h3>
          <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-gray-600">
            Start the shared run here. During execution, select any Agent card to inspect its output, send a live instruction, or redirect completed work.
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-1 rounded-lg border border-border bg-background p-1 lg:w-[300px]">
          <button type="button" onClick={() => setSource('workspace')}
            className={cn('rounded-md px-2 py-1.5 text-[11px] transition-colors',
              source === 'workspace' ? 'bg-accent/15 text-accent-light' : 'text-gray-500 hover:text-gray-300')}>
            Current workspace
          </button>
          <button type="button" onClick={() => setSource('github')}
            className={cn('rounded-md px-2 py-1.5 text-[11px] transition-colors',
              source === 'github' ? 'bg-accent/15 text-accent-light' : 'text-gray-500 hover:text-gray-300')}>
            GitHub repository
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.34fr)]">
        <textarea value={goal} onChange={e => setGoal(e.target.value)}
          placeholder={source === 'github'
            ? 'Describe the bug, acceptance criteria, and any additional constraints…'
            : 'Describe the outcome this team should deliver…'}
          rows={5}
          className="min-h-[116px] w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-[12px] leading-relaxed text-gray-200 focus:border-accent focus:outline-none"
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onDispatch(); }} />

        <div className="space-y-2">
          {source === 'github' ? (
            <>
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-gray-600">Isolated checkout</span>
                <span className={githubConnection?.authenticated ? 'text-emerald-400' : 'text-amber-400'}>
                  {githubConnection?.authenticated ? `gh: ${githubConnection.login}` : 'GitHub login required'}
                </span>
              </div>
              <input value={repository} onChange={e => setRepository(e.target.value)}
                placeholder="owner/repository or GitHub URL"
                className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[11px] text-gray-200 focus:border-accent focus:outline-none" />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
                <input value={issue} onChange={e => setIssue(e.target.value)}
                  placeholder="Issue # or URL"
                  className="min-w-0 rounded-lg border border-border bg-background px-2.5 py-2 text-[11px] text-gray-200 focus:border-accent focus:outline-none" />
                <input value={baseBranch} onChange={e => setBaseBranch(e.target.value)}
                  placeholder="Base branch (auto)"
                  className="min-w-0 rounded-lg border border-border bg-background px-2.5 py-2 text-[11px] text-gray-200 focus:border-accent focus:outline-none" />
              </div>
            </>
          ) : (
            <div className="space-y-2 rounded-lg border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium text-gray-400">Local project</span>
                {window.myrmeciaDesktopIntegrations && (
                  <button type="button" onClick={() => void chooseWorkspace()}
                    className="rounded-md bg-accent/10 px-2 py-1 text-[10px] text-accent-light hover:bg-accent/20">
                    Choose folder
                  </button>
                )}
              </div>
              <input
                value={workspacePath}
                onChange={event => {
                  setWorkspacePath(event.target.value);
                  setWorkspaceIsGit(false);
                }}
                readOnly={Boolean(window.myrmeciaDesktopIntegrations)}
                placeholder="Select an absolute local project directory"
                className="w-full truncate rounded-md border border-border bg-surface px-2 py-1.5 text-[10px] text-gray-300 outline-none focus:border-accent"
              />
              <div className="text-[10px] leading-relaxed text-gray-500">
                {workspacePath
                  ? `${workspaceIsGit ? 'Git repository' : 'Directory'} · Agents share this exact worktree.`
                  : 'Choose a project before dispatching. Myrmecia will not use its application-data folder as your code workspace.'}
              </div>
            </div>
          )}
          <button onClick={onDispatch} disabled={disabled}
            className="w-full rounded-lg bg-accent/90 py-2 text-[12px] font-medium text-white transition-colors hover:bg-accent disabled:opacity-40">
            {busy ? (source === 'github' ? 'Preparing repository…' : 'Dispatching…') : 'Dispatch team  ⌘↵'}
          </button>
        </div>
      </div>
    </section>
  );
}

function TeamEditor({
  team,
  copySource,
  roles,
  onClose,
  onSaved,
}: {
  team: TeamDTO | null;
  copySource?: TeamDTO | null;
  roles: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const source = copySource || team;
  const editingBuiltin = !!team?.builtin && !copySource;
  const [name, setName] = useState(copySource ? `${source?.name || 'Team'} Copy` : team?.name || '');
  const [emoji, setEmoji] = useState(team?.emoji || '🐜');
  const [blurb, setBlurb] = useState(team?.blurb || '');
  const [lead, setLead] = useState(team?.lead || source?.roles?.[0]?.slot || 'master');
  const [members, setMembers] = useState<string[]>(team?.members || source?.members || []);
  const [triggers, setTriggers] = useState((team?.triggers || source?.triggers || []).join(', '));
  const [roleSlots, setRoleSlots] = useState<TeamRoleSlotDTO[]>(
    team?.roles || source?.roles || [],
  );
  const [approvals, setApprovals] = useState<string[]>(
    team?.policy?.requireHumanApprovalBefore || source?.policy?.requireHumanApprovalBefore || [],
  );
  const [domainIds, setDomainIds] = useState<string[]>(
    team?.domainIds || source?.domainIds || [],
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const v2 = roleSlots.length > 0;

  const toggleMember = (role: string) =>
    setMembers(m => m.includes(role) ? m.filter(r => r !== role) : [...m, role]);

  const updateSlot = (index: number, patch: Partial<TeamRoleSlotDTO>) =>
    setRoleSlots(slots => slots.map((slot, i) => i === index ? { ...slot, ...patch } : slot));

  const addSlot = () =>
    setRoleSlots(slots => [...slots, { slot: `slot-${slots.length + 1}`, agentId: roles[0] || 'master', skills: [], tools: [], domainIds: [] }]);

  const removeSlot = (index: number) =>
    setRoleSlots(slots => slots.filter((_, i) => i !== index));

  const toggleApproval = (action: string) =>
    setApprovals(list => list.includes(action) ? list.filter(a => a !== action) : [...list, action]);

  const toggleDomain = (domain: string) =>
    setDomainIds(list => list.includes(domain) ? list.filter(d => d !== domain) : [...list, domain]);

  const save = async () => {
    if (!name.trim() || (members.length === 0 && roleSlots.length === 0)) {
      setErr('Name and at least one member role or v2 role slot are required.');
      return;
    }
    setSaving(true); setErr('');
    const payload: TeamInputDTO = {
      name: name.trim(), emoji: emoji.trim() || '🐜', blurb: blurb.trim(),
      members, triggers: triggers.split(',').map(s => s.trim()).filter(Boolean),
      ...(v2 ? {
        lead: lead.trim() || roleSlots[0].slot,
        roles: roleSlots.map(slot => ({
          slot: slot.slot.trim(), agentId: slot.agentId.trim(),
          skills: (slot.skills || []).map(s => s.trim()).filter(Boolean),
          tools: (slot.tools || []).map(s => s.trim()).filter(Boolean),
          domainIds: (slot.domainIds || []).map(s => s.trim()).filter(Boolean),
        })),
        policy: { requireHumanApprovalBefore: approvals },
        domainIds,
      } : {}),
    };
    try {
      if (team && !copySource) await api.teams.update(team.id, payload);
      else await api.teams.create(payload);
      onSaved();
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  const agentOptions = Array.from(new Set([...roles, ...roleSlots.map(slot => slot.agentId)]));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[720px] max-w-[calc(100vw-2rem)] max-h-[88dvh] overflow-y-auto rounded-2xl border border-border bg-surface p-4 sm:p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-gray-100">
            {copySource ? `Copy ${source?.name} and customize` : team ? `Edit ${team.name}` : 'New team'}
            {editingBuiltin && <span className="ml-2 text-[10px] text-gray-500">(built-in — saves as an override)</span>}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200">✕</button>
        </div>

        {err && <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{err}</div>}

        <div className="flex gap-2">
          <div className="w-16">
            <label className="text-[11px] text-gray-500">Emoji</label>
            <input value={emoji} onChange={e => setEmoji(e.target.value)} maxLength={4}
              className="w-full text-center text-lg bg-background border border-border rounded-lg px-2 py-1.5 mt-1" />
          </div>
          <div className="flex-1">
            <label className="text-[11px] text-gray-500">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Data Team"
              className="w-full text-[13px] bg-background border border-border rounded-lg px-2.5 py-2 mt-1 text-gray-200 focus:outline-none focus:border-accent" />
          </div>
        </div>

        <div>
          <label className="text-[11px] text-gray-500">Blurb</label>
          <input value={blurb} onChange={e => setBlurb(e.target.value)} placeholder="What this squad does"
            className="w-full text-[12px] bg-background border border-border rounded-lg px-2.5 py-2 mt-1 text-gray-200 focus:outline-none focus:border-accent" />
        </div>

        {v2 && (
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[11px] text-gray-500">Lead</label>
              <span className="text-[10px] text-accent-light">Contract v2</span>
            </div>
            <select value={lead} onChange={e => setLead(e.target.value)}
              className="w-full text-[12px] bg-background border border-border rounded-lg px-2.5 py-2 mt-1 text-gray-200 focus:outline-none focus:border-accent">
              {roleSlots.map(slot => <option key={slot.slot} value={slot.slot}>{slot.slot}</option>)}
              <option value="master">master</option>
            </select>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between">
            <label className="text-[11px] text-gray-500">v2 Role slots <span className="text-gray-600">({roleSlots.length})</span></label>
            <button type="button" onClick={addSlot}
              className="text-[11px] text-accent hover:text-accent-light">+ Add slot</button>
          </div>
          <div className="mt-2 space-y-2">
            {roleSlots.map((slot, index) => (
              <div key={`${slot.slot}-${index}`} className="rounded-xl border border-border bg-background p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <input value={slot.slot} onChange={e => updateSlot(index, { slot: e.target.value })} placeholder="slot"
                    className="w-28 text-[11px] font-semibold bg-background border border-border rounded-lg px-2 py-1.5 text-cyan-200 focus:outline-none focus:border-accent" />
                  <select value={slot.agentId} onChange={e => updateSlot(index, { agentId: e.target.value })}
                    className="flex-1 text-[11px] bg-background border border-border rounded-lg px-2 py-1.5 text-gray-200 focus:outline-none focus:border-accent">
                    {agentOptions.map(agent => <option key={agent} value={agent}>{agent}</option>)}
                  </select>
                  <button type="button" onClick={() => removeSlot(index)}
                    className="text-[11px] text-gray-500 hover:text-red-400 px-1.5">✕</button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <input value={(slot.skills || []).join(', ')} onChange={e => updateSlot(index, { skills: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                    placeholder="skills: xiaohongshu-copywriting"
                    className="text-[10px] bg-background border border-border rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none focus:border-accent" />
                  <input value={(slot.tools || []).join(', ')} onChange={e => updateSlot(index, { tools: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                    placeholder="tools: web.search"
                    className="text-[10px] bg-background border border-border rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none focus:border-accent" />
                  <input value={(slot.domainIds || []).join(', ')} onChange={e => updateSlot(index, { domainIds: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                    placeholder="domains: tech-product"
                    className="text-[10px] bg-background border border-border rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none focus:border-accent" />
                </div>
              </div>
            ))}
            {roleSlots.length === 0 && (
              <p className="text-[10px] text-gray-600">No v2 role slots — this team uses the classic member list below.</p>
            )}
          </div>
        </div>

        <div>
          <label className="text-[11px] text-gray-500">Members <span className="text-gray-600">({members.length} selected — order matters)</span></label>
          <div className="flex flex-wrap gap-1.5 mt-1.5 max-h-40 overflow-y-auto">
            {roles.map(role => (
              <button key={role} onClick={() => toggleMember(role)}
                className={cn('text-[11px] rounded-lg px-2 py-1 border transition-colors',
                  members.includes(role)
                    ? 'border-accent bg-accent/15 text-accent-light'
                    : 'border-border text-gray-400 hover:border-gray-600')}>
                {members.includes(role) && <span className="mr-1">{members.indexOf(role) + 1}.</span>}{role}
              </button>
            ))}
          </div>
        </div>

        {v2 && (
          <div>
            <label className="text-[11px] text-gray-500">Human approval required before</label>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {['publish', 'deploy', 'invoice', 'external-send'].map(action => (
                <button key={action} onClick={() => toggleApproval(action)}
                  className={cn('text-[11px] rounded-lg px-2 py-1 border transition-colors',
                    approvals.includes(action)
                      ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                      : 'border-border text-gray-400 hover:border-gray-600')}>
                  👤 {action}
                </button>
              ))}
            </div>
            <label className="mt-3 block text-[11px] text-gray-500">Domain packs</label>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {['tech-product', 'content', 'marketing', 'compliance'].map(domain => (
                <button key={domain} onClick={() => toggleDomain(domain)}
                  className={cn('text-[11px] rounded-lg px-2 py-1 border transition-colors',
                    domainIds.includes(domain)
                      ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
                      : 'border-border text-gray-400 hover:border-gray-600')}>
                  📘 {domain}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="text-[11px] text-gray-500">Trigger keywords <span className="text-gray-600">(comma-separated)</span></label>
          <input value={triggers} onChange={e => setTriggers(e.target.value)} placeholder="data, schema, migration"
            className="w-full text-[12px] bg-background border border-border rounded-lg px-2.5 py-2 mt-1 text-gray-200 focus:outline-none focus:border-accent" />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-[12px] text-gray-400 px-3 py-2 rounded-lg hover:bg-surface-hover">Cancel</button>
          <button onClick={save} disabled={saving}
            className="text-[12px] bg-accent/90 hover:bg-accent text-white px-4 py-2 rounded-lg disabled:opacity-40">
            {saving ? 'Saving…' : team && !copySource ? 'Save changes' : copySource ? 'Create copy' : 'Create team'}
          </button>
        </div>
      </div>
    </div>
  );
}


