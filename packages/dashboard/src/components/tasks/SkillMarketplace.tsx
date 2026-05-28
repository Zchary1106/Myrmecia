import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

interface RegistrySource {
  id: string;
  name: string;
  type: string;
  url: string;
  lastSyncedAt?: string;
  enabled: boolean;
}

interface CatalogEntry {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  path: string;
  tags: string[];
  isStructured: boolean;
}

export function SkillMarketplace() {
  const [sources, setSources] = useState<RegistrySource[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Add source form
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newType, setNewType] = useState<'github' | 'http'>('github');
  const [newPrefix, setNewPrefix] = useState('');

  const loadData = async () => {
    try {
      const [s, c] = await Promise.all([
        api.skills.registry.sources(),
        api.skills.registry.browse(search ? { search } : undefined),
      ]);
      setSources(s);
      setCatalog(c);
    } catch (err: any) {
      setError(err.message || 'Failed to load registry');
    }
  };

  useEffect(() => { void loadData(); }, []);

  const handleSearch = () => {
    api.skills.registry.browse(search ? { search } : undefined)
      .then(setCatalog)
      .catch((err: any) => setError(err.message));
  };

  const handleSync = async (sourceId: string) => {
    setSyncing(sourceId);
    setError('');
    setSuccess('');
    try {
      const result = await api.skills.registry.sync(sourceId);
      setSuccess(`Synced: ${result.added} added, ${result.updated} updated`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Sync failed');
    } finally {
      setSyncing(null);
    }
  };

  const handleImport = async (catalogId: string) => {
    setImporting(catalogId);
    setError('');
    setSuccess('');
    try {
      const result = await api.skills.registry.import(catalogId);
      setSuccess(`Imported skill "${result.skillId}" (version: ${result.versionId})`);
    } catch (err: any) {
      setError(err.message || 'Import failed');
    } finally {
      setImporting(null);
    }
  };

  const handleAddSource = async () => {
    if (!newName || !newUrl) return;
    setError('');
    try {
      await api.skills.registry.addSource({
        name: newName,
        type: newType,
        url: newUrl,
        pathPrefix: newPrefix || undefined,
      });
      setShowAddSource(false);
      setNewName('');
      setNewUrl('');
      setNewPrefix('');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Add source failed');
    }
  };

  const handleDeleteSource = async (id: string) => {
    try {
      await api.skills.registry.deleteSource(id);
      await loadData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="space-y-4">
      {/* Sources */}
      <div className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-300">Registry Sources</h3>
          <button
            onClick={() => setShowAddSource(!showAddSource)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
          >
            + Add Source
          </button>
        </div>

        {showAddSource && (
          <div className="mb-4 rounded-lg border border-border bg-background p-3 space-y-2">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Source name" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
            <div className="flex gap-2">
              <select value={newType} onChange={e => setNewType(e.target.value as any)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none">
                <option value="github">GitHub</option>
                <option value="http">HTTP</option>
              </select>
              <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="https://github.com/owner/repo" className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
            </div>
            <input value={newPrefix} onChange={e => setNewPrefix(e.target.value)} placeholder="Path prefix (optional, e.g. skills/)" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
            <div className="flex gap-2">
              <button onClick={handleAddSource} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white">Save</button>
              <button onClick={() => setShowAddSource(false)} className="rounded-lg bg-surface-hover px-3 py-1.5 text-xs text-gray-400">Cancel</button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {sources.map(source => (
            <div key={source.id} className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
              <div>
                <span className="text-xs font-semibold">{source.name}</span>
                <span className="ml-2 text-[10px] text-gray-500">{source.type} · {source.url.replace('https://', '').slice(0, 40)}</span>
                {source.lastSyncedAt && <span className="ml-2 text-[10px] text-gray-600">synced {new Date(source.lastSyncedAt).toLocaleDateString()}</span>}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleSync(source.id)}
                  disabled={syncing === source.id}
                  className="rounded-lg bg-blue-500/20 px-2.5 py-1 text-[10px] text-blue-300 hover:bg-blue-500/30 disabled:opacity-50"
                >
                  {syncing === source.id ? 'Syncing...' : 'Sync'}
                </button>
                <button
                  onClick={() => handleDeleteSource(source.id)}
                  className="rounded-lg bg-red-500/20 px-2.5 py-1 text-[10px] text-red-300 hover:bg-red-500/30"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          {sources.length === 0 && <p className="text-xs text-gray-600 text-center py-2">No sources configured</p>}
        </div>
      </div>

      {/* Messages */}
      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-2 text-xs text-red-300">{error}</div>}
      {success && <div className="rounded-lg border border-green-500/20 bg-green-500/10 p-2 text-xs text-green-300">{success}</div>}

      {/* Search & Browse */}
      <div className="rounded-xl border border-border bg-surface p-4">
        <div className="flex gap-2 mb-4">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Search skills..."
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button onClick={handleSearch} className="rounded-lg bg-surface-hover px-4 py-2 text-xs text-gray-300 hover:text-white">Search</button>
        </div>

        {catalog.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <div className="text-3xl mb-2">📦</div>
            <p className="text-xs">No skills found. Sync a source to populate the catalog.</p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {catalog.map(entry => (
              <div key={entry.id} className="rounded-xl border border-border bg-background p-4 flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h4 className="text-sm font-semibold text-gray-200 truncate">{entry.name}</h4>
                  {entry.isStructured && (
                    <span className="flex-shrink-0 rounded-full bg-accent/20 border border-accent/30 px-2 py-0.5 text-[9px] text-accent-light">step-driven</span>
                  )}
                </div>
                <p className="text-[11px] text-gray-500 mb-3 line-clamp-2 flex-1">{entry.description || 'No description'}</p>
                <div className="flex flex-wrap gap-1 mb-3">
                  {entry.tags.slice(0, 4).map(tag => (
                    <span key={tag} className="rounded-full bg-surface-hover px-2 py-0.5 text-[9px] text-gray-400">{tag}</span>
                  ))}
                </div>
                <button
                  onClick={() => handleImport(entry.id)}
                  disabled={importing === entry.id}
                  className={cn(
                    'w-full rounded-lg py-2 text-xs font-medium transition',
                    importing === entry.id
                      ? 'bg-gray-500/20 text-gray-500'
                      : 'bg-accent/20 text-accent-light hover:bg-accent/30',
                  )}
                >
                  {importing === entry.id ? 'Importing...' : 'Import'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
