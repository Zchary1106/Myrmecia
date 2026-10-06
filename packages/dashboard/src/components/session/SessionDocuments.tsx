import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { FileText, Info, Paperclip, X } from 'lucide-react';
import { api, type SessionDocument } from '../../lib/api';

export function SessionDocuments({ taskId, onParsingChange, children, actions }: {
  taskId: string;
  onParsingChange: (busy: boolean) => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const [documents, setDocuments] = useState<SessionDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.tasks.document>> | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const helpId = useId();
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const uploading = useRef(false);
  useEffect(() => {
    mounted.current = true;
    api.tasks.documents(taskId).then(docs => { if (mounted.current) setDocuments(docs); })
      .catch(() => { if (mounted.current) setError('Unable to load session files. Reopen the session to retry.'); });
    return () => { mounted.current = false; };
  }, [taskId]);

  const upload = async (files: File[]) => {
    if (!files.length || uploading.current) return;
    uploading.current = true;
    setBusy(true); onParsingChange(true); setError('');
    try {
      for (const file of files) {
        if (!mounted.current) break;
        if (file.size > 5 * 1024 * 1024 || !/\.(txt|md|markdown|pdf|docx)$/i.test(file.name)) {
          throw new Error(`${file.name}: use TXT, Markdown, PDF or DOCX up to 5 MB`);
        }
        setProgress(`Parsing ${file.name}…`);
        const doc = await api.tasks.uploadDocument(taskId, file);
        if (mounted.current) setDocuments(current => [...current, doc]);
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : 'Unable to parse file');
    } finally {
      uploading.current = false;
      if (mounted.current) { setBusy(false); setProgress(''); onParsingChange(false); }
    }
  };

  const remove = async (doc: SessionDocument) => {
    if (!window.confirm(`Remove "${doc.name}" from this session? It will no longer be used for new replies. Previous messages remain unchanged.`)) return;
    try {
      await api.tasks.removeDocument(taskId, doc.id);
      setDocuments(current => current.filter(item => item.id !== doc.id));
      if (preview?.id === doc.id) setPreview(null);
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to remove file'); }
  };
  return (
    <section aria-label="Session knowledge files" className="session-knowledge min-w-0"
      onDragOver={event => event.preventDefault()}
      onDrop={event => { event.preventDefault(); void upload(Array.from(event.dataTransfer.files)); }}>
      <input ref={input} type="file" multiple accept=".txt,.md,.markdown,.pdf,.docx" tabIndex={-1} className="sr-only" aria-label="Upload session knowledge"
        onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ''; }} />
      {busy && <p role="status" className="mt-2 text-xs text-accent-light">{progress}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
      {documents.length > 0 && <div className="session-document-list flex flex-wrap gap-2">
        {documents.map(doc => (
          <div key={doc.id} className="inline-flex max-w-full items-center rounded-lg border border-border bg-surface text-xs">
            <button type="button" className="app-focus flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-app-secondary"
              onClick={() => void api.tasks.document(taskId, doc.id).then(setPreview).catch(() => setError('Unable to load parsed text'))}>
              <FileText size={13} className="shrink-0" /><span className="truncate">{doc.name}</span>
              <span className="shrink-0 text-[10px] text-emerald-600">Ready · {doc.passageCount} passages</span>
            </button>
            <button type="button" onClick={() => void remove(doc)} disabled={busy} className="app-focus p-1.5 text-app-muted" aria-label={`Remove ${doc.name}`}><X size={12} /></button>
          </div>
        ))}
      </div>}
      {preview && <div className="mt-2 rounded-lg border border-border bg-surface p-3" role="region" aria-label="Parsed document preview">
        <div className="flex items-center justify-between gap-2 text-xs font-medium"><span className="truncate">{preview.name}</span><button type="button" onClick={() => setPreview(null)} aria-label="Close document preview"><X size={14} /></button></div>
        <div className="mt-2 max-h-48 overflow-y-auto text-xs leading-5">{preview.passages.map((p, i) => (
          <div key={i} className="mb-3"><span className="text-accent-light">{p.locator}</span><p className="whitespace-pre-wrap break-words">{p.text}</p></div>
        ))}</div>
      </div>}
      {children}
      <div className="session-composer-toolbar">
        <div className="session-composer-tools">
          <button type="button" onClick={() => input.current?.click()} disabled={busy}
            aria-label="Attach knowledge" title="Attach TXT, Markdown, PDF or DOCX · 5 MB per file"
            className="session-composer-tool app-focus">
            <Paperclip size={16} aria-hidden="true" /><span>Attach</span>
          </button>
          <button type="button" onClick={() => setShowHelp(value => !value)}
            aria-label="About session knowledge" aria-expanded={showHelp} aria-controls={helpId}
            className="session-composer-tool session-composer-info app-focus" title="File types and privacy">
            <Info size={14} aria-hidden="true" />
          </button>
        </div>
        {actions}
      </div>
      {showHelp && <div id={helpId} role="region" aria-label="Session knowledge details" className="session-knowledge-help">
        <p className="font-medium text-app-secondary">TXT / Markdown / PDF / DOCX · Up to 5 MB per file</p>
        <p>Attach or drop files into this input area. Relevant excerpts are sent to the configured model with your question, only in this session. Files are not saved to long-term Memory.</p>
      </div>}
    </section>
  );
}
