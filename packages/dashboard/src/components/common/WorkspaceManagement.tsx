import { useEffect, useRef, useState } from 'react';
import type { WorkspaceOperationPreview } from '@myrmecia/shared';
import { api, type WorkspaceLeaseRecoveryPreview } from '../../lib/api';
type WorkspaceEntry = Awaited<ReturnType<typeof api.managedWorkspaces.list>>[number];
export function WorkspaceManagement() {
  const [items, setItems] = useState<WorkspaceEntry[]>([]);
  const [preview, setPreview] = useState<WorkspaceOperationPreview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [leasePreview, setLeasePreview] = useState<WorkspaceLeaseRecoveryPreview>();
  const [effectsStopped, setEffectsStopped] = useState(false);
  const [maintenance, setMaintenance] = useState<Awaited<ReturnType<typeof api.managedWorkspaces.maintenancePreview>>>();
  const requestVersion = useRef(0);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const load = async () => {
    const version = ++requestVersion.current;
    try { const next = await api.managedWorkspaces.list(); if (version === requestVersion.current) setItems(next); }
    catch (error) { if (version === requestVersion.current) setError(error instanceof Error ? error.message : '无法读取目录'); }
  };
  useEffect(() => { if (api.managedWorkspaces) void load(); return () => { requestVersion.current++; }; }, []);
  useEffect(() => { if (preview) cancelRef.current?.focus(); }, [preview]);
  const inspect = async (item: WorkspaceEntry, operation: WorkspaceOperationPreview['operation']) => {
    setBusy(true); setError(''); setConfirmation('');
    const version = ++requestVersion.current;
    try { const next = await api.managedWorkspaces.preview(item.id, operation); if (version === requestVersion.current) setPreview(next); }
    catch (error) { if (version === requestVersion.current) setError(error instanceof Error ? error.message : '无法预览操作'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Workspace management" className="rounded-xl border border-border bg-surface/60 p-4">
    <header className="flex items-center justify-between"><h3 className="text-sm font-semibold">执行目录管理</h3>
      <button type="button" className="app-focus rounded-lg px-3 py-2 text-xs" disabled={busy} onClick={() => void load()}>刷新目录</button></header>
    <p className="mt-1 text-xs text-app-muted">任务验收、应用代码变更和删除存储是三个独立动作。过期只标记候选，不自动删除。</p>
    {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
    {!items.length && <p className="mt-3 text-xs text-app-muted">还没有注册目录。旧目录不会自动取得可删除的归属。</p>}
    <ul className="mt-3 divide-y divide-border">
      {items.map(item => <li key={item.id} className="py-3">
        <p className="break-all text-xs text-app-secondary">{item.canonicalPath}</p>
        <p className="mt-1 text-[11px] text-app-muted">{item.lifecycle} · {item.ownership} · {item.accessMode} · 产物 {item.captureState}</p>
        <p className="mt-1 text-[11px] text-app-muted">最近使用 {new Date(item.lastUsedAt).toLocaleString()} · 已保存产物 {(item.snapshotBytes / 1024).toFixed(1)} KiB · 占用 {item.occupants.length}</p>
        <p className="mt-1 text-[11px] text-app-muted">目录观察大小 {((item.directoryBytes || 0) / 1024).toFixed(1)} KiB{item.sizeTruncated ? '+（扫描有界，非完整总量）' : ''}</p>
        {(item.ownership === 'legacy_unmanaged' || (item.lifecycle === 'purged' && item.baseline.branch)) &&
          <button type="button" disabled={busy} className="app-focus mt-2 rounded-lg border border-border px-3 py-1.5 text-xs" onClick={async () => {
            setBusy(true); setError('');
            try { setMaintenance(await api.managedWorkspaces.maintenancePreview(item.id, item.ownership === 'legacy_unmanaged' ? 'adopt_source' : 'delete_branch')); }
            catch (error) { setError(error instanceof Error ? error.message : '无法预览'); }
            finally { setBusy(false); }
          }}>{item.ownership === 'legacy_unmanaged' ? '登记为源目录（不搬移）' : '预览清理已保留分支'}</button>}
        {!!item.occupants.length && <p className="mt-1 break-all text-[11px] text-app-muted">{item.occupants.map(claim => `${claim.taskId} · ${claim.mode} · ${claim.state}`).join(' / ')}</p>}
        {!!item.occupants.length && <button type="button" className="app-focus mt-2 rounded-lg border border-border px-3 py-1.5 text-xs" disabled={busy} onClick={async () => {
          setBusy(true); setError(''); setEffectsStopped(false); setPreview(undefined);
          try { setLeasePreview(await api.managedWorkspaces.previewLeaseRecovery(item.id)); }
          catch (error) { setError(error instanceof Error ? error.message : '无法核对占用'); }
          finally { setBusy(false); }
        }}>核对目录占用</button>}
        {item.ownership === 'legacy_unmanaged' ? <p className="mt-2 text-xs text-amber-500">旧目录仅展示，请先人工核对归属；不能删除。</p> : <div className="mt-2 flex gap-2">
          <button type="button" className="app-focus rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-40" disabled={busy || ['purged', 'reconciliation'].includes(item.lifecycle)}
            onClick={() => void inspect(item, item.lifecycle === 'archived' ? 'restore' : 'archive')}>{item.lifecycle === 'archived' ? '恢复目录' : '归档（保留文件）'}</button>
          {item.ownership === 'managed_execution' && item.lifecycle === 'archived' && <button type="button" className="app-focus rounded-lg border border-border px-3 py-1.5 text-xs text-red-500 disabled:opacity-40" disabled={busy}
            onClick={() => void inspect(item, 'purge')}>预览永久删除</button>}
        </div>}
      </li>)}
    </ul>
    {leasePreview && <section aria-label="Lease reconciliation" className="mt-4 rounded-xl border border-amber-500/40 bg-background p-4 text-xs">
      <h4 className="font-semibold">不确定目录占用 · 需要人工核对</h4>
      <p className="mt-2 text-app-muted">先停止并结算相关任务，再确认主机 Shell / 外部 Agent / MCP 的实际动作已停止。系统不会替你终止外部进程，也不会重放未知操作。</p>
      {leasePreview.claims.map(claim => <p key={claim.id} className="mt-1">{claim.taskId} · {claim.owner} · fence {claim.fence} · {claim.state}</p>)}
      {leasePreview.blockers.map(blocker => <p key={blocker} className="mt-2 text-amber-500">{blocker}</p>)}
      <label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={effectsStopped} onChange={event => setEffectsStopped(event.target.checked)} />我已在系统外核实：以上进程与外部写入全部停止</label>
      <div className="mt-3 flex gap-2">
        <button type="button" className="app-focus rounded-lg border border-border px-3 py-2" disabled={busy} onClick={() => setLeasePreview(undefined)}>取消核对</button>
        <button type="button" className="app-focus rounded-lg border border-border px-3 py-2 disabled:opacity-40" disabled={busy || !effectsStopped || !!leasePreview.blockers.length} onClick={async () => {
          if (!window.confirm('仅释放已核对的目录租约？这不证明外部任务成功，也不会恢复或重放未知工具调用。')) return;
          setBusy(true); setError('');
          try { await api.managedWorkspaces.reconcileLeases(leasePreview); setLeasePreview(undefined); await load(); }
          catch (error) { setError(error instanceof Error ? error.message : '占用状态已变化，请重新核对'); setLeasePreview(undefined); await load(); }
          finally { setBusy(false); }
        }}>确认已停止并释放占用</button>
      </div>
    </section>}
    {maintenance && <div role="dialog" aria-label="Confirm workspace maintenance" className="mt-4 rounded-xl border border-border p-4">
      <p className="break-all text-xs">{maintenance.action === 'adopt_source' ? '仅登记为用户源目录，不搬移、不会取得可删除权限。' : `仅删除已合入且不再使用的分支 ${maintenance.branch}，不会 force-delete。`} {maintenance.targetPath}</p>
      {maintenance.blockers.map(blocker => <p className="mt-2 text-xs text-amber-500" key={blocker}>{blocker}</p>)}
      <button type="button" autoFocus disabled={busy} className="app-focus mt-3 rounded-lg border border-border p-2 text-xs" onClick={() => setMaintenance(undefined)}>取消维护</button>
      <button type="button" disabled={busy || !!maintenance.blockers.length} className="app-focus ml-2 rounded-lg border border-border p-2 text-xs" onClick={async () => {
        setBusy(true); setError('');
        try { await api.managedWorkspaces.maintenance(maintenance.filesystemWorkspaceId, maintenance); setMaintenance(undefined); await load(); }
        catch (error) { setMaintenance(undefined); setError(error instanceof Error ? error.message : '维护失败'); }
        finally { setBusy(false); }
      }}>确认{maintenance.action === 'adopt_source' ? '登记' : '删除分支'}</button>
    </div>}
    {preview && <div role="dialog" aria-label="Confirm workspace operation" aria-modal="false" className="mt-4 rounded-xl border border-accent/30 bg-background p-4"
      onKeyDown={event => { if (event.key === 'Escape' && !busy) setPreview(undefined); }}>
      <h4 className="text-sm font-semibold">{preview.operation === 'archive' ? '归档目录' : preview.operation === 'restore' ? '恢复目录' : '永久删除目录'}</h4>
      <p className="mt-2 break-all text-xs">{preview.workspace.canonicalPath}</p>
      <p className="mt-1 text-xs text-app-muted">{preview.preservesFiles ? '不移动、不删除文件。' : '仅删除已审核的执行目录，保留产物快照与 Git 分支。此操作不可撤回。'}</p>
      {preview.blockers.map(blocker => <p key={blocker} className="mt-2 text-xs text-amber-500">{blocker}</p>)}
      {preview.operation === 'purge' && <label className="mt-2 block text-xs">输入目录 ID 确认 <input aria-label="Purge workspace confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder={preview.workspace.id} className="app-focus mt-1 w-full rounded-lg border border-border bg-surface p-2" /></label>}
      <div className="mt-3 flex gap-2">
        <button ref={cancelRef} type="button" className="app-focus rounded-lg border border-border px-3 py-2 text-xs" disabled={busy} onClick={() => setPreview(undefined)}>取消</button>
        <button type="button" className="app-focus rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-40"
          disabled={busy || !!preview.blockers.length || (preview.operation === 'purge' && confirmation !== preview.workspace.id)} onClick={async () => {
            setBusy(true); setError('');
            try { await api.managedWorkspaces.operate(preview); setPreview(undefined); await load(); }
            catch (error) { setError(error instanceof Error ? error.message : '操作失败，请刷新预览'); setPreview(undefined); await load(); }
            finally { setBusy(false); }
          }}>确认{preview.operation === 'archive' ? '归档' : preview.operation === 'restore' ? '恢复' : '永久删除'}</button>
      </div>
    </div>}
  </section>;
}
