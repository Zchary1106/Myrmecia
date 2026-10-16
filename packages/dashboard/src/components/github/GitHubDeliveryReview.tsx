import { useEffect, useRef, useState } from 'react';
import type { GitHubFixDiff, GitHubFixRun } from '@myrmecia/shared';
import { api } from '../../lib/api';

export function GitHubDeliveryReview({ run, onPublished }: { run: GitHubFixRun; onPublished: (run: GitHubFixRun) => void }) {
  const [diff, setDiff] = useState<GitHubFixDiff | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [command, setCommand] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [allowFork, setAllowFork] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState<'loading' | 'verifying' | 'publishing' | 'reconciling' | null>(null);
  const [error, setError] = useState('');
  const [evidence, setEvidence] = useState('');
  const sequence = useRef(0);
  const active = useRef(run.id);
  active.current = run.id;
  const load = async () => {
    const request = ++sequence.current, id = run.id;
    setBusy('loading'); setError(''); setAccepted(false); setAllowFork(false); setPhrase(''); setEvidence('');
    try {
      const value = await api.githubFixes.diff(id);
      if (active.current !== id || request !== sequence.current) return;
      setDiff(value); setCommand(current => current || value.suggestedCommand || '');
    } catch (err: any) { if (active.current === id && request === sequence.current) setError(err.message); }
    finally { if (active.current === id && request === sequence.current) setBusy(null); }
  };
  useEffect(() => {
    setDiff(null); setCommand(''); setAccepted(false); setAllowFork(false); setPhrase('');
    if (run.status !== 'preparing') void load();
    return () => { sequence.current++; };
  }, [run.id, run.status]);

  const verify = async () => {
    if (!diff || !command.trim() || !window.confirm('运行这个项目的验证脚本？脚本可能修改工作区或访问当前执行环境。不会调用模型、提交或推送 GitHub。')) return;
    const request = ++sequence.current, id = run.id;
    setBusy('verifying'); setError(''); setAccepted(false); setPhrase(''); setEvidence('');
    try {
      const value = await api.githubFixes.verify(id, { confirm: true, diffHash: diff.diffHash,
        files: diff.files.map(file => file.path), command: command.trim() });
      if (active.current !== id || request !== sequence.current) return;
      setDiff(value);
      if (value.validation?.status !== 'passed') setError('验证失败、不可用或修改了文件。检查验证证据，刷新 Diff 后重新验证。');
    } catch (err: any) {
      if (active.current === id && request === sequence.current) { setError(err.message); setDiff(null); }
    } finally { if (active.current === id && request === sequence.current) setBusy(null); }
  };
  const inspectEvidence = async () => {
    const artifactId = diff?.validation?.outputArtifactId;
    if (!artifactId) return;
    const id = run.id, request = sequence.current;
    try {
      const body = await (await api.artifacts.preview(artifactId)).text();
      if (active.current === id && request === sequence.current) setEvidence(body);
    } catch (err: any) { if (active.current === id && request === sequence.current) setError(err.message); }
  };
  const stopVerification = async () => {
    const id = run.id, request = sequence.current;
    try {
      await api.githubFixes.cancelVerification(id);
      if (active.current === id && request === sequence.current) setError('已请求停止验证；正在等待命令结束。已发生的动作不能撤回，必要时须核对效果。');
    } catch (err: any) { if (active.current === id && request === sequence.current) setError(err.message); }
  };
  const reconcile = async () => {
    if (!diff?.reconciliationKey || !diff.publicationState
      || !window.confirm('只有在确认相关本地进程已停止、并检查既有文件/远程效果后继续。将读取必要的 Git/GitHub 状态并解除本次操作的占用；不会重放命令、再次提交、推送或创建 PR。你确认已停止并核对效果吗？')) return;
    const id = run.id, request = ++sequence.current;
    setBusy('reconciling'); setError(''); setAccepted(false); setPhrase('');
    try {
      const value = await api.githubFixes.reconcile(id, { confirm: true, operationId: diff.reconciliationKey,
        expectedState: diff.publicationState, effectsStopped: true });
      if (active.current === id && request === sequence.current) setDiff(value);
    } catch (err: any) { if (active.current === id && request === sequence.current) setError(err.message); }
    finally { if (active.current === id && request === sequence.current) setBusy(null); }
  };
  const publish = async () => {
    if (!diff || !accepted || phrase !== 'CREATE PR') return;
    const request = ++sequence.current, id = run.id;
    setBusy('publishing'); setError('');
    try {
      const result = await api.githubFixes.createPullRequest(id, { confirm: true, acceptDelivery: true,
        ...(allowFork ? { allowFork: true } : {}),
        diffHash: diff.diffHash, files: diff.files.map(file => file.path),
        title: run.issueTitle ? `fix: ${run.issueTitle}` : undefined });
      if (active.current !== id || request !== sequence.current) return;
      setAccepted(false); setPhrase(''); onPublished(result);
    } catch (err: any) {
      if (active.current === id && request === sequence.current) { setError(err.message); setAccepted(false); setPhrase(''); setDiff(null); }
    } finally { if (active.current === id && request === sequence.current) setBusy(null); }
  };
  const verified = diff?.validation?.status === 'passed' && diff.validation.diffHash === diff.diffHash
    && diff.validation.command === command.trim();
  const blocked = !diff?.hasChanges || !!diff.blockers.length || diff.truncated;
  const needsFork = !['WRITE', 'ADMIN', 'MAINTAIN'].includes(run.viewerPermission.toUpperCase());
  const canVerify = run.status === 'ready' && !blocked && !busy && !['committed', 'pushed', 'uncertain'].includes(diff?.publicationState || '');
  return <section aria-label="GitHub 交付审阅" className="space-y-3 border-t border-border bg-background/30 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-300">{run.status}</span>
      <span className="min-w-0 flex-1 truncate text-[10px] text-gray-500" title={run.localPath}>{run.localPath}</span>
      <button type="button" disabled={!!busy} onClick={() => { setExpanded(value => !value); }}
        className="rounded-lg border border-border px-2 py-1 text-xs">{expanded ? '收起 Diff' : '审阅 Diff'}</button>
      <button type="button" disabled={!!busy} onClick={() => void load()} className="rounded-lg border border-border px-2 py-1 text-xs">刷新审阅</button>
    </div>
    {run.issueUrl && <a href={run.issueUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-300">Issue #{run.issueNumber}: {run.issueTitle}</a>}
    {busy && <p role="status" className="text-xs text-app-muted">{busy === 'verifying' ? '正在运行真实验证命令…' : busy === 'publishing' ? '正在提交已审阅文件并创建 PR…' : busy === 'reconciling' ? '正在核对既有结果，不重放写操作…' : '正在读取当前文件版本…'}</p>}
    {busy === 'verifying' && <button type="button" onClick={() => void stopVerification()} className="text-xs text-amber-400">停止验证</button>}
    {(error || run.error) && <p role="alert" className="text-xs text-red-300">{error || run.error}</p>}
    {diff?.blockers.map((blocker, index) => <p key={index} className="text-xs text-amber-400">{blocker}</p>)}
    {diff?.reconciliationKey && ['uncertain', 'verifying', 'forking', 'committing', 'pushing', 'creating_pr'].includes(diff.publicationState || '')
      && !busy && <button type="button" onClick={() => void reconcile()} className="rounded-lg border border-amber-500/30 px-3 py-2 text-xs text-amber-400">核对既有结果</button>}
    {expanded && diff && <div className="space-y-2">
      <p className="text-xs text-app-muted">完整审阅范围 · {diff.files.length} 个文件 · {diff.diffHash.slice(0, 12)}</p>
      <ul className="max-h-40 overflow-auto text-xs">{diff.files.map(file => <li key={file.path} className="break-all">
        {file.change} · {file.path} · {file.sha256?.slice(0, 12) || '删除'}</li>)}</ul>
      <pre aria-label="完整变更预览" className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-[11px]">{diff.patch || '当前没有可审阅的变更。'}</pre>
    </div>}
    {run.status === 'ready' && <div className="space-y-2">
      <label className="block text-xs">验证命令<input aria-label="GitHub 验证命令" value={command} maxLength={500} disabled={!!busy}
        onChange={event => { setCommand(event.target.value); setAccepted(false); setPhrase(''); }}
        placeholder="pnpm test / python -m pytest / go test ./... / cargo test"
        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2" /></label>
      <button type="button" onClick={() => void verify()} disabled={!canVerify || !command.trim()} className="rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-40">验证当前文件版本</button>
      {diff?.validation && <p className="text-xs text-app-muted">验证结果：{diff.validation.status} · {diff.validation.command}
        {diff.validation.outputArtifactId && <> · <button type="button" onClick={() => void inspectEvidence()} disabled={!!busy} className="text-blue-300">查看验证证据</button></>}</p>}
      {evidence && <pre aria-label="验证证据" className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border p-3 text-xs">{evidence}</pre>}
      {verified && !blocked && <div className="space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
        {needsFork && <label className="flex items-start gap-2 text-xs"><input type="checkbox" aria-label="允许创建或复用我的 Fork"
          checked={allowFork} disabled={!!busy} onChange={event => { setAllowFork(event.target.checked); setAccepted(false); setPhrase(''); }} />
          无上游写权限。我明确允许在当前 GitHub 账户创建或复用此仓库的 Fork，并从该 Fork 创建 PR；不会覆盖已有的不匹配 remote。</label>}
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" aria-label="接受已审阅交付" checked={accepted}
          disabled={!!busy || !expanded} onChange={event => setAccepted(event.target.checked)} />
          我已展开审阅以上全部文件，检查验证证据，并接受本次交付。</label>
        <p className="text-xs text-app-muted">只提交这个文件清单；任何文件、HEAD 或任务证据变化都会使旧确认失效。</p>
        <input aria-label="创建 PR 确认" value={phrase} disabled={!!busy || !accepted} onChange={event => setPhrase(event.target.value)}
          placeholder="Type CREATE PR" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs" />
        <button type="button" onClick={() => void publish()} disabled={!!busy || !accepted || phrase !== 'CREATE PR' || needsFork && !allowFork}
          className="rounded-lg bg-amber-500/90 px-3 py-2 text-xs font-semibold text-black disabled:opacity-40">
          {diff.publicationState === 'committed' || diff.publicationState === 'pushed' ? '继续创建 PR' : 'Create PR'}</button>
      </div>}
    </div>}
    {run.prUrl && <a href={run.prUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-300">Open pull request ↗</a>}
  </section>;
}
