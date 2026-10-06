/** History visibility is independent of execution; only deletion needs a stop gate. */
export function conversationDeletionPolicy(input: {
  taskStatuses: readonly string[];
  executionStatuses?: readonly string[];
  pipelineStatus?: string;
  stageStatuses?: readonly string[];
}): { allowed: boolean; requiresWorkflowStop: boolean; reason?: string } {
  const terminal = new Set(['done', 'failed', 'cancelled']);
  if (input.taskStatuses.some(status => !terminal.has(status))
    || input.executionStatuses?.some(status => status === 'pending' || status === 'running')
    || input.stageStatuses?.some(status => status === 'running')) {
    return { allowed: false, requiresWorkflowStop: false, reason: '会话中仍有运行、排队或待处理的任务，请先停止任务；归档不会影响执行。' };
  }
  if (input.pipelineStatus && !terminal.has(input.pipelineStatus)) {
    if (['paused', 'awaiting_retry', 'blocked'].includes(input.pipelineStatus)) {
      return { allowed: true, requiresWorkflowStop: true };
    }
    return { allowed: false, requiresWorkflowStop: false, reason: '关联的 Workflow 仍在运行，请先停止流程；归档不会影响执行。' };
  }
  return { allowed: true, requiresWorkflowStop: false };
}
