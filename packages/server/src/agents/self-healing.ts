import { getTask, updateTask, addTaskLog, listTasks } from '../db/models/task.js';
import { getAgent, listAgents } from '../db/models/agent.js';
import { getActiveExecutionCount } from '../db/models/execution.js';
import { agentRuntime } from '../agents/agent-runtime.js';
import { eventBus } from '../events/event-bus.js';
import { createNotification } from '../db/models/notification.js';
import type { Task } from '../types.js';
import { queueOwnsRetry, taskMayHaveSideEffects } from './retry-ownership.js';

/**
 * Self-Healing Engine
 * 5-level recovery strategy for failed tasks:
 *   Level 1: Retry with reformulated prompt
 *   Level 2: Reassign to a different agent
 *   Level 3: Retry with fresh execution context
 *   Level 4: Decompose into smaller subtasks
 *   Level 5: Escalate to supervisor (human)
 */
export class SelfHealingEngine {
  constructor() {
    eventBus.on('task:failed', (event) => {
      const { taskId, error } = event.payload as any;
      this.onTaskFailed(taskId, error);
    });
  }

  private async onTaskFailed(taskId: string, error: string) {
    const task = getTask(taskId);
    if (!task) return;

    // Don't self-heal already-cancelled tasks.
    if (task.status !== 'failed') return;
    if (queueOwnsRetry(task.id)) return;
    if (taskMayHaveSideEffects(task.id)) {
      return this.escalateToSupervisor(task, error, 'A write-capable tool was attempted. Verify its outcome before retrying.');
    }

    // Don't self-heal tasks that are part of a decomposition: coordination
    // parents (tasks that own subtasks) are settled by MasterAgent.monitorSubtasks,
    // and their subtasks are recovered at the parent level. Retrying either here
    // would flip a just-settled task back to `pending` (a zombie) and race the
    // monitor / dependency-cascade. This matches the engine's stated intent.
    const isParent = listTasks({ parentTaskId: task.id }).length > 0;
    if (task.parentTaskId || isParent) {
      addTaskLog(taskId, 'info', 'Self-healing skipped: task is part of a decomposition (handled by master coordinator)', 'self-healing');
      return;
    }

    if (isNonRetryableExecutionError(error)) {
      addTaskLog(taskId, 'warn', `Self-healing skipped automatic retries for deterministic failure: ${error}`, 'self-healing');
      return this.escalateToSupervisor(task, error, 'Automatic retries were skipped because the failure needs configuration or context changes.');
    }

    if (task.retryCount >= task.maxRetries) {
      return this.escalateToSupervisor(task, error, `Automatic retry limit reached (${task.retryCount}/${task.maxRetries}).`);
    }
    // A second timeout with a reduced research budget is not a reason to run
    // the same expensive search again with another agent or fresh context.
    if (isExecutionTimeout(error) && task.retryCount >= 1) {
      return this.escalateToSupervisor(task, error, 'The reduced-budget retry also timed out. Collected evidence is preserved for review.');
    }

    const healingLevel = this.getHealingLevel(task);
    addTaskLog(taskId, 'info', `Self-healing: attempting level ${healingLevel} recovery`, 'system');

    switch (healingLevel) {
      case 1: return this.retryWithBetterPrompt(task, error);
      case 2: return this.reassignAgent(task, error);
      case 3: return this.retryWithFreshContext(task, error);
      case 4: return this.decomposeSmaller(task, error);
      case 5: return this.escalateToSupervisor(task, error);
    }
  }

  private getHealingLevel(task: Task): number {
    // Check retry count to determine which level we're at
    if (task.retryCount < 1) return 1;
    if (task.retryCount < 2) return 2;
    if (task.retryCount < 3) return 3;
    if (task.retryCount < 4) return 4;
    return 5;
  }

  /** Level 1: Retry with a reformulated prompt */
  private async retryWithBetterPrompt(task: Task, error: string) {
    addTaskLog(task.id, 'info', 'Level 1: Retrying with improved prompt', 'self-healing');

    const enhancedInput = `${task.input}

IMPORTANT: A previous attempt failed with this error: ${error}
${isExecutionTimeout(error)
  ? 'Reuse previously collected evidence. Perform at most two missing searches, then produce a partial answer with explicit evidence gaps. Do not restart the full research.'
  : 'Please avoid this error and try a different approach. Be more careful and methodical.'}`;

    updateTask(task.id, {
      status: 'pending',
      retryCount: task.retryCount + 1,
      error: undefined,
    });

    // Re-execute
    if (task.assigneeId) {
      const agent = getAgent(task.assigneeId);
      if (agent) {
        const updatedTask = getTask(task.id)!;
        agentRuntime.execute(agent, { ...updatedTask, input: enhancedInput } as Task).catch(() => {});
      }
    }
  }

