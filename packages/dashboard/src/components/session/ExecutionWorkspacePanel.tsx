import { useEffect, useRef, useState } from 'react';
import { api, type WorkspaceChangePreview } from '../../lib/api';
type WorkspaceInfo = Awaited<ReturnType<typeof api.managedWorkspaces.task>>;
export function ExecutionWorkspacePanel({ taskId }: { taskId: string }) {
  const [info, setInfo] = useState<WorkspaceInfo>();
  const [error, setError] = useState('');
  const [files, setFiles] = useState('');
  const [preview, setPreview] = useState<WorkspaceChangePreview>();
  const [busy, setBusy] = useState(false);
  const taskRef = useRef(taskId); taskRef.current = taskId;
  useEffect(() => {
    let disposed = false;
    setInfo(undefined); setPreview(undefined); setError(''); setFiles('');
    const refresh = async () => {
      if (!api.managedWorkspaces) return;
      try { const next = await api.managedWorkspaces.task(taskId); if (!disposed) { setInfo(next); setError(''); } }
      catch (error) { if (!disposed) setError(error instanceof Error ? error.message : 'Workspace unavailable'); }
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [taskId]);
  const previewChanges = async () => {
    if (!info?.binding || !info.source || busy) return;
    const target = taskId; setBusy(true); setError('');
    try {
      const next = await api.managedWorkspaces.changes(info.binding.filesystemWorkspaceId, info.source.id, files.split('\n').map(value => value.trim()).filter(Boolean));
      if (taskRef.current === target) setPreview(next);
    } catch (error) { if (taskRef.current === target) setError(error instanceof Error ? error.message : 'Changes unavailable'); }
    finally { if (taskRef.current === target) setBusy(false); }
  };
  return <section aria-label="Execution workspace" className="rounded-xl border border-border/70 bg-surface/40 p-3 text-xs">
    <details>
      <summary className="app-focus cursor-pointer font-medium text-app-secondary">执行目录 · {info?.binding?.accessMode || (info?.legacy ? 'legacy_unmanaged' : '读取中')}</summary>
      {error && <p role="alert" className="mt-2 text-red-500">{error}</p>}
      {info && <div className="mt-3 space-y-2 text-app-muted">
        <p>源目录 <code className="break-all text-app-secondary">{info.source?.canonicalPath || info.workspace?.sourcePath || '未指定（独立空目录）'}</code></p>
        <p>服务端执行目录 <code className="break-all text-app-secondary">{info.binding?.executionPath || info.executionPath || '尚未分配'}</code></p>
        {info.workspace && <p>归属 {info.workspace.ownership} · {info.workspace.lifecycle} · 产物 {info.workspace.captureState}</p>}
        {info.binding?.baseline.head && <p>基线 <code>{info.binding.baseline.head.slice(0, 12)}</code> · {info.binding.baseline.branch} · {info.binding.baseline.provenance}</p>}
        {!!info.binding?.baseline.excluded.length && <p>未带入：{info.binding.baseline.excluded.join(', ')}</p>}
        <p>目录占用：{info.occupants?.map(item => `${item.taskId} (${item.mode}; ${item.state || 'active'})`).join(', ') || '无活动执行'}</p>
        <p>追问沿用会话目录；历史产物按 execution 保存，后续改写不影响已保存版本。</p>
        <p>目录分离不等于操作系统沙箱。Host Shell、外部 Agent、MCP 不受通用文件系统隔离保障；共享只读拒绝不支持的工具。</p>
        {info.source && info.binding?.accessMode === 'isolated' && <details className="mt-3 border-t border-border pt-2">
          <summary className="app-focus cursor-pointer">代码变更预览（与输出验收分开）</summary>
          <label className="mt-2 block">要审阅的文件（每行一个相对路径）<textarea aria-label="Reviewed change files" value={files} onChange={event => { setFiles(event.target.value); setPreview(undefined); }}
            rows={3} className="app-focus mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <button type="button" disabled={busy || !files.trim()} className="app-focus mt-2 rounded-lg border border-border px-3 py-2 disabled:opacity-40" onClick={() => void previewChanges()}>预览变更</button>
          {preview && <div className="mt-2 space-y-2">
            <p>目标：{preview.targetPath} · {preview.targetBranch} · {preview.targetHead.slice(0, 12)}</p>
            {!!preview.changes?.length && <ul className="space-y-1">{preview.changes.map(change =>
              <li className="break-all" key={change.path}>{change.operation === 'add' ? '新增' : change.operation === 'delete' ? '删除' : '修改'} · {change.path}</li>)}</ul>}
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-background p-2">{preview.patch || '(no patch)'}</pre>
            {preview.blockers.map(blocker => <p key={blocker} className="text-amber-500">{blocker}</p>)}
            <button type="button" className="app-focus rounded-lg border border-border px-3 py-2" onClick={() => {
              const url = URL.createObjectURL(new Blob([preview.patch], { type: 'text/x-diff' }));
              const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${preview.sourceId}.patch`; anchor.click(); URL.revokeObjectURL(url);
            }}>下载 Patch</button>
            <button type="button" disabled={busy || !!preview.blockers.length} className="app-focus ml-2 rounded-lg border border-border px-3 py-2 disabled:opacity-40" onClick={async () => {
              if (!window.confirm(`将已预览的文件变更应用到 ${preview.targetPath}？不会 commit、merge 或 push。`)) return;
              const target = taskId; setBusy(true); setError('');
              try { await api.managedWorkspaces.applyChanges(preview); if (taskRef.current === target) setPreview(undefined); }
              catch (error) { if (taskRef.current === target) setError(error instanceof Error ? error.message : 'Apply failed'); }
              finally { if (taskRef.current === target) setBusy(false); }
            }}>确认应用文件变更</button>
          </div>}
        </details>}
      </div>}
    </details>
  </section>;
}
