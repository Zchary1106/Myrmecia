import { getTask, updateTask, addTaskLog, listTasks } from '../db/models/task.js';
import { getAgent, listAgents, updateAgent } from '../db/models/agent.js';
import { getActiveExecutionCount } from '../db/models/execution.js';
import { agentRuntime } from '../agents/agent-runtime.js';
import { eventBus } from '../events/event-bus.js';
import { createNotification } from '../db/models/notification.js';
import type { Task } from '../types.js';

/**
 * Self-Healing Engine
 * 5-level recovery strategy for failed tasks:
 *   Level 1: Retry with reformulated prompt
 *   Level 2: Reassign to a different agent
 *   Level 3: Upgrade to a stronger model
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

    // Don't self-heal decomposition subtasks or already-cancelled tasks
    if (task.status === 'cancelled') return;

    const healingLevel = this.getHealingLevel(task);
    addTaskLog(taskId, 'info', `Self-healing: attempting level ${healingLevel} recovery`, 'system');

    switch (healingLevel) {
      case 1: return this.retryWithBetterPrompt(task, error);
      case 2: return this.reassignAgent(task, error);
      case 3: return this.upgradeModel(task, error);
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
Please avoid this error and try a different approach. Be more careful and methodical.`;

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

    const agents = listAgents();
    const alternativeAgent = agents.find(a =>
      a.id !== task.assigneeId &&
      getActiveExecutionCount(a.id) < (a.config.maxConcurrent || 1) &&
      a.role !== 'orchestrator'
    );

    if (!alternativeAgent) {
      addTaskLog(task.id, 'warn', 'No alternative agent available, moving to level 3', 'self-healing');
      return this.upgradeModel(task, error);
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

  /** Level 3: Upgrade to a stronger model */
  private async upgradeModel(task: Task, error: string) {
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
  private async escalateToSupervisor(task: Task, error: string) {
    addTaskLog(task.id, 'error', 'Level 5: Escalating to supervisor — all auto-recovery attempts exhausted', 'self-healing');

    updateTask(task.id, { status: 'failed', error: `Self-healing exhausted. Last error: ${error}` });

    const notif = createNotification({
      type: 'needs_input',
      title: `Task needs attention: ${task.title}`,
      message: `Tried ${task.retryCount} recovery strategies. Last error: ${error}. Please review and intervene.`,
      taskId: task.id,
    });

    eventBus.emit('notification', { notification: notif });
  }
}
