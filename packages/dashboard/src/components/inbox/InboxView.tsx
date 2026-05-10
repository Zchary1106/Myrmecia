import { useState } from 'react';
import { useStore } from '../../stores/store';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { readOnlyControlMessage, runtimeControlsAllowed } from '../../lib/permissions';
import { relatedNotificationsForInbox } from '../../lib/notificationTriage';
import { TaskDetailDrawer } from '../common/TaskDetailDrawer';
import type { InboxEntry, InboxEntryStatus } from '@agent-factory/shared';

const statusClass: Record<InboxEntryStatus, string> = {
  pending: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
  approved: 'bg-green-500/15 text-green-400 border-green-500/20',
  rejected: 'bg-red-500/15 text-red-400 border-red-500/20',
  answered: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  cancelled: 'bg-gray-500/15 text-gray-500 border-gray-500/20',
};

function resolveStatus(entry: InboxEntry, response: string, decision?: string): Exclude<InboxEntryStatus, 'pending'> {
  if (entry.type === 'approval') return decision === 'Approve' ? 'approved' : 'rejected';
  if (entry.type === 'question' || entry.type === 'input') return 'answered';
  if (decision === 'Reject') return 'rejected';
  return response ? 'answered' : 'approved';
}

function InboxCard({ entry }: { entry: InboxEntry }) {
  const {
    diagnostics, notifications, upsertInboxEntry, loadNotifications, markNotificationsRead,
    setSelectedTaskId, setActiveView, setActivePipelineId,
  } = useStore();
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canControl = runtimeControlsAllowed(diagnostics);
  const relatedNotifications = relatedNotificationsForInbox(entry, notifications);
  const unreadRelatedIds = relatedNotifications.filter(notification => !notification.read).map(notification => notification.id);

  const respond = async (decision?: string) => {
    setBusy(true);
    setError(null);
    try {
      const text = decision || response.trim();
      const updated = await api.inbox.respond(entry.id, {
        status: resolveStatus(entry, text, decision),
        response: text,
      });
      upsertInboxEntry(updated);
      await loadNotifications();
      setResponse('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const acknowledgeRelated = async () => {
    if (unreadRelatedIds.length === 0 || ackBusy) return;
    setAckBusy(true);
    try {
      await markNotificationsRead(unreadRelatedIds);
    } finally {
      setAckBusy(false);
    }
  };

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={cn('px-2 py-0.5 rounded border text-[10px] font-medium', statusClass[entry.status])}>
              {entry.status}
            </span>
            <span className="text-[10px] text-gray-600">{entry.type}</span>
            {unreadRelatedIds.length > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent-light text-[10px]">
                {unreadRelatedIds.length} unread alert{unreadRelatedIds.length === 1 ? '' : 's'}
              </span>
            )}
            <span className="text-[10px] text-gray-600">{new Date(entry.createdAt).toLocaleString()}</span>
          </div>
          <div className="text-sm font-semibold">{entry.title}</div>
          <div className="text-[12px] text-gray-400 whitespace-pre-wrap mt-2">{entry.message}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-3 text-[10px] text-gray-600">
        {entry.taskId && <span>task: {entry.taskId}</span>}
        {entry.pipelineId && <span>pipeline: {entry.pipelineId}</span>}
        {entry.executionId && <span>execution: {entry.executionId}</span>}
      </div>

      <div className="flex flex-wrap gap-2 mt-3">
        {entry.taskId && (
          <button
            onClick={() => setSelectedTaskId(entry.taskId || null)}
            className="px-2 py-1 rounded-lg bg-background text-[10px] text-gray-500 hover:text-white transition"
          >
            Open task
          </button>
        )}
        {entry.pipelineId && (
          <button
            onClick={() => {
              setActivePipelineId(entry.pipelineId || null);
              setActiveView('orchestrator');
            }}
            className="px-2 py-1 rounded-lg bg-background text-[10px] text-gray-500 hover:text-white transition"
          >
            Open pipeline
          </button>
        )}
        {relatedNotifications.length > 0 && (
          <button
            onClick={acknowledgeRelated}
            disabled={ackBusy || unreadRelatedIds.length === 0}
            className="px-2 py-1 rounded-lg bg-accent/10 text-[10px] text-accent-light hover:bg-accent/20 transition disabled:opacity-50"
          >
            Mark related alerts read
          </button>
        )}
      </div>

      {entry.response && (
        <div className="mt-3 bg-background border border-border rounded-lg px-3 py-2">
          <div className="text-[10px] text-gray-600 mb-1">Response</div>
          <div className="text-[12px] text-gray-300">{entry.response}</div>
        </div>
      )}

      {entry.status === 'pending' && (
        <div className="mt-4 space-y-3">
          <textarea
            value={response}
            onChange={e => setResponse(e.target.value)}
            placeholder="Add context or answer..."
            disabled={!canControl}
            rows={3}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none resize-none disabled:opacity-50"
          />

          <div className="flex items-center gap-2">
            {(entry.options.length > 0 ? entry.options : ['Approve', 'Reject']).map(option => (
              <button
                key={option}
                onClick={() => respond(option)}
                disabled={busy || !canControl}
                title={canControl ? undefined : readOnlyControlMessage}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-[11px] font-medium transition disabled:opacity-50',
                  option.toLowerCase().includes('reject')
                    ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                    : 'bg-green-500/10 text-green-400 hover:bg-green-500/20',
                )}
              >
                {option}
              </button>
            ))}
            <button
              onClick={() => respond()}
              disabled={busy || !response.trim() || !canControl}
              title={canControl ? undefined : readOnlyControlMessage}
              className="px-3 py-1.5 rounded-lg bg-accent/10 text-accent-light text-[11px] font-medium hover:bg-accent/20 transition disabled:opacity-50"
            >
              Send Answer
            </button>
          </div>
          {!canControl && (
            <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 text-xs text-yellow-400">
              {readOnlyControlMessage}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}

export function InboxView() {
  const {
    inboxEntries, pendingInboxCount, notifications, selectedTaskId,
    loadInboxEntries, loadNotifications, setSelectedTaskId,
  } = useStore();
  const pending = inboxEntries.filter(entry => entry.status === 'pending');
  const resolved = inboxEntries.filter(entry => entry.status !== 'pending');
  const unreadInputNotifications = notifications.filter(notification => notification.type === 'needs_input' && !notification.read).length;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Decision Inbox</h2>
          <p className="text-[12px] text-gray-500 mt-0.5">
            Human-in-the-loop approvals, questions, and operator input requests.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="bg-yellow-500/10 text-yellow-400 px-2 py-1 rounded-lg text-[11px]">
            {pendingInboxCount} pending
          </span>
          <span className="bg-accent/10 text-accent-light px-2 py-1 rounded-lg text-[11px]">
            {unreadInputNotifications} unread alerts
          </span>
          <button
            onClick={() => {
              void loadInboxEntries();
              void loadNotifications();
            }}
            className="px-3 py-1.5 rounded-lg bg-surface-hover text-[11px] text-gray-400 hover:text-white transition"
          >
            Refresh
          </button>
        </div>
      </div>

      {pending.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-gray-400 mb-3">Pending decisions</h3>
          <div className="space-y-3">
            {pending.map(entry => <InboxCard key={entry.id} entry={entry} />)}
          </div>
        </section>
      )}

      {resolved.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-gray-400 mb-3">Resolved</h3>
          <div className="space-y-3">
            {resolved.map(entry => <InboxCard key={entry.id} entry={entry} />)}
          </div>
        </section>
      )}

      {inboxEntries.length === 0 && (
        <div className="text-center py-16 text-gray-600">
          <div className="text-4xl mb-3 opacity-30">📥</div>
          <p className="text-sm">No pending decisions</p>
          <p className="text-[11px] text-gray-700 mt-1">
            Agent approval requests and questions will appear here.
          </p>
        </div>
      )}

      <TaskDetailDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
    </div>
  );
}
