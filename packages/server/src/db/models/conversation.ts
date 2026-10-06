import { getDb } from '../database.js';
import { listTasks } from './task.js';
import { getPipeline, updatePipeline } from './pipeline.js';
import { conversationDeletionPolicy } from '@myrmecia/shared';
import type { Task, OperatorActor } from '../../types.js';
import { createOperatorAction } from './operator-action.js';
import { HttpError } from '../../routes/http.js';

export type ConversationState = { id: string; status: 'archived' | 'deleted'; updatedAt: string; taskIds: string[] };
export type ConversationAction = 'archive' | 'restore' | 'delete';

// Scope to the whole task tree, not just the last turn shown in the sidebar.
export function conversationForTask(task: Task, byId: Map<string, Task>): string {
  let root = task;
  const visited = new Set([task.id]);
  while (root.parentTaskId) {
    const parent = byId.get(root.parentTaskId);
    if (!parent || (parent.workspaceId || 'default') !== (task.workspaceId || 'default')) break;
    if (visited.has(parent.id)) throw new HttpError(409, 'INVALID_CONVERSATION', 'Conversation has a cyclic task ancestry.');
    visited.add(parent.id);
    root = parent;
  }
  const pipelineId = task.pipelineId || root.pipelineId;
  return pipelineId ? `pipeline:${pipelineId}` : `task:${root.id}`;
}

export function listConversationStates(workspaceId?: string): ConversationState[] {
  const rows = workspaceId
    ? getDb().all('SELECT * FROM conversation_lifecycle WHERE workspace_id = ?', workspaceId)
    : getDb().all('SELECT * FROM conversation_lifecycle');
  const tasks = listTasks({ workspaceId });
  const byId = new Map(tasks.map(task => [task.id, task]));
  const members = new Map<string, string[]>();
  const hiddenIds = new Set(rows.map(row => row.conversation_id));
  for (const task of tasks) {
    const id = conversationForTask(task, byId);
    if (hiddenIds.has(id)) members.set(id, [...(members.get(id) || []), task.id]);
  }
  return rows.map(row => ({ id: row.conversation_id, status: row.status, updatedAt: row.updated_at, taskIds: members.get(row.conversation_id) || [] }));
}

export function manageConversations(
  taskIds: string[], action: ConversationAction, actor: OperatorActor, workspaceId?: string,
  options: { stopWorkflow?: boolean } = {},
): { states: ConversationState[]; affectedConversationIds: string[]; stoppedPipelineIds: string[] } {
  const db = getDb();
  return db.transaction(() => {
    const tasks = listTasks({ workspaceId });
    const byId = new Map(tasks.map(task => [task.id, task]));
    const targets = new Map<string, { workspaceId: string; tasks: Task[] }>();
    for (const taskId of taskIds) {
      const task = byId.get(taskId);
      if (!task) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
      const id = conversationForTask(task, byId);
      if (!targets.has(id)) {
        const members = tasks.filter(item => (item.workspaceId || 'default') === (task.workspaceId || 'default')
          && conversationForTask(item, byId) === id);
        targets.set(id, { workspaceId: task.workspaceId || 'default', tasks: members });
      }
    }

    const workflowsToStop = new Map<string, NonNullable<ReturnType<typeof getPipeline>>>();
    // Validate all targets before changing any of them (batch is all-or-nothing).
    for (const [id, target] of targets) {
      const state = db.get('SELECT status FROM conversation_lifecycle WHERE workspace_id = ? AND conversation_id = ?', target.workspaceId, id);
      if (state?.status === 'deleted') throw new HttpError(409, 'CONVERSATION_DELETED', 'This conversation was already removed from chat history.');
      // Archiving hides history only: it must never cancel or block ongoing work.
      if (action !== 'delete') continue;
      const pipeline = id.startsWith('pipeline:') ? getPipeline(id.slice(9)) : undefined;
      if (id.startsWith('pipeline:') && (!pipeline || (pipeline.workspaceId || 'default') !== target.workspaceId)) {
        throw new HttpError(409, 'CONVERSATION_WORKFLOW_UNAVAILABLE', '无法确认关联 Workflow 的状态，请刷新后重试。');
      }
      const activeExecution = target.tasks.some(task => db.get("SELECT id FROM task_executions WHERE task_id = ? AND status IN ('pending', 'running') LIMIT 1", task.id));
      const policy = conversationDeletionPolicy({
        taskStatuses: target.tasks.map(task => task.status),
        executionStatuses: activeExecution ? ['running'] : [],
        pipelineStatus: pipeline?.status,
        stageStatuses: pipeline?.stages.map(stage => stage.status),
      });
      if (!policy.allowed) {
        throw new HttpError(409, 'CONVERSATION_ACTIVE', policy.reason!, { conversationId: id });
      }
      if (policy.requiresWorkflowStop && pipeline) {
        if (!options.stopWorkflow) {
          throw new HttpError(409, 'CONVERSATION_STOP_REQUIRED', '此会话的 Workflow 正在暂停或等待重试，请确认“结束流程并删除”；如只整理列表，可直接归档。',
            { conversationId: id, pipelineStatus: pipeline.status });
        }
        workflowsToStop.set(pipeline.id, pipeline);
      }
    }
    for (const pipeline of workflowsToStop.values()) {
      // Only quiescent workflows reach here. Do not use engine.cancel(), which
      // cleans up the workspace: deleting history must preserve disk evidence.
      updatePipeline(pipeline.id, {
        status: 'failed', completedAt: new Date().toISOString(),
        stages: pipeline.stages.map(stage => ['pending', 'review', 'rolled_back'].includes(stage.status)
          ? { ...stage, status: 'skipped' as const } : stage),
      });
      createOperatorAction({
        action: 'pipeline.cancel', actor, targetType: 'pipeline', targetId: pipeline.id, pipelineId: pipeline.id,
        metadata: { previousStatus: pipeline.status, reason: 'conversation.delete', retainedFiles: true },
      });
    }
    for (const [id, target] of targets) {
      if (action === 'restore') {
        db.run('DELETE FROM conversation_lifecycle WHERE workspace_id = ? AND conversation_id = ?', target.workspaceId, id);
      } else {
        db.run(`INSERT INTO conversation_lifecycle (workspace_id, conversation_id, status, updated_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, conversation_id)
          DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        target.workspaceId, id, action === 'delete' ? 'deleted' : 'archived', new Date().toISOString());
      }
      createOperatorAction({
        action: `conversation.${action}`, actor, targetType: 'task',
        targetId: target.tasks[0].id, taskId: target.tasks[0].id,
        metadata: { conversationId: id, taskCount: target.tasks.length, workspaceId: target.workspaceId, retainedEvidence: true, retainedFiles: true },
      });
    }
    return { states: listConversationStates(workspaceId), affectedConversationIds: [...targets.keys()], stoppedPipelineIds: [...workflowsToStop.keys()] };
  });
}
