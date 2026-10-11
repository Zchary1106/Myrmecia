import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ResolvedKnowledgeCitation } from '@myrmecia/shared';
import { api } from '../../lib/api';

export const knowledgeScopeLabels = { agent_private: 'Agent 私有', team_shared: 'Team 共享', session: '本会话临时', workspace: '工作区领域知识' };
/** Resolve on explicit click, not Markdown render. The server checks the
 * execution manifest, current membership, binding and immutable source bytes. */
export function KnowledgeCitationLink({ executionId, citationId, children }: {
  executionId?: string; citationId: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<ResolvedKnowledgeCitation>();
  const [error, setError] = useState('');
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++; setOpen(false); setSource(undefined); setError(''); setBusy(false);
    return () => { epoch.current++; };
  }, [executionId, citationId]);
  async function inspect() {
    if (busy) return;
    if (open) { setOpen(false); return; }
    setOpen(true); setSource(undefined); setError('');
    if (!executionId) { setError('没有对应执行记录，此引用尚未验证。'); return; }
    setBusy(true); const current = epoch.current;
    try {
      const result = await api.executions.citation(executionId, citationId);
      if (current === epoch.current) setSource(result);
    } catch (cause) {
      if (current === epoch.current) setError(cause instanceof Error ? cause.message : '引用未验证、已删除或访问权限已撤销。');
    } finally { if (current === epoch.current) setBusy(false); }
  }
  return <span className="relative">
    <button type="button" aria-expanded={open} aria-label={`查看知识引用 ${citationId}`}
      className="app-focus rounded px-1 text-accent-light underline underline-offset-2"
      onClick={() => void inspect()}>{children}</button>
    {open && <span role="note" className="my-2 block max-w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs not-italic">
      {busy && <span>正在核查来源…</span>}
      {error && <span role="alert" className="text-amber-600">{error}</span>}
      {source && <>
        <span className="block font-medium text-app-primary">{source.title} · {source.locator}</span>
        <span className="mt-1 block text-app-muted">{knowledgeScopeLabels[source.scope]} · v{source.version} · {source.sourceHash.slice(0, 12)}
          {' · '}来源片段已核查，不代表模型结论已通过验收</span>
        <span className="mt-2 block whitespace-pre-wrap [overflow-wrap:anywhere]">{source.text}</span>
        {source.shortened && <span className="mt-1 block text-amber-600">这是截取片段，未包含原文全部内容。</span>}
      </>}
    </span>}
  </span>;
}
