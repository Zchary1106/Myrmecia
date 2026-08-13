import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ExecutionArtifact } from '@myrmecia/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { cn } from '../lib/utils';

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function kindIcon(kind: ExecutionArtifact['kind']): string {
  return ({ image: '▧', video: '▶', audio: '♪', pdf: 'PDF', html: '◇', code: '</>', json: '{}', text: '¶', file: '□' })[kind];
}

export function ArtifactsPage() {
  const [artifacts, setArtifacts] = useState<ExecutionArtifact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [downloading, setDownloading] = useState(false);

  const selected = useMemo(
    () => artifacts.find(artifact => artifact.id === selectedId) || artifacts[0] || null,
    [artifacts, selectedId],
  );

  const load = useCallback(async () => {
    try {
      const next = await api.artifacts.workbench({ limit: 200 });
      setArtifacts(next);
      setSelectedId(current => current && next.some(item => item.id === current) ? current : next[0]?.id || null);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load artifacts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    wsClient.connect();
    wsClient.subscribe('artifacts');
    const refresh = () => void load();
    wsClient.on('artifact:published', refresh);
    return () => wsClient.off('artifact:published', refresh);
  }, [load]);

  useEffect(() => {
    let disposed = false;
    let objectUrl = '';
    setPreviewText('');
    setPreviewUrl('');
    if (!selected) return;
    api.artifacts.preview(selected.id).then(async blob => {
      if (disposed) return;
      if (['text', 'code', 'json', 'html'].includes(selected.kind)) {
        setPreviewText(await blob.text());
      } else {
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      }
    }).catch(err => {
      if (!disposed) setPreviewText(`Preview unavailable: ${err instanceof Error ? err.message : String(err)}`);
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selected?.id]);

  const downloadSelected = async () => {
    if (!selected) return;
    setDownloading(true);
    try {
      const blob = await api.artifacts.download(selected.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = selected.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col p-4 lg:p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent-light">Artifact Workbench</div>
          <h1 className="mt-1 text-2xl font-bold">Outputs you can actually inspect</h1>
          <p className="mt-1 text-sm text-gray-500">Execution results and generated workspace files appear here in real time.</p>
        </div>
        <button className="rounded-lg border border-border px-3 py-2 text-xs text-gray-300 hover:bg-surface-hover" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {error && <div role="alert" className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto rounded-2xl border border-border bg-surface p-2">
          {loading && <div className="p-5 text-center text-xs text-gray-500">Loading artifacts…</div>}
          {!loading && artifacts.length === 0 && (
            <div className="p-6 text-center">
              <div className="text-3xl">◫</div>
              <div className="mt-3 text-sm font-semibold">No artifacts yet</div>
              <p className="mt-1 text-xs text-gray-500">Run a task or pipeline. Results, images, video, documents and changed files will appear automatically.</p>
            </div>
          )}
          {artifacts.map(artifact => (
            <button
              key={artifact.id}
              type="button"
              onClick={() => setSelectedId(artifact.id)}
              className={cn(
                'mb-1 flex w-full gap-3 rounded-xl border px-3 py-3 text-left transition',
                selected?.id === artifact.id ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:border-border hover:bg-surface-hover',
              )}
            >
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-background text-xs text-accent-light">{kindIcon(artifact.kind)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{artifact.name}</span>
                <span className="mt-1 block truncate text-[10px] text-gray-600">{artifact.relativePath}</span>
                <span className="mt-1 block text-[9px] uppercase tracking-wide text-gray-700">{artifact.kind} · {formatBytes(artifact.sizeBytes)}</span>
              </span>
            </button>
          ))}
        </aside>

        <section className="flex min-h-[520px] min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface">
          {selected ? (
            <>
              <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-bold">{selected.name}</h2>
                  <p className="truncate text-[10px] text-gray-600">{selected.taskId} · {selected.executionId}</p>
                </div>
                <button
                  type="button"
                  disabled={downloading}
                  onClick={() => void downloadSelected()}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-gray-300 hover:bg-surface-hover disabled:opacity-50"
                >
                  {downloading ? 'Downloading…' : 'Download'}
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-auto bg-background/70 p-4">
                {selected.kind === 'image' && previewUrl && <img src={previewUrl} alt={selected.name} className="mx-auto max-h-full max-w-full rounded-xl object-contain shadow-2xl" />}
                {selected.kind === 'video' && previewUrl && <video src={previewUrl} controls className="mx-auto max-h-full max-w-full rounded-xl" />}
                {selected.kind === 'audio' && previewUrl && <audio src={previewUrl} controls className="mx-auto mt-16 w-full max-w-2xl" />}
                {selected.kind === 'pdf' && previewUrl && <iframe title={selected.name} src={previewUrl} className="h-full min-h-[700px] w-full rounded-xl bg-white" />}
                {selected.kind === 'html' && <iframe title={selected.name} sandbox="" srcDoc={previewText} className="h-full min-h-[700px] w-full rounded-xl bg-white" />}
                {['text', 'code', 'json'].includes(selected.kind) && (
                  <pre className="whitespace-pre-wrap break-words rounded-xl border border-border bg-surface p-4 text-xs leading-6 text-gray-300">{previewText || 'Loading preview…'}</pre>
                )}
                {selected.kind === 'file' && <div className="py-20 text-center text-sm text-gray-500">This file type is available for download but has no inline preview.</div>}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-600">Select an artifact to preview it.</div>
          )}
        </section>
      </div>
    </div>
  );
}
