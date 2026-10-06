import type { AgentSummary, Pipeline, PipelineStatus, Task, TaskExecution } from '@myrmecia/shared';
import { structuredResultSummary } from '../common/StructuredTaskResult';

const activeStatuses = new Set<Task['status']>(['pending', 'queued', 'assigned', 'running', 'waiting_for_tool', 'review']);

export function activityTime(task: Task): number {
  const value = task.completedAt || task.startedAt || task.createdAt;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  return Date.parse(normalized) || 0;
}

export function compactTaskTitle(title: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim() || 'Untitled conversation';
  if (Array.from(normalized).length <= 38) return normalized;
  const clause = normalized.split(/[，。！？]|[,!?]\s/)[0].trim();
  const label = Array.from(clause).length >= 8 ? clause : normalized;
  const characters = Array.from(label);
  return characters.length > 38 ? `${characters.slice(0, 38).join('').trimEnd()}…` : label;
}

export function plainResultPreview(output: string): string {
  const text = structuredResultSummary(output) || output;
  return text
    .replace(/```[^\n]*\n[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, '')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/\|/g, ' · ')
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}

export type HomeConversation = {
  id: string;
  task: Task;
  activity: Task;
  title: string;
  agent: string;
  preview: string;
  updatedAt: number;
  active: boolean;
  workflowStatus?: PipelineStatus;
  turns: number;
};

export function homeConversations(
  tasks: Task[], pipelines: Pipeline[], agents: AgentSummary[], executions: TaskExecution[] = [],
): HomeConversation[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const rootFor = (task: Task) => {
    let root = task;
    const visited = new Set([root.id]);
    while (root.parentTaskId && !visited.has(root.parentTaskId)) {
      const parent = byId.get(root.parentTaskId);
      if (!parent) break;
      visited.add(parent.id);
      root = parent;
    }
    return root;
  };
  const groups = new Map<string, { root: Task; pipelineId?: string; tasks: Task[] }>();
  for (const task of tasks) {
    // Mirror the chat sidebar: internal planning executions are not conversations.
    if (task.title.startsWith('Plan: ') && tasks.some(other => other.id !== task.id && `Plan: ${other.title}` === task.title)) continue;
    const root = rootFor(task);
    const pipelineId = task.pipelineId || root.pipelineId;
    const id = pipelineId ? `pipeline:${pipelineId}` : `task:${root.id}`;
    const group = groups.get(id) || { root, pipelineId, tasks: [] };
    group.tasks.push(task);
    groups.set(id, group);
  }
  return [...groups.entries()].map(([id, group]) => {
    const ordered = [...group.tasks].sort((a, b) => activityTime(b) - activityTime(a));
    const activity = ordered.find(task => activeStatuses.has(task.status)) || ordered[0];
    const execution = executions.filter(item => item.taskId === activity.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const agentId = execution?.agentDefId || activity.assigneeId;
    const agent = agents.find(item => item.id === agentId)?.name || agentId
      || (['pending', 'queued'].includes(activity.status) ? 'Selecting an Agent…' : 'No Agent recorded');
    const pipeline = pipelines.find(item => item.id === group.pipelineId);
    return {
      id, task: group.pipelineId ? activity : group.root, activity,
      title: pipeline?.name || group.root.title,
      agent,
      preview: plainResultPreview(activity.error || activity.output || ''),
      updatedAt: Math.max(...ordered.map(activityTime)),
      active: activeStatuses.has(activity.status) || !!(pipeline?.status && !['done', 'failed'].includes(pipeline.status)),
      workflowStatus: pipeline?.status,
      turns: Math.max(1, group.tasks.filter(task => task.createdBy === 'user').length),
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
