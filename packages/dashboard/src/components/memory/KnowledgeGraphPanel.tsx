import { useEffect, useMemo, useState } from 'react';
import { MemoryGraphCanvas } from './MemoryGraphCanvas';

type Relation = 'supports' | 'derived_from' | 'contradicts' | 'related_to' | 'part_of' | 'produced_by';
type GraphNode = { id: string; type: string; content: string; summary?: string; importance: number };
type GraphEdge = { sourceId: string; targetId: string; relation: Relation; weight: number };
type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };
type Candidate = { item: GraphNode & { metadata?: Record<string, unknown> }; taskId?: string; evidenceKind?: string };

const relations: Relation[] = ['supports', 'derived_from', 'contradicts', 'related_to', 'part_of', 'produced_by'];
const apiRoot = '/api/v1/memory';

export function KnowledgeGraphPanel() {
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [relation, setRelation] = useState<Relation>('related_to');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);

  const refresh = async () => {
    setBusy(true);
    try {
      const [graphResponse, candidateResponse] = await Promise.all([
        fetch(apiRoot + '/graph?limit=80', { credentials: 'include' }),
        fetch(apiRoot + '/candidates?limit=40', { credentials: 'include' }),
      ]);
      if (!graphResponse.ok || !candidateResponse.ok) throw new Error('Unable to load knowledge graph');
      const next = await graphResponse.json() as Graph;
      const nodes = [...next.nodes]
        .sort((left, right) => right.importance - left.importance)
        .slice(0, 48);
      const visibleIds = new Set(nodes.map(node => node.id));
      setCandidates(await candidateResponse.json() as Candidate[]);
      setGraph({
        nodes,
        edges: next.edges.filter(edge => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)),
      });
      setSourceId(current => current || next.nodes[0]?.id || '');
      setTargetId(current => current || next.nodes[1]?.id || next.nodes[0]?.id || '');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load knowledge graph');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const positions = useMemo(() => {
    const radius = 118;
    const center = 150;
    return new Map(graph.nodes.map((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(graph.nodes.length, 1) - Math.PI / 2;
      return [node.id, { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) }];
    }));
  }, [graph.nodes]);
  const selected = graph.nodes.find(node => node.id === selectedId);
  const selectedEdges = graph.edges.filter(edge => edge.sourceId === selectedId || edge.targetId === selectedId);

  useEffect(() => {
    if (selected) setEditContent(selected.content);
    setEditing(false);
  }, [selectedId]);

  const createEdge = async () => {
    if (!sourceId || !targetId || sourceId === targetId) {
      setError('Choose two different memories.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(apiRoot + '/graph/edges', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId, targetId, relation }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error?.message || 'Unable to create relationship');
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create relationship');
    } finally {
      setBusy(false);
    }
  };

  const updateSelected = async () => {
    if (!selected || !editContent.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(apiRoot + '/' + encodeURIComponent(selected.id), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent.trim() }),
      });
      if (!response.ok) throw new Error('Unable to update memory');
      setEditing(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update memory');
    } finally {
      setBusy(false);
    }
  };

  const removeEdge = async (edge: GraphEdge) => {
    setBusy(true);
    try {
      const path = [edge.sourceId, edge.targetId, edge.relation].map(encodeURIComponent).join('/');
      const response = await fetch(apiRoot + '/graph/edges/' + path, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Unable to remove relationship');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to remove relationship');
    } finally {
      setBusy(false);
    }
  };

  const decideCandidate = async (candidateId: string, confirm: boolean) => {
    setBusy(true);
    try {
      const response = await fetch(
        apiRoot + '/candidates/' + encodeURIComponent(candidateId) + (confirm ? '/confirm' : ''),
        { method: confirm ? 'POST' : 'DELETE', credentials: 'include' },
      );
      if (!response.ok) throw new Error('Unable to update knowledge candidate');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update knowledge candidate');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-5 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold">Focused knowledge topology · {graph.nodes.length} nodes</div>
          <div className="mt-0.5 text-[10px] text-gray-500">{graph.nodes.length} memories · {graph.edges.length} confirmed relationships</div>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy} className="rounded-md border border-border px-2.5 py-1.5 text-[10px] text-gray-400 hover:bg-surface-hover disabled:opacity-40">Refresh</button>
      </div>

      {error && <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[10px] text-red-300">{error}</div>}
      {candidates.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-300">Pending evidence ({candidates.length})</div>
          <div className="mt-2 max-h-40 space-y-2 overflow-auto">
            {candidates.map(candidate => (
              <div key={candidate.item.id} className="flex items-start justify-between gap-3 rounded-md border border-border bg-background px-2.5 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[10px] text-gray-300">{candidate.item.content}</div>
                  <div className="mt-0.5 text-[9px] text-gray-600">{candidate.evidenceKind || 'evidence'}{candidate.taskId ? ' · task ' + candidate.taskId : ''}</div>
                  {typeof candidate.item.metadata?.previewUrl === 'string' && <a href={candidate.item.metadata.previewUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[9px] text-accent-light hover:underline">View original evidence</a>}
                </div>
                <div className="flex flex-none gap-2">
                  <button type="button" aria-label={`Confirm ${candidate.item.content}`} onClick={() => void decideCandidate(candidate.item.id, true)} disabled={busy} className="text-[9px] text-emerald-300 hover:underline">Confirm</button>
                  <button type="button" aria-label={`Reject ${candidate.item.content}`} onClick={() => void decideCandidate(candidate.item.id, false)} disabled={busy} className="text-[9px] text-red-300 hover:underline">Reject</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {!busy && graph.nodes.length === 0 && <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-gray-500">Add memories to begin a knowledge graph.</div>}
      {graph.nodes.length > 0 && (
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_190px]">
          <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
<MemoryGraphCanvas nodes={graph.nodes} edges={graph.edges} selectedId={selectedId} onSelect={setSelectedId} />
          </div>
          <div className="rounded-lg border border-border bg-background p-3 text-[10px]">
            <div className="font-semibold text-gray-300">Selected memory</div>
            {selected ? (
              <>
                <div className="mt-2 text-gray-500">{selected.type} · importance {Math.round(selected.importance * 100)}%</div>
                {editing ? (
                  <>
                    <textarea value={editContent} onChange={event => setEditContent(event.target.value)} rows={5} className="field mt-2 w-full resize-y text-[10px]" />
                    <div className="mt-2 flex gap-2">
                      <button type="button" onClick={() => void updateSelected()} disabled={busy} className="rounded bg-accent/15 px-2 py-1 text-[10px] text-accent-light">Save</button>
                      <button type="button" onClick={() => setEditing(false)} className="text-[10px] text-gray-500">Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="mt-2 line-clamp-6 leading-relaxed text-gray-300">{selected.summary || selected.content}</p>
                    <button type="button" onClick={() => setEditing(true)} className="mt-2 text-[10px] text-accent-light hover:underline">Edit memory</button>
                  </>
                )}
                {selectedEdges.length > 0 && (
                  <div className="mt-3 border-t border-border pt-2">
                    <div className="text-[9px] uppercase tracking-wide text-gray-500">Relationships</div>
                    {selectedEdges.map(edge => (
                      <div key={edge.sourceId + edge.targetId + edge.relation} className="mt-1 flex items-center justify-between gap-1 text-[9px] text-gray-400">
                        <span className="truncate">{edge.relation.replace('_', ' ')}</span>
                        <button type="button" aria-label={`Remove ${edge.relation.replace('_', ' ')} relationship`} onClick={() => void removeEdge(edge)} disabled={busy} className="text-red-300 hover:underline">Remove</button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : <p className="mt-2 text-gray-500">Click a node to inspect it.</p>}
          </div>
        </div>
      )}

      {graph.nodes.length > 1 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <select aria-label="Relationship source memory" value={sourceId} onChange={event => setSourceId(event.target.value)} className="field text-xs">{graph.nodes.map(node => <option key={node.id} value={node.id}>{node.content.slice(0, 34)}</option>)}</select>
          <select aria-label="Relationship type" value={relation} onChange={event => setRelation(event.target.value as Relation)} className="field text-xs">{relations.map(item => <option key={item} value={item}>{item.replace('_', ' ')}</option>)}</select>
          <select aria-label="Relationship target memory" value={targetId} onChange={event => setTargetId(event.target.value)} className="field text-xs">{graph.nodes.map(node => <option key={node.id} value={node.id}>{node.content.slice(0, 34)}</option>)}</select>
          <button type="button" onClick={() => void createEdge()} disabled={busy} className="rounded-lg bg-accent/15 px-3 py-2 text-xs font-semibold text-accent-light hover:bg-accent/25 disabled:opacity-40">Link memories</button>
        </div>
      )}
    </section>
  );
}
