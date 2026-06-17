import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type TeamDTO, type TeamRunDTO, type TeamBoardItem, type TeamInputDTO } from '../lib/api';
import { wsClient } from '../lib/ws';
import { useStore } from '../stores/store';
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
  const { agents, loadAgents } = useStore();
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
  const [editing, setEditing] = useState<TeamDTO | 'new' | null>(null);
  const activeRunRef = useRef<string | null>(null);
  activeRunRef.current = activeRunId;

  const team = useMemo(() => teams.find(t => t.id === picked) || null, [teams, picked]);
  const roles = useMemo(() => [...new Set(agents.map(a => a.role))].sort(), [agents]);

  const reloadTeams = () => api.teams.list().then(setTeams).catch(e => setError(e.message));

  useEffect(() => {
    if (!agents.length) loadAgents();
    api.teams.list().then(ts => {
      setTeams(ts);
      if (ts.length && !picked) setPicked(ts[0].id);
    }).catch(e => setError(e.message));
    api.teams.runs().then(setRuns).catch(() => {});
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
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Squads</span>
            <button onClick={() => setEditing('new')}
              className="text-[11px] text-accent hover:text-accent-light flex items-center gap-1">+ New team</button>
          </div>
          <div className="space-y-1.5 overflow-y-auto">
            {teams.map(t => (
              <div key={t.id}
                onClick={() => setPicked(t.id)}
                className={cn('group w-full text-left rounded-xl border p-3 transition-colors cursor-pointer',
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

          <div className="rounded-xl border border-border bg-surface p-3 space-y-2">
            <div className="text-[11px] text-gray-500">
              {team ? <>Dispatch to <span className="text-gray-300">{team.emoji} {team.name}</span></> : 'Pick a team'}
            </div>
            <textarea value={goal} onChange={e => setGoal(e.target.value)}
              placeholder="Describe the goal… e.g. add a profile page with avatar upload"
              rows={3}
              className="w-full text-[12px] bg-background border border-border rounded-lg px-2.5 py-2 text-gray-200 resize-none focus:outline-none focus:border-accent"
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
                  {selected.output && <div className="text-[11px] text-gray-500 bg-background rounded-lg p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">{selected.output.slice(0, 600)}</div>}
                  <div className="flex items-center gap-2">
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

      {editing && (
        <TeamEditor
          team={editing === 'new' ? null : editing}
          roles={roles}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reloadTeams(); }}
        />
      )}
    </div>
  );
}

function TeamEditor({ team, roles, onClose, onSaved }: {
  team: TeamDTO | null;
  roles: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editingBuiltin = !!team?.builtin;
  const [name, setName] = useState(team?.name || '');
  const [emoji, setEmoji] = useState(team?.emoji || '🐜');
  const [blurb, setBlurb] = useState(team?.blurb || '');
  const [members, setMembers] = useState<string[]>(team?.members || []);
  const [triggers, setTriggers] = useState((team?.triggers || []).join(', '));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const toggle = (role: string) =>
    setMembers(m => m.includes(role) ? m.filter(r => r !== role) : [...m, role]);

  const save = async () => {
    if (!name.trim() || members.length === 0) { setErr('Name and at least one member are required.'); return; }
    setSaving(true); setErr('');
    const payload: Partial<TeamInputDTO> = {
      name: name.trim(), emoji: emoji.trim() || '🐜', blurb: blurb.trim(),
      members, triggers: triggers.split(',').map(s => s.trim()).filter(Boolean),
    };
    try {
      if (team) await api.teams.update(team.id, payload);
      else await api.teams.create(payload as TeamInputDTO);
      onSaved();
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[520px] max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-surface p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-gray-100">
            {team ? `Edit ${team.name}` : 'New team'}
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

        <div>
          <label className="text-[11px] text-gray-500">Members <span className="text-gray-600">({members.length} selected — order matters)</span></label>
          <div className="flex flex-wrap gap-1.5 mt-1.5 max-h-44 overflow-y-auto">
            {roles.map(role => (
              <button key={role} onClick={() => toggle(role)}
                className={cn('text-[11px] rounded-lg px-2 py-1 border transition-colors',
                  members.includes(role)
                    ? 'border-accent bg-accent/15 text-accent-light'
                    : 'border-border text-gray-400 hover:border-gray-600')}>
                {members.includes(role) && <span className="mr-1">{members.indexOf(role) + 1}.</span>}{role}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-[11px] text-gray-500">Trigger keywords <span className="text-gray-600">(comma-separated)</span></label>
          <input value={triggers} onChange={e => setTriggers(e.target.value)} placeholder="data, schema, migration"
            className="w-full text-[12px] bg-background border border-border rounded-lg px-2.5 py-2 mt-1 text-gray-200 focus:outline-none focus:border-accent" />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-[12px] text-gray-400 px-3 py-2 rounded-lg hover:bg-surface-hover">Cancel</button>
          <button onClick={save} disabled={saving}
            className="text-[12px] bg-accent/90 hover:bg-accent text-white px-4 py-2 rounded-lg disabled:opacity-40">
            {saving ? 'Saving…' : team ? 'Save changes' : 'Create team'}
          </button>
        </div>
      </div>
    </div>
  );
}
