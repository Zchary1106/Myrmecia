import { useEffect, useMemo, useState } from 'react';
import { Check, Link2, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';

type Node = { id: string; content: string; summary?: string };
type Suggestion = { sourceId: string; targetId: string; relation: string; confidence: number; reason: string };
type Graph = { nodes: Node[] };

const root = '/api/v1/memory';

function label(node: Node | undefined) {
  const text = (node?.summary || node?.content || 'Unknown memory').replace(/\s+/g, ' ').trim();
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}
export function RelationshipSuggestions({ onChanged }: { onChanged: () => void }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setError('');
      const [suggestionResponse, graphResponse] = await Promise.all([
        fetch(root + '/graph/suggestions?limit=12', { credentials: 'include' }),
        fetch(root + '/graph?limit=160', { credentials: 'include' }),
      ]);
      if (!suggestionResponse.ok || !graphResponse.ok) throw new Error('Unable to load relationship suggestions');
      setSuggestions(await suggestionResponse.json() as Suggestion[]);
      setNodes((await graphResponse.json() as Graph).nodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load relationship suggestions');
    }
  };

  useEffect(() => { void load(); }, []);
  const nodeById = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);

  const confirm = async (suggestion: Suggestion) => {
    const id = `${suggestion.sourceId}:${suggestion.targetId}`;
    setBusyId(id);
    try {
      const response = await fetch(root + '/graph/suggestions/confirm', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceId: suggestion.sourceId,
          targetId: suggestion.targetId,
          relation: suggestion.relation,
          weight: suggestion.confidence,
        }),
      });
      if (!response.ok) throw new Error('Unable to confirm relationship');
      setSuggestions(current => current.filter(item => item !== suggestion));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to confirm relationship');
    } finally {
      setBusyId('');
    }
  };

  return (
    <details className="knowledge-review-panel group rounded-xl border border-border bg-background/55">
      <summary className="app-focus flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3.5 py-3 text-left">
        <div className="min-w-0"><div className="flex items-center gap-2 text-xs font-semibold text-app-primary"><Link2 size={14} className="text-accent-light" /> Suggested links</div><p className="mt-0.5 truncate text-[10px] text-app-muted">Review high-confidence relationships before adding them.</p></div>
        {suggestions.length > 0 && <span className="shrink-0 rounded-full bg-accent/10 px-2 py-1 text-[10px] font-semibold text-accent-light">{suggestions.length}</span>}
      </summary>
      <div className="border-t border-border p-3">
        <div className="mb-2 flex justify-end">
          <button type="button" onClick={() => void load()} disabled={Boolean(busyId)} className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[10px] font-medium text-app-muted hover:bg-surface-hover hover:text-app-primary" aria-label="Refresh relationship suggestions"><RefreshCw size={12} /> Refresh</button>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {suggestions.length > 0 ? <div className="space-y-2">{suggestions.map(suggestion => {
        const id = `${suggestion.sourceId}:${suggestion.targetId}`;
        return <div key={id} className="flex items-center gap-2 rounded-lg border border-border/70 bg-surface px-3 py-2.5 text-xs"><div className="min-w-0 flex-1"><div className="truncate font-medium text-app-secondary">{label(nodeById.get(suggestion.sourceId))} <span className="mx-1 text-app-muted">↔</span> {label(nodeById.get(suggestion.targetId))}</div><div className="mt-1 text-app-muted">{suggestion.reason} · {Math.round(suggestion.confidence * 100)}% confidence</div></div><button type="button" onClick={() => void confirm(suggestion)} disabled={busyId === id} className={cn('inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-accent-light disabled:opacity-50')}><Check size={13} /> Confirm</button></div>;
      })}</div> : !error && <p className="text-xs text-app-muted">No high-confidence links found yet.</p>}
      </div>
    </details>
  );
}
