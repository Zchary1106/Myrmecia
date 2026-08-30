import { CheckCircle2, ChevronRight, Clock3, GitBranch, Search, ShieldCheck } from 'lucide-react';
import type { Pipeline, PipelineTemplate } from '@myrmecia/shared';
import { cn } from '../../lib/utils';
import { useStore } from '../../stores/store';

type Props = {
  templates: PipelineTemplate[];
  pipelines: Pipeline[];
  query: string;
  selectedId: string | null;
  onQueryChange: (value: string) => void;
  onSelect: (id: string) => void;
  onConfigure: (id: string) => void;
};

function templateMeta(template: PipelineTemplate, pipelines: Pipeline[]) {
  const runs = pipelines.filter(item => item.templateId === template.id);
  const latest = [...runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  const approvalCount = template.stages.filter(stage => stage.requiresApproval).length;
  const publishCount = template.stages.filter(stage => stage.publishTools?.length).length;
  return { runs, latest, approvalCount, publishCount };
}

function statusClass(status?: Pipeline['status']): string {
  if (status === 'running') return 'bg-blue-500/10 text-blue-500';
  if (status === 'paused' || status === 'blocked' || status === 'awaiting_retry') return 'bg-amber-500/10 text-amber-500';
  if (status === 'done') return 'bg-emerald-500/10 text-emerald-500';
  if (status === 'failed') return 'bg-red-500/10 text-red-500';
  return 'bg-surface-hover text-app-muted';
}

export function WorkflowCatalog({ templates, pipelines, query, selectedId, onQueryChange, onSelect, onConfigure }: Props) {
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? templates.filter(template => `${template.name} ${template.description || ''} ${template.stages.map(stage => `${stage.name} ${stage.role}`).join(' ')}`.toLowerCase().includes(needle))
    : templates;
  const selected = templates.find(template => template.id === selectedId) || visible[0] || null;
  const selectedMeta = selected ? templateMeta(selected, pipelines) : null;

  return (
    <section aria-label="Workflow catalog">
      <section className="mb-5 flex flex-col gap-4 rounded-2xl border border-indigo-100 bg-[radial-gradient(circle_at_top_right,rgba(129,140,248,0.14),transparent_42%),linear-gradient(135deg,#ffffff,#f8faff)] p-5 shadow-[0_16px_35px_-30px_rgba(79,70,229,.5)] sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-indigo-600">Advanced workflow editor</div>
          <h2 className="mt-1 text-base font-semibold text-app-primary">Visual workflow canvas</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-app-muted">Compose Agent, gate, artifact, and publisher steps when a reusable workflow needs custom control.</p>
        </div>
        <button type="button" onClick={() => useStore.getState().setActiveView('orchestrate')} className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Open visual canvas</button>
      </section>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-app-primary">Workflow catalog</h2>
          <p className="mt-1 text-[10px] text-app-muted">Repeatable procedures shared by Teams and direct task launches.</p>
        </div>
        <label className="relative w-full sm:w-[300px]">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-muted" />
          <input value={query} onChange={event => onQueryChange(event.target.value)} placeholder="Search workflows or stages…" className="w-full rounded-xl border border-border bg-surface py-2.5 pl-9 pr-3 text-xs text-app-primary outline-none transition focus:border-accent/50" />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visible.map(template => {
          const meta = templateMeta(template, pipelines);
          const selectedCard = selected?.id === template.id;
          return (
            <button key={template.id} type="button" onClick={() => onSelect(template.id)} className={cn('app-focus premium-card group overflow-hidden rounded-2xl border bg-surface text-left transition duration-200 hover:-translate-y-0.5', selectedCard ? 'border-accent/60 ring-2 ring-accent/10' : 'border-border hover:border-accent/30')}>
              <div className="p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent-light"><GitBranch size={17} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><h3 className="truncate text-sm font-semibold text-app-primary">{template.name}</h3><span className={cn('ml-auto rounded-full px-2 py-0.5 text-[9px] capitalize', statusClass(meta.latest?.status))}>{meta.latest?.status || 'ready'}</span></div>
                    <p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-4 text-app-muted">{template.description || 'Reusable multi-stage workflow.'}</p>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2 text-[9px] text-app-muted">
                  <span>{template.stages.length} stages</span>
                  {meta.approvalCount > 0 && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-500">{meta.approvalCount} gates</span>}
                  {meta.publishCount > 0 && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-violet-500">publish</span>}
                </div>
                <div className="mt-4 grid grid-cols-3 border-t border-border pt-3 text-center">
                  <div><div className="text-xs font-semibold text-app-primary">{template.stages.length}</div><div className="text-[9px] text-app-muted">Stages</div></div>
                  <div className="border-x border-border"><div className="text-xs font-semibold text-app-primary">{meta.runs.length}</div><div className="text-[9px] text-app-muted">Runs</div></div>
                  <div><div className="text-xs font-semibold text-app-primary">{new Set(template.stages.map(stage => stage.role)).size}</div><div className="text-[9px] text-app-muted">Roles</div></div>
                </div>
                <div className="mt-3 flex items-center justify-between text-[10px] font-medium text-accent-light"><span>{selectedCard ? 'Selected workflow' : 'View workflow'}</span><ChevronRight size={13} /></div>
              </div>
              <div className={cn('h-0.5', selectedCard ? 'bg-accent' : 'bg-accent/20')} />
            </button>
          );
        })}
      </div>

      {visible.length === 0 && <div className="rounded-2xl border border-dashed border-border p-10 text-center text-xs text-app-muted">No workflows match this search.</div>}

      {selected && selectedMeta && (
        <article className="premium-card mt-5 overflow-hidden rounded-2xl border border-border bg-surface">
          <header className="flex flex-col gap-3 border-b border-border p-5 sm:flex-row sm:items-start sm:justify-between">
            <div><div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-light">Selected workflow</div><h2 className="mt-1 text-lg font-semibold text-app-primary">{selected.name}</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-app-muted">{selected.description || 'Reusable multi-stage workflow.'}</p></div>
            <button type="button" onClick={() => onConfigure(selected.id)} className="home-primary-button app-focus inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold text-white">Configure & run <ChevronRight size={14} /></button>
          </header>
          <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div>
              <div className="flex items-center gap-2 overflow-x-auto pb-2">
                {selected.stages.map((stage, index) => <div key={`${stage.name}-${index}`} className="contents"><div className="min-w-[155px] rounded-xl border border-border bg-background/60 p-3"><div className="flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent/10 text-[10px] font-semibold text-accent-light">{index + 1}</span><span className="truncate text-[11px] font-semibold text-app-primary">{stage.name}</span></div><div className="mt-2 text-[9px] text-app-muted">{stage.role}</div></div>{index < selected.stages.length - 1 && <ChevronRight size={14} className="shrink-0 text-app-muted" />}</div>)}
              </div>
            </div>
            <aside className="rounded-xl border border-border bg-background/60 p-4">
              <div className="space-y-3 text-[10px]"><div className="flex items-center justify-between"><span className="text-app-muted">Runs</span><span className="font-semibold text-app-primary">{selectedMeta.runs.length}</span></div><div className="flex items-center justify-between"><span className="text-app-muted">Approval gates</span><span className="font-semibold text-app-primary">{selectedMeta.approvalCount}</span></div><div className="flex items-center justify-between"><span className="text-app-muted">Publish stages</span><span className="font-semibold text-app-primary">{selectedMeta.publishCount}</span></div></div>
              <div className="mt-4 border-t border-border pt-3 text-[10px] text-app-muted">{selectedMeta.publishCount ? <span className="flex items-center gap-1.5 text-amber-500"><ShieldCheck size={13} /> Human publish confirmation retained</span> : selectedMeta.latest?.status === 'done' ? <span className="flex items-center gap-1.5 text-emerald-500"><CheckCircle2 size={13} /> Latest run completed</span> : <span className="flex items-center gap-1.5"><Clock3 size={13} /> Ready for a new run</span>}</div>
            </aside>
          </div>
        </article>
      )}
    </section>
  );
}
