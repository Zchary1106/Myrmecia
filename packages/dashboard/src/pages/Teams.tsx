import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type TeamDTO, type TeamRunDTO, type TeamBoardItem } from '../lib/api';
import { cn } from '../lib/utils';

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
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
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
  const activeRunRef = useRef<string | null>(null);
  activeRunRef.current = activeRunId;

  const team = useMemo(() => teams.find(t => t.id === picked) || null, [teams, picked]);

  useEffect(() => {
    api.teams.list().then(ts => {
      setTeams(ts);
      if (ts.length && !picked) setPicked(ts[0].id);
    }).catch(e => setError(e.message));
    api.teams.runs().then(setRuns).catch(() => {});
  }, []);

  // Poll the active run's board every 2s while it's live.
  useEffect(() => {
    if (!activeRunId) return;
    let stop = false;
    const tick = async () => {
      try {
        const { run, board } = await api.teams.run(activeRunId);
        if (stop) return;
        setRun(run); setBoard(board);
      } catch { /* ignore */ }
    };
    tick();
    const iv = setInterval(() => {
      if (run && ['done', 'failed'].includes(run.status)) return;
      tick();
    }, 2000);
    return () => { stop = true; clearInterval(iv); };
  }, [activeRunId, run?.status]);

  // Refresh the runs list periodically.
  useEffect(() => {
    const iv = setInterval(() => { api.teams.runs().then(setRuns).catch(() => {}); }, 4000);
    return () => clearInterval(iv);
  }, []);

  const dispatch = async () => {
    if (!team || !goal.trim()) return;
    setBusy(true); setError('');
    try {
      const { run } = await api.teams.dispatch(team.id, goal.trim());
      setGoal('');
      setActiveRunId(run.id);
      setRun(run);
      setBoard([]);
      api.teams.runs().then(setRuns).catch(() => {});
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
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

  return (
    <div className="h-full flex flex-col gap-4 p-4 overflow-hidden">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Agent Teams</h1>
          <p className="text-[12px] text-gray-500">Put a squad to work — the lead splits the goal and teammates run in parallel on a shared board.</p>
        </div>
        {toast && <div className="text-[12px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-1.5">{toast}</div>}
      </div>

      {error && <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}

      <div className="flex-1 grid grid-cols-[300px_1fr] gap-4 min-h-0">
        {/* Left: team picker + dispatch + recent runs */}
        <div className="flex flex-col gap-3 min-h-0">
          <div className="space-y-1.5 overflow-y-auto">
            {teams.map(t => (
              <button key={t.id} onClick={() => setPicked(t.id)}
                className={cn('w-full text-left rounded-xl border p-3 transition-colors',
                  picked === t.id ? 'border-accent bg-accent/10' : 'border-border hover:border-gray-600 bg-surface')}>
                <div className="flex items-center gap-2">
                  <span className="text-lg">{t.emoji}</span>
                  <span className="font-medium text-gray-100 text-[13px]">{t.name}</span>
                  <span className="text-gray-600 text-[11px]">@{t.id}</span>
                </div>
                <p className="text-[11px] text-gray-500 mt-1 leading-snug">{t.blurb}</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {(t.roster?.length ? t.roster.map(r => r.agentId) : t.members).map(m => (
                    <span key={m} className="text-[10px] text-cyan-300/90 bg-cyan-500/10 rounded px-1.5 py-0.5">{m}</span>
                  ))}
                </div>
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-border bg-surface p-3 space-y-2">
            <div className="text-[11px] text-gray-500">
              {team ? <>Dispatch to <span className="text-gray-300">{team.emoji} {team.name}</span></> : 'Pick a team'}
            </div>
            <textarea value={goal} onChange={e => setGoal(e.target.value)}
              placeholder="Describe the goal… e.g. add a profile page with avatar upload"
              rows={3}
              className="w-full text-[12px] bg-bg border border-border rounded-lg px-2.5 py-2 text-gray-200 resize-none focus:outline-none focus:border-accent"
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) dispatch(); }} />
            <button onClick={dispatch} disabled={busy || !team || !goal.trim()}
              className="w-full rounded-lg bg-accent/90 hover:bg-accent text-white text-[12px] font-medium py-2 disabled:opacity-40 transition-colors">
              {busy ? 'Dispatching…' : 'Dispatch team  ⌘↵'}
            </button>
          </div>
        </div>

        {/* Right: live shared board */}
        <div className="flex flex-col min-h-0 rounded-xl border border-border bg-surface">
          {!activeRunId ? (
            <div className="flex-1 flex items-center justify-center text-gray-600 text-[13px]">
              Dispatch a team, or pick a recent run below, to see the live board.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                <span className={cn('w-2 h-2 rounded-full', run ? dot[run.status] : 'bg-gray-500')} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-gray-200 truncate">{run?.goal}</div>
                  <div className="text-[11px] text-gray-500">{run?.status} · {activeCount} working · {doneCount}/{board.length} done</div>
                </div>
              </div>

              <div className="flex-1 grid grid-cols-2 lg:grid-cols-3 gap-2.5 p-3 overflow-y-auto auto-rows-min">
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
                  {selected.output && <div className="text-[11px] text-gray-500 bg-bg rounded-lg p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">{selected.output.slice(0, 600)}</div>}
                  <div className="flex items-center gap-2">
                    <input value={message} onChange={e => setMessage(e.target.value)}
                      placeholder={`Message ${selected.assigneeId}…`}
                      onKeyDown={e => { if (e.key === 'Enter') sendMessage(); }}
                      className="flex-1 text-[12px] bg-bg border border-border rounded-lg px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-accent" />
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
                  <div className="text-[11px] text-gray-400 bg-bg rounded-lg p-2 max-h-40 overflow-y-auto whitespace-pre-wrap">{run.result.slice(0, 4000)}</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Recent runs strip */}
      {runs.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <span className="text-[11px] text-gray-600 shrink-0">Recent:</span>
          {runs.slice(0, 12).map(r => (
            <button key={r.id} onClick={() => { setActiveRunId(r.id); setRun(r); setBoard([]); setSelectedTask(null); }}
              className={cn('shrink-0 flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-colors',
                activeRunId === r.id ? 'border-accent bg-accent/10' : 'border-border hover:border-gray-600')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', dot[r.status])} />
              <span className="text-gray-400">{teams.find(t => t.id === r.teamId)?.emoji || '•'}</span>
              <span className="text-gray-300 max-w-[160px] truncate">{r.goal}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
