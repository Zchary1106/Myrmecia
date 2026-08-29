import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen, Clock3, Database, MoreHorizontal, Network, Plus, RefreshCw,
  Search, SlidersHorizontal, Star, Trash2, Users, X,
} from 'lucide-react';
import { api, type MemoryItemDTO, type ScoredMemoryDTO } from '../lib/api';
import { KnowledgeGraphPanel } from '../components/memory/KnowledgeGraphPanel';
import { cn } from '../lib/utils';

type MemoryView = 'all' | 'short' | 'long' | 'shared' | 'favorites' | 'graph';

const typeLabels: Record<string, string> = {
  semantic: 'Fact',
  episodic: 'Experience',
  procedural: 'Procedure',
  working: 'Temporary',
};

const typeStyles: Record<string, string> = {
  semantic: 'bg-emerald-50 text-emerald-700',
  episodic: 'bg-blue-50 text-blue-700',
  procedural: 'bg-violet-50 text-violet-700',
  working: 'bg-amber-50 text-amber-700',
};

function metadata(item: MemoryItemDTO) {
  return (item.metadata || {}) as Record<string, unknown>;
}

function metaText(item: MemoryItemDTO, ...keys: string[]) {
  const data = metadata(item);
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function titleOf(item: MemoryItemDTO) {
  const explicit = metaText(item, 'title', 'name');
  if (explicit) return explicit;
  const firstLine = (item.summary || item.content).split('\n')[0]?.trim() || 'Untitled knowledge';
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
}

function descriptionOf(item: MemoryItemDTO) {
  const text = item.summary || item.content;
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

function sourceOf(item: MemoryItemDTO) {
  return metaText(item, 'source', 'evidenceKind') || (item.type === 'working' ? 'Current task' : 'Agent memory');
}

function agentOf(item: MemoryItemDTO) {
  return metaText(item, 'agentName', 'agentId', 'agent') || 'Shared workspace';
}

function isShared(item: MemoryItemDTO) {
  const scope = metaText(item, 'scope', 'visibility');
  return scope === 'shared' || scope === 'workspace' || !metaText(item, 'agentId');
}

function isFavorite(item: MemoryItemDTO) {
  return metadata(item).favorite === true;
}

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} day${days === 1 ? '' : 's'} ago` : new Date(value).toLocaleDateString();
}

export function MemoryPage() {
  const [items, setItems] = useState<MemoryItemDTO[]>([]);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.memory.stats>> | null>(null);
  const [view, setView] = useState<MemoryView>('graph');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [agentFilter, setAgentFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ScoredMemoryDTO[] | null>(null);
  const [selected, setSelected] = useState<MemoryItemDTO | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setError('');
      const [list, nextStats] = await Promise.all([api.memory.list({ limit: 200 }), api.memory.stats()]);
      setItems(list);
      setStats(nextStats);
      setSelected(current => current ? list.find(item => item.id === current.id) || null : list[0] || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load workspace knowledge');
    }
  };

  useEffect(() => { void load(); }, []);

  const runSearch = async () => {
    if (!query.trim()) { setSearchResults(null); return; }
    setBusy(true);
    try {
      setError('');
      setSearchResults(await api.memory.recall(query.trim(), undefined, 50));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally { setBusy(false); }
  };

  const addMemory = async () => {
    if (!newContent.trim()) return;
    setBusy(true);
    try {
      await api.memory.add(newContent.trim(), { type: 'semantic', importance: 0.7 });
      setNewContent('');
      setShowAdd(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add knowledge');
    } finally { setBusy(false); }
  };

  const removeMemory = async (item: MemoryItemDTO) => {
    setBusy(true);
    try {
      await api.memory.remove(item.id);
      if (selected?.id === item.id) setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete knowledge');
    } finally { setBusy(false); }
  };

  const sources = useMemo(() => [...new Set(items.map(sourceOf))].sort(), [items]);
  const agents = useMemo(() => [...new Set(items.map(agentOf))].sort(), [items]);
  const displayed = useMemo(() => {
    const base = searchResults ? searchResults.map(result => result.item) : items;
    return base.filter(item => {
      if (view === 'short' && item.type !== 'working') return false;
      if (view === 'long' && item.type === 'working') return false;
      if (view === 'shared' && !isShared(item)) return false;
      if (view === 'favorites' && !isFavorite(item)) return false;
      if (typeFilter !== 'all' && item.type !== typeFilter) return false;
      if (sourceFilter !== 'all' && sourceOf(item) !== sourceFilter) return false;
      if (agentFilter !== 'all' && agentOf(item) !== agentFilter) return false;
      return true;
    });
  }, [agentFilter, items, searchResults, sourceFilter, typeFilter, view]);

  const workingCount = stats?.counts.working ?? items.filter(item => item.type === 'working').length;
  const longTermCount = items.length - workingCount;
  const sharedCount = items.filter(isShared).length;
  const related = selected
    ? items.filter(item => item.id !== selected.id && (item.type === selected.type || agentOf(item) === agentOf(selected))).slice(0, 3)
    : [];

  const tabs: Array<{ id: MemoryView; label: string }> = [
    { id: 'graph', label: 'Knowledge graph' }, { id: 'all', label: 'Knowledge library' }, { id: 'short', label: 'Short-term' },
    { id: 'long', label: 'Long-term' }, { id: 'shared', label: 'Shared' },
    { id: 'favorites', label: 'Favorites' },
  ];

  return (
    <div className="page-shell space-y-6">
      <header className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">Workspace knowledge</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-app-primary">Memory</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-app-muted">Review what your agents know, where it came from, and when it was last used.</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:justify-end">
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-app bg-app-panel px-3 shadow-sm sm:min-w-[17rem] xl:flex-none">
            <Search size={15} className="text-app-muted" />
            <input value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setSearchResults(null); }} onKeyDown={event => { if (event.key === 'Enter') void runSearch(); }} placeholder="Search workspace knowledge…" aria-label="Search workspace knowledge" className="min-w-0 flex-1 bg-transparent text-sm text-app-primary outline-none placeholder:text-app-muted" />
            <button type="button" onClick={() => void runSearch()} disabled={busy} className="text-xs font-medium text-accent hover:opacity-75">Search</button>
          </div>
          <button type="button" onClick={() => void load()} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-app bg-app-panel text-app-secondary shadow-sm transition-colors hover:bg-app-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label="Refresh memory"><RefreshCw size={16} /></button>
          <button type="button" onClick={() => setShowAdd(true)} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><Plus size={15} /> Add knowledge</button>
        </div>
      </header>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Memory summary">
        <SummaryCard label="Total knowledge" value={stats?.total ?? items.length} helper="Available across this workspace" icon={Database} tone="violet" />
        <SummaryCard label="Short-term" value={workingCount} helper="Current task context" icon={Clock3} tone="purple" />
        <SummaryCard label="Long-term" value={longTermCount} helper="Facts, experiences, and procedures" icon={BookOpen} tone="green" />
        <SummaryCard label="Shared knowledge" value={sharedCount} helper="Available to multiple agents" icon={Users} tone="blue" />
      </section>

      <nav className="flex gap-6 overflow-x-auto border-b border-app" aria-label="Memory views">
        {tabs.map(tab => <button key={tab.id} type="button" onClick={() => setView(tab.id)} className={cn('whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-medium transition-colors', view === tab.id ? 'border-accent text-accent' : 'border-transparent text-app-muted hover:text-app-primary')}>{tab.label}</button>)}
      </nav>

      {view === 'graph' ? (
        <section className="surface-panel overflow-hidden p-5">
          <div className="mb-5 flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold text-app-primary">Workspace knowledge map</h2><p className="mt-1 max-w-2xl text-sm text-app-muted">A focused view of the most important knowledge and its relationships. Open Knowledge library when you need the full record list.</p></div><Network size={20} className="text-accent" /></div>
          <KnowledgeGraphPanel />
        </section>
      ) : (
        <div className={cn('grid min-w-0 gap-5', selected ? 'xl:grid-cols-[minmax(0,1fr)_22rem]' : 'grid-cols-1')}>
          <section className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <FilterSelect label="All agents" value={agentFilter} onChange={setAgentFilter} options={agents} />
              <FilterSelect label="All types" value={typeFilter} onChange={setTypeFilter} options={Object.keys(typeLabels)} labels={typeLabels} />
              <FilterSelect label="All sources" value={sourceFilter} onChange={setSourceFilter} options={sources} />
              <div className="ml-auto flex items-center gap-2 text-xs text-app-muted"><SlidersHorizontal size={14} /> {displayed.length} results</div>
            </div>

            <div className="surface-panel overflow-hidden">
              <div className="hidden grid-cols-[minmax(15rem,2fr)_1fr_1fr_7rem_7rem_2rem] gap-4 border-b border-app bg-app-subtle px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-app-muted lg:grid"><span>Knowledge</span><span>Agent</span><span>Source</span><span>Type</span><span>Updated</span><span /></div>
              {displayed.map(item => (
                <article key={item.id} onClick={() => setSelected(item)} className={cn('grid cursor-pointer gap-3 border-b border-app px-5 py-4 transition-colors last:border-b-0 hover:bg-app-subtle lg:grid-cols-[minmax(15rem,2fr)_1fr_1fr_7rem_7rem_2rem] lg:items-center lg:gap-4', selected?.id === item.id && 'bg-accent/[0.045]')}>
                  <div className="flex min-w-0 gap-3"><Star size={15} className={cn('mt-1 shrink-0', isFavorite(item) ? 'fill-amber-400 text-amber-400' : 'text-app-faint')} /><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-app-primary">{titleOf(item)}</h3><p className="mt-1 truncate text-xs text-app-muted">{descriptionOf(item)}</p></div></div>
                  <div className="text-xs"><div className="font-medium text-app-secondary">{agentOf(item)}</div><div className="mt-1 text-app-muted">{isShared(item) ? 'Workspace' : 'Assigned agent'}</div></div>
                  <div className="text-xs"><div className="font-medium text-app-secondary">{sourceOf(item)}</div><div className="mt-1 text-app-muted">{new Date(item.createdAt).toLocaleDateString()}</div></div>
                  <div><span className={cn('rounded-md px-2 py-1 text-[10px] font-medium', typeStyles[item.type] || 'bg-app-subtle text-app-muted')}>{typeLabels[item.type] || item.type}</span></div>
                  <div className="text-xs text-app-muted">{relativeTime(item.createdAt)}</div><MoreHorizontal size={16} className="text-app-muted" />
                </article>
              ))}
              {displayed.length === 0 && <div className="px-6 py-16 text-center"><BookOpen size={28} className="mx-auto text-app-faint" /><h3 className="mt-3 text-sm font-semibold text-app-primary">No knowledge found</h3><p className="mt-1 text-xs text-app-muted">Try another filter or add a fact your agents should remember.</p></div>}
            </div>
          </section>

          {selected && (
            <aside className="surface-panel h-fit overflow-hidden xl:sticky xl:top-5" aria-label="Memory details">
              <div className="flex items-center justify-between border-b border-app px-5 py-4"><h2 className="text-sm font-semibold text-app-primary">Knowledge details</h2><button type="button" onClick={() => setSelected(null)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-app-muted transition hover:bg-app-hover hover:text-app-primary" aria-label="Close memory details"><X size={15} /></button></div>
              <div className="space-y-5 p-5">
                <div><div className="flex items-start justify-between gap-3"><h3 className="text-base font-semibold leading-snug text-app-primary">{titleOf(selected)}</h3><span className={cn('rounded-md px-2 py-1 text-[10px] font-medium', typeStyles[selected.type])}>{typeLabels[selected.type] || selected.type}</span></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-app-secondary">{selected.content}</p></div>
                <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-3 border-y border-app py-4 text-xs">
                  <dt className="text-app-muted">Agent</dt><dd className="font-medium text-app-secondary">{agentOf(selected)}</dd><dt className="text-app-muted">Source</dt><dd className="font-medium text-app-secondary">{sourceOf(selected)}</dd><dt className="text-app-muted">Created</dt><dd className="font-medium text-app-secondary">{new Date(selected.createdAt).toLocaleString()}</dd><dt className="text-app-muted">Importance</dt><dd><Importance value={selected.importance} /></dd><dt className="text-app-muted">Used</dt><dd className="font-medium text-app-secondary">{selected.accessCount} times</dd>
                </dl>
                <div><div className="mb-2 flex items-center justify-between"><h4 className="text-xs font-semibold text-app-primary">Related knowledge</h4><button type="button" onClick={() => setView('graph')} className="text-[11px] font-medium text-accent">View graph</button></div><div className="space-y-2">{related.map(item => <button key={item.id} type="button" onClick={() => setSelected(item)} className="flex w-full items-center justify-between rounded-lg bg-app-subtle px-3 py-2 text-left text-xs text-app-secondary hover:bg-app-hover"><span className="truncate">{titleOf(item)}</span><span className="ml-3 text-[10px] text-app-muted">{typeLabels[item.type]}</span></button>)}{related.length === 0 && <p className="text-xs text-app-muted">No related knowledge yet.</p>}</div></div>
                <button type="button" onClick={() => void removeMemory(selected)} disabled={busy} className="flex items-center gap-2 text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-40"><Trash2 size={14} /> Delete knowledge</button>
              </div>
            </aside>
          )}
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/25 p-4 backdrop-blur-sm" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowAdd(false); }}>
          <section className="w-full max-w-lg rounded-2xl border border-app bg-app-panel p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="add-knowledge-title">
            <div className="flex items-center justify-between"><div><h2 id="add-knowledge-title" className="text-lg font-semibold text-app-primary">Add workspace knowledge</h2><p className="mt-1 text-sm text-app-muted">Add a fact or preference agents should use in future work.</p></div><button type="button" onClick={() => setShowAdd(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-app-muted transition hover:bg-app-hover hover:text-app-primary" aria-label="Close add knowledge"><X size={16} /></button></div>
            <textarea value={newContent} onChange={event => setNewContent(event.target.value)} rows={6} autoFocus placeholder="For example: Use pnpm for this repository and run the dashboard tests before opening a PR." className="field mt-5 w-full resize-none text-sm" />
            <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setShowAdd(false)} className="inline-flex h-10 items-center rounded-xl border border-app bg-app-panel px-4 text-sm font-medium text-app-secondary transition hover:bg-app-hover">Cancel</button><button type="button" onClick={() => void addMemory()} disabled={busy || !newContent.trim()} className="inline-flex h-10 items-center rounded-xl bg-accent px-4 text-sm font-semibold text-white transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40">Add knowledge</button></div>
          </section>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, helper, icon: Icon, tone }: { label: string; value: number; helper: string; icon: typeof Database; tone: 'violet' | 'purple' | 'green' | 'blue' }) {
  const toneClass = { violet: 'bg-indigo-50 text-indigo-600', purple: 'bg-violet-50 text-violet-600', green: 'bg-emerald-50 text-emerald-600', blue: 'bg-blue-50 text-blue-600' }[tone];
  return <article className="surface-panel p-5"><div className="flex items-start justify-between"><div><p className="text-xs font-medium text-app-muted">{label}</p><p className="mt-3 text-2xl font-semibold tabular-nums tracking-tight text-app-primary">{value.toLocaleString()}</p></div><span className={cn('rounded-xl p-2.5', toneClass)}><Icon size={18} /></span></div><p className="mt-4 text-xs text-app-muted">{helper}</p></article>;
}

function FilterSelect({ label, value, onChange, options, labels }: { label: string; value: string; onChange: (value: string) => void; options: string[]; labels?: Record<string, string> }) {
  return <select aria-label={label} value={value} onChange={event => onChange(event.target.value)} className="rounded-lg border border-app bg-app-panel px-3 py-2 text-xs text-app-secondary outline-none focus:border-accent"><option value="all">{label}</option>{options.map(option => <option key={option} value={option}>{labels?.[option] || option}</option>)}</select>;
}

function Importance({ value }: { value: number }) {
  const filled = Math.max(1, Math.round(value * 5));
  return <span className="inline-flex gap-1" aria-label={`Importance ${filled} of 5`}>{[1, 2, 3, 4, 5].map(index => <span key={index} className={cn('h-2 w-2 rounded-full', index <= filled ? 'bg-amber-400' : 'bg-app-hover')} />)}</span>;
}
