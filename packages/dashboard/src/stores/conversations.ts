import { create } from 'zustand';
import { api } from '../lib/api';
import type { PipelineStatus, Task } from '@myrmecia/shared';

export function workflowConversationLabel(status?: PipelineStatus): string | undefined {
  const labels: Partial<Record<PipelineStatus, string>> = {
    paused: '流程已暂停', awaiting_retry: '等待重试', blocked: '流程受阻',
    running: '流程执行中', failed: '流程已结束',
  };
  return status ? labels[status] : undefined;
}

export function conversationIdForTask(task: Task, byId: Map<string, Task>, conversationIds: Record<string, string> = {}): string {
  if (conversationIds[task.id]) return conversationIds[task.id];
  let root = task;
  const visited = new Set([task.id]);
  while (root.parentTaskId && !visited.has(root.parentTaskId)) {
    const parent = byId.get(root.parentTaskId);
    if (!parent) break;
    visited.add(parent.id);
    root = parent;
  }
  const pipelineId = task.pipelineId || root.pipelineId;
  return pipelineId ? `pipeline:${pipelineId}` : `task:${root.id}`;
}

type ConversationStatus = 'archived' | 'deleted';
export function expandConversationStates(items: Array<{ id: string; status: ConversationStatus; taskIds?: string[] }>) {
  const states: Record<string, ConversationStatus> = {};
  const conversationIds: Record<string, string> = {};
  for (const item of items) {
    states[item.id] = item.status;
    // Keep descendants hidden even when task pagination omitted their root.
    for (const id of item.taskIds || []) {
      states[`task:${id}`] = item.status;
      conversationIds[id] = item.id;
    }
  }
  return { states, conversationIds };
}
let loadingRequest: Promise<void> | null = null;
export const useConversationStore = create<{
  states: Record<string, ConversationStatus>;
  conversationIds: Record<string, string>;
  loaded: boolean;
  error: string;
  load: () => Promise<void>;
  manage: (taskIds: string[], action: 'archive' | 'restore' | 'delete', stopWorkflow?: boolean) => Promise<string[]>;
}>(set => ({
  states: {}, conversationIds: {}, loaded: false, error: '',
  load: async () => {
    if (loadingRequest) return loadingRequest;
    loadingRequest = (async () => {
      try {
        const states = await api.conversations.list();
        set({ ...expandConversationStates(states), loaded: true, error: '' });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : '无法读取会话管理状态。' });
      }
    })();
    try { await loadingRequest; } finally { loadingRequest = null; }
  },
  manage: async (taskIds, action, stopWorkflow = false) => {
    const result = await api.conversations.manage(taskIds, action, action === 'delete', stopWorkflow);
    set({ ...expandConversationStates(result.states), loaded: true, error: '' });
    return result.affectedConversationIds;
  },
}));
