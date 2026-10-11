import { useEffect, useRef, useState } from 'react';
import type { KnowledgeCitationManifest } from '@myrmecia/shared';
import { api } from '../../lib/api';
import { KnowledgeCitationLink, knowledgeScopeLabels } from './KnowledgeCitationLink';

/** Manifest-backed retrieval trace, independent of whether the model remembered
 * to cite. Does not turn retrieved evidence into a claim of answer correctness. */
export function ExecutionKnowledgeSources({ executionId }: { executionId: string }) {
  const [manifest, setManifest] = useState<KnowledgeCitationManifest | null>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++; setManifest(undefined); setError(''); setBusy(false);
    return () => { epoch.current++; };
  }, [executionId]);
  async function read() {
    if (busy) return;
    const current = epoch.current; setBusy(true); setError('');
    try {
      const result = await api.executions.knowledge(executionId);
      if (current === epoch.current) setManifest(result);
    } catch (cause) {
      if (current === epoch.current) setError(cause instanceof Error ? cause.message : '无法读取来源记录');
    } finally { if (current === epoch.current) setBusy(false); }
  }
  return <details className="mt-3 rounded-lg border border-border px-3 py-2 text-xs"
    onToggle={event => { if (event.currentTarget.open && manifest === undefined) void read(); }}>
    <summary className="app-focus cursor-pointer text-app-muted">本次检索来源</summary>
    {busy && <p className="mt-2">正在读取来源记录…</p>}
    {error && <p role="alert" className="mt-2 text-amber-600">{error}
      <button className="app-focus ml-2 underline" onClick={() => void read()}>重试</button></p>}
    {manifest === null && <p className="mt-2 text-app-muted">本次执行没有记录知识片段；不能把模型自行写出的来源当作已验证引用。</p>}
    {manifest && <>
      <p className="mt-2 text-app-muted">记录了 {manifest.citations.length} 个片段 / {manifest.includedCharacters} 字符。引用可用性在点击时重新检查。</p>
      {manifest.omitted && <p className="mt-1 text-amber-600">已达到片段或字数上限，部分来源未纳入本次回答。</p>}
      <ul className="mt-2 space-y-2">{manifest.citations.map(citation => <li key={citation.id}>
        <KnowledgeCitationLink executionId={executionId} citationId={citation.id}>
          {citation.title} · {citation.locator}
        </KnowledgeCitationLink>
        <span className="ml-2 text-app-muted">{knowledgeScopeLabels[citation.scope]}</span>
      </li>)}</ul>
    </>}
  </details>;
}