  /** Level 2: Try a different agent */
  private async reassignAgent(task: Task, error: string) {
    addTaskLog(task.id, 'info', 'Level 2: Reassigning to a different agent', 'self-healing');

    const currentAgent = task.assigneeId ? getAgent(task.assigneeId) : undefined;
    const agents = currentAgent ? listAgents({ role: currentAgent.role }) : [];
    const alternativeAgent = agents.find(a =>
      a.id !== task.assigneeId &&
      getActiveExecutionCount(a.id) < (a.config.maxConcurrent || 1)
    );

    if (!alternativeAgent) {
      addTaskLog(task.id, 'warn', 'No alternative agent available, moving to level 3', 'self-healing');
      return this.retryWithFreshContext(task, error);
    }

    updateTask(task.id, {
      status: 'pending',
      assigneeId: alternativeAgent.id,
      retryCount: task.retryCount + 1,
      error: undefined,
    });

    const updatedTask = getTask(task.id)!;
    agentRuntime.execute(alternativeAgent, updatedTask).catch(() => {});
  }

  /** Level 3: Retry without adding the previous failure text to the prompt. */
  private async retryWithFreshContext(task: Task, error: string) {
    addTaskLog(task.id, 'info', 'Level 3: Retrying with fresh context', 'self-healing');

    if (task.assigneeId) {
      const agent = getAgent(task.assigneeId);
      if (agent) {
        updateTask(task.id, {
          status: 'pending',
          retryCount: task.retryCount + 1,
          error: undefined,
        });

        const updatedTask = getTask(task.id)!;

        try {
          await agentRuntime.execute(agent, updatedTask);
        } catch (err: any) {
          addTaskLog(task.id, 'error', `Level 3 failed: ${err.message}`, 'self-healing');
        }
      }
    }
  }

  /** Level 4: Break task into smaller pieces */
  private async decomposeSmaller(task: Task, error: string) {
    addTaskLog(task.id, 'info', 'Level 4: Decomposing into smaller subtasks', 'self-healing');

    // This would normally use MasterAgent.decompose, but simplified here
    updateTask(task.id, {
      retryCount: task.retryCount + 1,
      error: `Level 4 decomposition attempted. Original error: ${error}`,
    });

    // Escalate since decomposition in self-healing is complex
    return this.escalateToSupervisor(task, error);
  }

  /** Level 5: Give up and notify the supervisor */
  private async escalateToSupervisor(task: Task, error: string, recoveryNote?: string) {
    addTaskLog(task.id, 'error', recoveryNote || 'Automatic recovery stopped; human review is required.', 'self-healing');

    updateTask(task.id, { status: 'failed', error, completedAt: new Date().toISOString() });

    const notif = createNotification({
      type: 'needs_input',
      title: `Task needs attention: ${task.title}`,
      message: `${recoveryNote || `Tried ${task.retryCount} recovery strategies.`} Last error: ${error} Please review and intervene.`,
      taskId: task.id,
    });

    eventBus.emit('notification', { notification: notif });
  }
}

export function isNonRetryableExecutionError(error: string): boolean {
  return [
    /AGENT_(?:MAX_TURNS|MODEL_TRUNCATED|MODEL_BLOCKED|EMPTY_OUTPUT|STOPPED)/i,
    /TOOL_REPLAY_BLOCKED|RECOVERY_REQUIRES_REVIEW/i,
    /(?:exceeded.*(?:monthly|quota)|insufficient_quota|quota.*(?:exceeded|exhausted)|billing.*(?:limit|disabled)|payment required)/i,
    /(?:invalid api key|incorrect api key|unauthorized|forbidden|permission denied)/i,
    /exceeded token budget/i,
    /exceeded max output length/i,
    /approval required/i,
    /publish confirmation required/i,
    /dangerous shell command/i,
    /authentication.+(?:missing|required|unavailable)/i,
  ].some(pattern => pattern.test(error || ''));
}

function isExecutionTimeout(error: string): boolean {
  return /EXECUTION_(?:IDLE|WALL)_TIMEOUT|Timeout after \d+ms waiting for session\.idle/i.test(error);
}
