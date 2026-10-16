import type { Task, TaskControlCapabilities } from '../types.js';
import type { TaskQueue } from '../queue/task-queue.js';
import { listExecutions } from '../db/models/execution.js';
import { getTask } from '../db/models/task.js';
import { getExternalAgent, getExternalAgentRunForExecution } from '../db/models/external-agent.js';
import { canAcceptAgentOutput, isQualityStep } from '@myrmecia/shared';
import { completionEvidenceIsFresh } from './completion-gate.js';
import { runtimeV2Enabled } from './runtime-version.js';
import { isGitHubVerificationTask } from '../db/models/github-fix.js';

export function taskControlCapabilities(task: Task, queue: TaskQueue): TaskControlCapabilities {
  const latest = listExecutions({ taskId: task.id, workspaceId: task.workspaceId, limit: 1 })[0];
  const active = latest?.status === 'running';
  const terminal = ['done', 'failed', 'cancelled'].includes(task.status);
  const verifier = isGitHubVerificationTask(task.id);
  const unsupported = verifier || task.pipelineId || task.mode !== 'direct' || task.assigneeId?.startsWith('external:')
    || (task.assigneeId && getExternalAgent(task.assigneeId, task.workspaceId || 'default'))
    || (latest && getExternalAgentRunForExecution(latest.id, task.workspaceId || 'default'));
  const operations: TaskControlCapabilities['operations'] = {
    pause: { allowed: false, reason: '此任务已结束或不支持安全暂停' },
    resume: { allowed: false, reason: '没有已确认的暂停边界' },
    cancel: { allowed: !terminal, reason: terminal ? '任务已结束' : '停止当前任务；已发生的外部动作不能撤回' },
    followup: { allowed: false, reason: '当前任务状态不支持追加指令' },
    rerun: { allowed: terminal && !unsupported, reason: '显式创建新的任务，保留原任务与证据' },
    accept: { allowed: false, reason: '需要成功完成且证据仍有效的交付' },
  };
  if (verifier) operations.cancel = { allowed: false, reason: '请使用 GitHub 交付面板的“停止验证”；它不是模型 Agent 的执行任务' };
  if (!unsupported) {
    if (!terminal && !task.pauseControl) {
      try { queue.assertPauseSupported(queue.taskFamily(task.id)); operations.pause = { allowed: true, reason: '等待完整模型/工具轮次保存安全边界' }; }
      catch (error) { operations.pause.reason = String(error); }
    }
    if (task.pauseControl) {
      try { queue.assertResumeSupported(queue.taskFamily(task.id)); operations.resume = { allowed: true, reason: '使用已有检查点与累计预算恢复' }; }
      catch (error) { operations.resume.reason = String(error); }
    }
    operations.followup = { allowed: !!latest && !task.pauseControl && (active ? runtimeV2Enabled() : terminal),
      reason: active ? runtimeV2Enabled() ? '等待当前任务结束后创建新任务；不修改正在执行的请求'
        : '默认运行路径不支持排队追问，请等待当前任务结束再发送' : '在当前会话中创建新的追问任务' };
  }
  let root: Task | undefined = task;
  const seen = new Set<string>();
  while (root?.parentTaskId && !seen.has(root.id)) {
    seen.add(root.id);
    const parent = getTask(root.parentTaskId);
    root = parent?.workspaceId === task.workspaceId ? parent : undefined;
  }
  if (!verifier && latest?.runState?.acceptance === 'pending' && root && !seen.has(root.id) && !isQualityStep(task)
    && canAcceptAgentOutput(latest, task, root.status)
    && (!latest.runState.verification || completionEvidenceIsFresh(task, latest.id, latest.runState.verification))) {
    operations.accept = { allowed: true, reason: '由你确认交付，记录验收决定；不是模型自动批准' };
  }
  return { taskId: task.id, executionId: latest?.id || null,
    state: task.pauseControl?.state === 'requested' ? 'pause_requested' : task.pauseControl?.state === 'paused' ? 'paused' : task.status, operations };
}
