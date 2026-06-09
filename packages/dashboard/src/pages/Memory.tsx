import { useEffect, useMemo, useState } from 'react';
import { api, type MemoryItemDTO, type ScoredMemoryDTO } from '../lib/api';
import { cn } from '../lib/utils';

const TYPES = ['semantic', 'episodic', 'procedural', 'working'] as const;
type MemType = (typeof TYPES)[number];

const typeClass: Record<MemType, string> = {
  semantic: 'border-blue-500/20 bg-blue-500/10 text-blue-300',
  episodic: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  procedural: 'border-purple-500/20 bg-purple-500/10 text-purple-300',
  working: 'border-gray-500/20 bg-gray-500/10 text-gray-300',
};

export function MemoryPage() {
  const [items, setItems] = useState<MemoryItemDTO[]>([]);
  const [stats, setStats] = useState<{ counts: Record<string, number>; total: number } | null>(null);
  const [filter, setFilter] = useState<'all' | MemType>('all');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ScoredMemoryDTO[] | null>(null);
  const [newContent, setNewContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const [list, s] = await Promise.all([api.memory.list({ limit: 200 }), api.memory.stats()]);
      setItems(list);
      setStats(s);
    } catch (err: any) {
      setError(err.message || 'Load memory failed');
    }
  };

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter(i => i.type === filter)),
    [items, filter],
  );

  const runSearch = async () => {
    if (!query.trim()) { setSearchResults(null); return; }
    setBusy(true);
    setError('');
    try {
      setSearchResults(await api.memory.recall(query.trim(), undefined, 10));
    } catch (err: any) {
      setError(err.message || 'Recall failed');
    } finally {
      setBusy(false);
    }
  };

  const addMemory = async () => {
    if (!newContent.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.memory.add(newContent.trim(), { type: 'semantic', importance: 0.7 });
      setNewContent('');
      await load();
    } catch (err: any) {
      setError(err.message || 'Add memory failed');
    } finally {
      setBusy(false);
    }
  };

  const forget = async (id: string) => {
    setError('');
    try {
      await api.memory.remove(id);
      setItems(prev => prev.filter(i => i.id !== id));
      setSearchResults(prev => (prev ? prev.filter(r => r.item.id !== id) : prev));
    } catch (err: any) {
      setError(err.message || 'Forget failed');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="rounded-2xl border border-border bg-gradient-to-br from-surface to-background p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.24em] text-accent-light">Memory</div>
            <h2 className="mt-2 text-3xl font-bold">Unified Memory</h2>
            <p className="mt-2 max-w-2xl text-sm text-gray-400">
              平台的长期记忆：语义事实、历史执行（episodic）、可复用经验（procedural）。Agent 在路由、分解和 Pipeline 执行时会自动召回。
            </p>
          </div>
          <button onClick={load} className="rounded-xl bg-surface-hover px-4 py-2 text-sm text-gray-300 hover:text-white">
            Refresh
          </button>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Metric label="Total" value={stats?.total ?? 0} />
          <Metric label="Semantic" value={stats?.counts.semantic ?? 0} tone="blue" />
          <Metric label="Episodic" value={stats?.counts.episodic ?? 0} tone="green" />
          <Metric label="Procedural" value={stats?.counts.procedural ?? 0} tone="purple" />
          <Metric label="Working" value={stats?.counts.working ?? 0} />
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        {/* Left: browse / list */}
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(['all', ...TYPES] as const).map(t => (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-xs',
                  filter === t ? 'border-accent/50 bg-accent/15 text-accent-light' : 'border-border bg-surface text-gray-400 hover:text-gray-200',
                )}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            {filtered.map(item => (
              <MemoryRow key={item.id} item={item} onForget={() => forget(item.id)} />
            ))}
            {filtered.length === 0 && (
              <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-gray-600">
                No memories yet
              </div>
            )}
          </div>
        </div>

        {/* Right: search + add */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-border bg-surface p-5">
            <h3 className="text-sm font-semibold text-gray-300">Semantic Recall</h3>
            <div className="mt-3 flex gap-2">
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void runSearch(); }}
                placeholder="What did we do for X?"
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <button onClick={runSearch} disabled={busy} className="rounded-lg bg-accent/15 px-3 py-2 text-xs font-semibold text-accent-light hover:bg-accent/25">
                Recall
              </button>
            </div>
            {searchResults && (
              <div className="mt-3 space-y-2">
                {searchResults.map(({ item, score }) => (
                  <div key={item.id} className="rounded-lg border border-border bg-background p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', typeClass[item.type as MemType])}>{item.type}</span>
                      <span className="text-[10px] text-gray-500">score {score.toFixed(2)}</span>
                    </div>
                    <p className="mt-2 line-clamp-3 text-xs text-gray-400">{item.summary || item.content}</p>
                  </div>
                ))}
                {searchResults.length === 0 && <div className="text-xs text-gray-600">No matches</div>}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-surface p-5">
            <h3 className="text-sm font-semibold text-gray-300">Add Fact / Preference</h3>
            <textarea
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              rows={3}
              placeholder="e.g. The team prefers TypeScript and pnpm workspaces."
              className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button onClick={addMemory} disabled={busy || !newContent.trim()} className="mt-2 w-full rounded-lg bg-accent/15 px-3 py-2 text-xs font-semibold text-accent-light hover:bg-accent/25 disabled:opacity-40">
              Remember
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MemoryRow({ item, onForget }: { item: MemoryItemDTO; onForget: () => void }) {
  const agent = (item.metadata as any)?.agentId as string | undefined;
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold', typeClass[item.type as MemType])}>{item.type}</span>
          {agent && <span className="rounded bg-background px-1.5 py-0.5 text-[10px] text-gray-500">{agent}</span>}
          <span className="text-[10px] text-gray-600">imp {item.importance.toFixed(2)} · used {item.accessCount}</span>
        </div>
        <button onClick={onForget} className="text-[11px] text-gray-600 hover:text-red-300">Forget</button>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-gray-400">{item.summary || item.content}</p>
      <div className="mt-2 text-[10px] text-gray-600">{new Date(item.createdAt).toLocaleString()}</div>
    </div>
  );
}

function Metric({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'blue' | 'green' | 'purple' }) {
  const toneClass = {
    default: 'text-gray-100',
    blue: 'text-blue-300',
    green: 'text-emerald-300',
    purple: 'text-purple-300',
  }[tone];
  return (
    <div className="rounded-xl border border-border bg-background/70 p-4">
      <div className={cn('text-2xl font-bold', toneClass)}>{value}</div>
      <div className="mt-1 text-[10px] text-gray-500">{label}</div>
    </div>
  );
}
