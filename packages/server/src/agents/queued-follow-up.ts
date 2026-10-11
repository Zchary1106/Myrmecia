import { getDb } from '../db/database.js';
import { createTask, getTask } from '../db/models/task.js';
import { getExecution } from '../db/models/execution.js';
import { listInboxEntries, rejectInbox } from '../db/models/agent-inbox.js';
import { agentSessionForTask, appendSessionEvent } from '../db/models/agent-session-event.js';
import { loadExecutionContext, persistInheritedExecutionContext } from './execution-context.js';
import { continuationInput } from './task-continuation.js';
import type { Task } from '../types.js';

/** Durable task materialization, independent from queue transport and idempotent after crashes. */
export function materializeQueuedFollowUp(runId: string): Task | undefined {
  const run = getExecution(runId);
  const previous = run && getTask(run.taskId);
  if (!run || !previous || !['done', 'failed', 'cancelled'].includes(previous.status)) return;
  const workspaceId = previous.workspaceId || 'default';
  const sessionId = agentSessionForTask(previous);
  const pending = listInboxEntries(workspaceId, sessionId)
    .filter(entry => entry.targetExecutionId === runId && entry.mode === 'follow_up' && !entry.assignedTaskId
      && ['pending', 'claimed'].includes(entry.status));
  if (!pending.length) return;
  if (previous.status !== 'done' || run.runState?.stopReason !== 'completed') {
    for (const entry of pending) rejectInbox(workspaceId, entry.id, 'Prior run did not complete. Start a fresh follow-up explicitly.');
    return;
  }
  const context = loadExecutionContext(previous);
  return getDb().transaction(() => {
    // Writing first holds the writer lock; a second queue process must not create another child.
    const reserved = getDb().run(`UPDATE agent_inbox_entries SET claim_owner = ?
      WHERE id = ? AND workspace_id = ? AND assigned_task_id IS NULL AND status IN ('pending','claimed')`,
      `continuation:${runId}`, pending[0].id, workspaceId);
    if (reserved.changes !== 1) return;
    const content = pending.map(entry => entry.content).join('\n\n');
    const root = sessionId.startsWith('task:') ? getTask(sessionId.slice(5)) || previous : previous;
    const next = createTask({
      title: content.slice(0, 80), description: content, input: continuationInput(root, [previous], content, context),
      mode: 'direct', parentTaskId: root.id, pipelineId: previous.pipelineId, createdBy: 'user',
      assigneeId: previous.assigneeId || run.agentDefId, priority: previous.priority, workspaceId,
      workdir: context.workdir, workspacePath: context.workspacePath, modelId: context.modelId,
      reasoningEffort: context.reasoningEffort, contextLength: context.contextLength, domainId: previous.domainId, maxRetries: 0,
    });
    persistInheritedExecutionContext(context, next);
    const debugRoot = getDb().get<{ root_task_id: string }>('SELECT root_task_id FROM agent_debug_task_history WHERE workspace_id = ? AND task_id = ?',
      workspaceId, previous.id)?.root_task_id || previous.id;
    getDb().run('INSERT INTO agent_debug_task_history(workspace_id, root_task_id, task_id) VALUES (?,?,?)', workspaceId, debugRoot, next.id);
    for (const entry of pending) {
      getDb().run(`UPDATE agent_inbox_entries SET assigned_task_id = ?, status = 'applied',
        reason = 'Queued as a new task; model delivery not yet observed', updated_at = ?
        WHERE id = ? AND workspace_id = ? AND assigned_task_id IS NULL`,
        next.id, new Date().toISOString(), entry.id, workspaceId);
      if (entry.sourceMessageId) getDb().run('UPDATE agent_messages SET consumed = 1 WHERE id = ?', entry.sourceMessageId);
      appendSessionEvent({ workspaceId, sessionId, runId, eventKey: `inbox:${entry.id}:scheduled`,
        payload: { type: 'inbox.delivery', inboxId: entry.id, status: 'applied', reason: `Queued task ${next.id}; model delivery not yet observed` } });
    }
    return next;
  });
}
