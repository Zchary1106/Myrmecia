import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, Check, MoreHorizontal, Search, Trash2, X } from 'lucide-react';
import type { Task } from '@myrmecia/shared';
import { conversationDeletionPolicy } from '@myrmecia/shared';
import { cn } from '../../lib/utils';
import { runtimeControlsAllowed, taskDeleteAllowed } from '../../lib/permissions';
import { conversationIdForTask, useConversationStore, workflowConversationLabel } from '../../stores/conversations';
import { useStore } from '../../stores/store';

export type SessionHistoryItem = { id: string; task: Task; title: string; activity: Task };
const terminal = ['done', 'failed', 'cancelled'];
const labels: Record<Task['status'], string> = {
  pending: 'Preparing', queued: 'Routing', assigned: 'Assigned', running: 'In progress',
  waiting_for_tool: 'Waiting for a tool', review: 'In review', done: 'Completed', failed: 'Needs attention', cancelled: 'Cancelled',
};
function date(value: string) { return new Date(/^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(' ', 'T')}Z` : value); }
function groupLabel(task: Task, pipelineStatus?: string) {
  if (['paused', 'awaiting_retry', 'blocked'].includes(pipelineStatus || '')) return 'Needs attention';
  if (pipelineStatus === 'running') return 'Active';
  if (!terminal.includes(task.status)) return 'Active';
  const time = date(task.completedAt || task.startedAt || task.createdAt);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();
  const days = Math.round((start - day) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (time.getFullYear() === now.getFullYear() && time.getMonth() === now.getMonth()) return 'This month';
  return 'Older';
}

export function SessionHistory({ sessions, selectedId, onSelect, onClose }: {
  sessions: SessionHistoryItem[]; selectedId?: string; onSelect: (taskId: string | null) => void; onClose: () => void;
}) {
  const { states, loaded, error: loadError, load, manage } = useConversationStore();
  const diagnostics = useStore(state => state.diagnostics);
  const tasks = useStore(state => state.tasks);
  const pipelines = useStore(state => state.pipelines);
  const executions = useStore(state => state.executions);
  const policies = useMemo(() => {
    const byId = new Map(tasks.map(task => [task.id, task]));
    return new Map(sessions.map(item => {
      const pipelineId = item.id.startsWith('pipeline:') ? item.id.slice(9) : undefined;
      const pipeline = pipelines.find(value => value.id === pipelineId);
      const members = tasks.filter(task => conversationIdForTask(task, byId) === item.id);
      const memberIds = new Set([...members.map(task => task.id), item.task.id, item.activity.id]);
      const policy = conversationDeletionPolicy({
        taskStatuses: [...members.map(task => task.status), item.task.status, item.activity.status],
        executionStatuses: executions.filter(execution => memberIds.has(execution.taskId)).map(execution => execution.status),
        pipelineStatus: pipeline?.status,
        stageStatuses: pipeline?.stages?.map(stage => stage.status),
      });
      return [item.id, { ...policy, pipelineStatus: pipeline?.status,
        ...(pipelineId && !pipeline ? { allowed: false, requiresWorkflowStop: false, reason: '正在读取关联 Workflow 的状态，请稍后重试。' } : {}),
      }] as const;
    }));
  }, [sessions, tasks, pipelines, executions]);
  const statusLabel = (item: SessionHistoryItem) => {
    const policy = policies.get(item.id)!;
    const workflowLabel = workflowConversationLabel(policy.pipelineStatus);
    if (workflowLabel) return workflowLabel;
    if (terminal.includes(item.activity.status) && !policy.allowed) return '仍有待处理的执行';
    return labels[item.activity.status];
  };
  const canControl = runtimeControlsAllowed(diagnostics) && loaded;
  const canDelete = taskDeleteAllowed(diagnostics) && loaded;
  const [scope, setScope] = useState<'current' | 'archived'>('current');
  const [query, setQuery] = useState('');
  const [batch, setBatch] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const confirmPanel = useRef<HTMLDivElement>(null);
  const deleteTrigger = useRef<HTMLElement | null>(null);

  const available = sessions.filter(item => states[item.id] !== 'deleted');
  const archivedCount = available.filter(item => states[item.id] === 'archived').length;
  const visible = available.filter(item => (scope === 'archived' ? states[item.id] === 'archived' : states[item.id] !== 'archived')
    && `${item.title} ${statusLabel(item)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const groups = useMemo(() => {
    const result = new Map<string, SessionHistoryItem[]>();
    visible.forEach(item => { const label = groupLabel(item.activity, policies.get(item.id)?.pipelineStatus); result.set(label, [...(result.get(label) || []), item]); });
    return ['Active', 'Needs attention', 'Today', 'Yesterday', 'Previous 7 days', 'This month', 'Older']
      .flatMap(label => result.has(label) ? [{ label, items: result.get(label)! }] : []);
  }, [sessions, states, scope, query, policies]);
  const eligible = visible.slice(0, 100);
  const selectedItems = eligible.filter(item => checked.includes(item.id));
  const confirmationNeedsStop = !!confirmIds?.some(id => policies.get(id)?.requiresWorkflowStop);
  const confirmationBlocked = !!confirmIds?.some(id => !policies.get(id)?.allowed);
  const changeScope = (value: 'current' | 'archived') => { setScope(value); setChecked([]); setMenuId(null); };

  useEffect(() => {
    if (!menuId || confirmIds) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuId(null); };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [menuId, confirmIds]);

  useEffect(() => {
    if (!confirmIds) return;
    const previous = document.activeElement as HTMLElement | null;
    confirmPanel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setConfirmIds(null);
      if (event.key === 'Tab') {
        const buttons = [...(confirmPanel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
        if (!buttons.length) { event.preventDefault(); return; }
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); else deleteTrigger.current?.focus(); };
  }, [confirmIds, busy]);

  const run = async (ids: string[], action: 'archive' | 'restore' | 'delete', stopWorkflow = false) => {
    const items = sessions.filter(item => ids.includes(item.id));
    if (!items.length || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const affected = await manage(items.map(item => item.task.id), action, stopWorkflow);
      setConfirmIds(null); setMenuId(null); setChecked([]);
      if (selectedId && affected.includes(selectedId) && action !== 'restore') {
        const nextStates = useConversationStore.getState().states;
        const next = sessions.find(item => !nextStates[item.id] && !affected.includes(item.id));
        onSelect(next?.task.id || null);
      }
      setNotice(`${affected.length} 个会话已${action === 'delete' ? '从聊天历史删除' : action === 'archive' ? '归档' : '恢复'}。`);
    } catch (error) { setError(error instanceof Error ? error.message : '操作失败，请重试。'); }
    finally { setBusy(false); }
  };
  const askDelete = (ids: string[]) => {
    deleteTrigger.current = document.activeElement as HTMLElement | null;
    setError(''); setConfirmIds(ids);
  };

  return (
    <section aria-label="Session history" className="flex min-h-0 flex-1 flex-col overflow-hidden border-b border-border/70">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
        <div><div className="text-xs font-semibold text-app-primary">Task sessions</div><div className="mt-0.5 text-[10px] text-app-muted">{available.length} conversations</div></div>
        <div className="flex items-center gap-1">
          <button type="button" disabled={busy || !canControl} onClick={() => { setBatch(value => !value); setChecked([]); setMenuId(null); }} aria-pressed={batch} className="app-focus rounded-lg px-2 py-1.5 text-[11px] text-app-secondary hover:bg-surface-hover disabled:opacity-40">{batch ? '完成' : '管理'}</button>
          <button type="button" onClick={onClose} aria-label="Close task sessions" className="app-focus rounded-lg p-1.5 text-app-muted xl:hidden"><X size={15} /></button>
        </div>
      </div>
      <div className="shrink-0 space-y-2 border-b border-border/70 p-3">
        <div aria-label="Conversation scope" className="flex gap-1 rounded-lg bg-background/60 p-1">
          <button type="button" onClick={() => changeScope('current')} aria-pressed={scope === 'current'} className={cn('app-focus flex-1 rounded-md py-1.5 text-[11px]', scope === 'current' ? 'bg-surface-hover text-app-primary' : 'text-app-muted')}>会话</button>
          <button type="button" onClick={() => changeScope('archived')} aria-pressed={scope === 'archived'} className={cn('app-focus flex-1 rounded-md py-1.5 text-[11px]', scope === 'archived' ? 'bg-surface-hover text-app-primary' : 'text-app-muted')}>归档{archivedCount ? ` · ${archivedCount}` : ''}</button>
        </div>
        <label className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2 text-app-muted focus-within:border-accent/50">
          <Search size={14} /><input value={query} onChange={event => { setQuery(event.target.value); setChecked([]); }} placeholder="Search conversations" aria-label="Search task sessions" className="min-w-0 flex-1 bg-transparent text-xs text-app-primary outline-none placeholder:text-app-muted" />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear session search" className="app-focus rounded p-0.5"><X size={12} /></button>}
        </label>
        {batch && <div className="space-y-2 text-[10px] text-app-muted">
          <label className="flex items-center gap-2"><input type="checkbox" aria-label="全选可管理会话" disabled={!eligible.length || busy} checked={eligible.length > 0 && selectedItems.length === eligible.length} onChange={event => setChecked(event.target.checked ? eligible.map(item => item.id) : [])} />全选可管理会话（最多 100 个）</label>
          <div className="flex items-center justify-between gap-1"><span>已选 {selectedItems.length}</span>
            <button type="button" aria-label={scope === 'archived' ? '批量恢复会话' : '批量归档会话'} disabled={!selectedItems.length || busy || !canControl} onClick={() => void run(selectedItems.map(item => item.id), scope === 'archived' ? 'restore' : 'archive')} className="app-focus rounded px-2 py-1.5 text-accent-light disabled:opacity-40">{scope === 'archived' ? '恢复' : '归档'}</button>
            <button type="button" aria-label="批量删除会话" disabled={!selectedItems.length || busy || !canDelete || selectedItems.some(item => !policies.get(item.id)?.allowed)} onClick={() => askDelete(selectedItems.map(item => item.id))} className="app-focus rounded px-2 py-1.5 text-red-500 disabled:opacity-40">删除</button>
          </div>
          <p>归档不影响执行；删除运行中的会话需先停止任务。</p>
        </div>}
        {!loaded && !loadError && <p role="status" className="text-[10px] text-app-muted">正在读取管理状态…</p>}
        {loadError && <p role="alert" className="text-[10px] text-red-500">{loadError}<button type="button" onClick={() => void load()} className="app-focus ml-2 text-accent-light">重试</button></p>}
        {notice && <p role="status" className="text-[10px] text-app-secondary">{notice}</p>}
        {error && !confirmIds && <p role="alert" className="text-[10px] text-red-500">{error}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {groups.map(group => <section key={group.label} aria-label={`${group.label} task sessions`}>
          <div className="px-4 pb-1 pt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-app-muted">{group.label}</div>
          {group.items.map(item => {
            const current = item.id === selectedId;
            const policy = policies.get(item.id)!;
            const active = !policy.allowed;
            return <div key={item.id} data-session-history-id={item.id} className={cn('group relative', current && 'bg-accent/[0.075] after:absolute after:bottom-2 after:left-0 after:top-2 after:w-0.5 after:rounded-full after:bg-accent')}>
              <div className="flex items-center gap-1 px-2">
                {batch && <input type="checkbox" aria-label={`选择会话：${item.title}`} disabled={busy} checked={checked.includes(item.id)} onChange={event => setChecked(values => event.target.checked ? [...values, item.id] : values.filter(id => id !== item.id))} className="ml-2 shrink-0" />}
                <button type="button" onClick={() => { onSelect(item.task.id); onClose(); }} aria-current={current ? 'page' : undefined} className="app-focus flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-3 text-left transition hover:bg-surface-hover">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', policy.requiresWorkflowStop ? 'bg-amber-400' : active ? 'bg-accent' : item.activity.status === 'done' && policy.pipelineStatus !== 'failed' ? 'bg-emerald-400' : 'bg-red-400')} />
                  <span className="min-w-0 flex-1"><span title={item.title} className="block truncate text-xs font-medium text-app-primary">{item.title}</span><span className="mt-0.5 block truncate text-[10px] text-app-muted">{statusLabel(item)} · {date(item.activity.completedAt || item.activity.startedAt || item.activity.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></span>
                  {current && <Check size={13} className="shrink-0 text-accent-light" aria-label="Current session" />}
                </button>
                {!batch && <button type="button" aria-label={`会话操作：${item.title}`} aria-expanded={menuId === item.id} disabled={busy} onClick={() => { setMenuId(id => id === item.id ? null : item.id); setError(''); }} className="app-focus shrink-0 rounded-lg p-1.5 text-app-muted hover:bg-surface-hover hover:text-app-primary"><MoreHorizontal size={15} /></button>}
              </div>
              {menuId === item.id && <div aria-label="会话操作" className="glass-session-menu mx-3 mb-2 space-y-1 rounded-lg border border-border/70 bg-background/80 p-1.5">
                {active && <p className="px-2 py-1 text-[10px] text-app-muted">{policy.reason}</p>}
                {policy.requiresWorkflowStop && <p className="px-2 py-1 text-[10px] text-app-muted">可直接归档；删除时需确认结束流程。</p>}
                <button type="button" disabled={busy || !canControl} onClick={() => void run([item.id], scope === 'archived' ? 'restore' : 'archive')} className="app-focus flex w-full items-center gap-2 rounded-md px-2 py-2 text-[11px] text-app-secondary hover:bg-surface-hover disabled:opacity-40">{scope === 'archived' ? <ArchiveRestore size={13} /> : <Archive size={13} />}{scope === 'archived' ? '恢复会话' : '归档会话'}</button>
                <button type="button" disabled={busy || !canDelete || active} onClick={() => askDelete([item.id])} className="app-focus flex w-full items-center gap-2 rounded-md px-2 py-2 text-[11px] text-red-500 hover:bg-red-500/10 disabled:opacity-40"><Trash2 size={13} />删除会话</button>
                {!canControl && loaded && <p className="px-2 py-1 text-[10px] text-app-muted">当前角色无管理权限。</p>}
              </div>}
            </div>;
          })}
        </section>)}
        {!groups.length && <p className="px-4 py-10 text-center text-xs text-app-muted">{query ? `No conversations match “${query}”.` : scope === 'archived' ? '暂无归档会话。' : '暂无会话。可在归档中恢复旧会话。'}</p>}
      </div>
      {confirmIds && createPortal(
        <div className="ui-dialog-backdrop" onMouseDown={event => { if (!busy && event.target === event.currentTarget) setConfirmIds(null); }}>
          <div ref={confirmPanel} role="dialog" aria-modal="true" aria-labelledby="delete-conversations-title" className="ui-dialog max-w-md">
            <h2 id="delete-conversations-title" className="text-base font-semibold text-app-primary">删除 {confirmIds.length} 个会话？</h2>
            <p className="mt-3 text-sm leading-6 text-app-secondary">这些会话及全部追问将从聊天列表和首页移除，无法从归档恢复。关联任务、执行证据和磁盘文件仍保留，可在任务队列及产物页查看。</p>
            <p className="mt-2 text-xs text-app-muted">如只是想整理列表，建议选择“归档”。</p>
            {confirmationNeedsStop && <p className="mt-3 text-sm text-amber-600">其中有暂停、等待重试或受阻的 Workflow。确认后将结束这些流程，跳过尚未执行的步骤，不会发布内容，也不会清理磁盘文件。</p>}
            {confirmationBlocked && <p role="alert" className="mt-3 text-xs text-red-500">会话状态已变化，仍有待处理的工作。请取消并先停止任务，或选择归档。</p>}
            {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
            <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setConfirmIds(null)} className="ui-button">取消</button><button type="button" disabled={busy || confirmationBlocked || !canDelete} onClick={() => void run(confirmIds, 'delete', confirmationNeedsStop)} className="app-focus rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50">{busy ? '正在删除…' : confirmationNeedsStop ? '结束流程并删除' : '确认删除'}</button></div>
          </div>
        </div>, document.body,
      )}
    </section>
  );
}
