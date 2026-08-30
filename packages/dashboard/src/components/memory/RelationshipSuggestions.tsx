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
    <section className="rounded-xl border border-amber-200 bg-amber-50/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div><div className="flex items-center gap-2 text-sm font-semibold text-amber-900"><Link2 size={15} /> Suggested links</div><p className="mt-1 text-xs leading-5 text-amber-800">Generated from shared task, artifact, session, and topic evidence. Confirm before adding an edge.</p></div>
        <button type="button" onClick={() => void load()} disabled={Boolean(busyId)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-amber-800 hover:bg-amber-100" aria-label="Refresh relationship suggestions"><RefreshCw size={14} /></button>
      </div>
      {error && <p className="mt-3 text-xs text-red-700">{error}</p>}
      {suggestions.length > 0 ? <div className="mt-3 space-y-2">{suggestions.map(suggestion => {
        const id = `${suggestion.sourceId}:${suggestion.targetId}`;
        return <div key={id} className="flex items-center gap-2 rounded-lg bg-white/80 px-3 py-2.5 text-xs shadow-sm"><div className="min-w-0 flex-1"><div className="truncate font-medium text-app-secondary">{label(nodeById.get(suggestion.sourceId))} <span className="mx-1 text-app-muted">↔</span> {label(nodeById.get(suggestion.targetId))}</div><div className="mt-1 text-app-muted">{suggestion.reason} · {Math.round(suggestion.confidence * 100)}% confidence</div></div><button type="button" onClick={() => void confirm(suggestion)} disabled={busyId === id} className={cn('inline-flex shrink-0 items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-amber-600 disabled:opacity-50')}><Check size={13} /> Confirm</button></div>;
      })}</div> : !error && <p className="mt-3 text-xs text-amber-800">No high-confidence links found yet.</p>}
    </section>
  );
}

