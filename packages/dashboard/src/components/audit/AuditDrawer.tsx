import { useEffect, useMemo, useState } from 'react';
import type { OperatorAction } from '@agent-factory/shared';
import { cn } from '../../lib/utils';
import { useStore } from '../../stores/store';

export function AuditDrawer({
  targetType,
  targetId,
  label = 'Audit',
}: {
  targetType?: OperatorAction['targetType'];
  targetId?: string;
  label?: string;
}) {
  const { operatorActions, loadOperatorActions } = useStore();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) void loadOperatorActions();
  }, [open]);

  const actions = useMemo(() => {
    return operatorActions
      .filter(action => !targetType || action.targetType === targetType)
      .filter(action => !targetId || action.targetId === targetId || action.taskId === targetId || action.pipelineId === targetId || action.inboxEntryId === targetId)
      .slice(0, 30);
  }, [operatorActions, targetType, targetId]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl bg-surface-hover px-4 py-2 text-sm text-gray-300 hover:text-white"
      >
        {label}
      </button>
      {open && (
        <div className="fixed inset-0 z-50">
          <button className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-label="Close audit drawer" />
          <aside className="absolute right-0 top-0 h-full w-[440px] max-w-[92vw] overflow-y-auto border-l border-border bg-surface shadow-2xl">
            <div className="sticky top-0 z-10 border-b border-border bg-surface/95 p-5 backdrop-blur">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-[0.24em] text-accent-light">Context Audit</div>
                  <h3 className="mt-1 text-lg font-semibold">
                    {targetType ? `${targetType}${targetId ? ` · ${targetId}` : ''}` : 'Recent changes'}
                  </h3>
                </div>
                <button onClick={() => setOpen(false)} className="rounded-lg bg-background px-2 py-1 text-xs text-gray-400 hover:text-white">
                  Close
                </button>
              </div>
            </div>

            <div className="space-y-3 p-4">
              {actions.map(action => (
                <div key={action.id} className="rounded-xl border border-border bg-background p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{action.action}</div>
                      <div className="mt-1 text-[11px] text-gray-500">
                        {action.actor.id} · {action.actor.role} · {new Date(action.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <span className={cn(
                      'rounded px-2 py-0.5 text-[10px]',
                      action.status === 'success' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-red-500/10 text-red-300',
                    )}>
                      {action.status}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-gray-500">
                    <span className="rounded bg-surface px-1.5 py-1">{action.targetType}</span>
                    {action.targetId && <span className="rounded bg-surface px-1.5 py-1">{action.targetId}</span>}
                    {action.taskId && <span className="rounded bg-surface px-1.5 py-1">task {action.taskId}</span>}
                    {action.pipelineId && <span className="rounded bg-surface px-1.5 py-1">pipeline {action.pipelineId}</span>}
                  </div>
                  {Object.keys(action.metadata || {}).length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-gray-500 hover:text-gray-300">Metadata</summary>
                      <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-border bg-surface p-2 text-[10px] text-gray-400">
                        {JSON.stringify(action.metadata, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))}

              {actions.length === 0 && (
                <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-gray-600">
                  No matching audit records yet
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
