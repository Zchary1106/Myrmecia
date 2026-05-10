import { eventBus } from '../events/event-bus.js';
import { createTask, getTask, updateTask, addTaskLog } from '../db/models/task.js';
import { getAgent, listAgents } from '../db/models/agent.js';
import { getActiveExecutionCount } from '../db/models/execution.js';
import { createQualityLoopAttempt, listQualityLoopAttempts, updateQualityLoopAttempt } from '../db/models/quality-loop.js';
import { agentRuntime } from '../agents/agent-runtime.js';
import type { AgentDefinition, QualityLoopAttempt } from '../types.js';

/**
 * Quality Loop
 * Automatically runs review → fix cycles between Dev and Review agents.
 * Max 3 iterations to prevent infinite loops.
 */
export class QualityLoop {
  private maxIterations = 3;

  constructor() {
    // Watch for completed dev tasks to trigger review
    eventBus.on('task:done', (event) => {
      const { taskId } = event.payload as any;
      this.maybeReview(taskId);
    });
  }

  private async maybeReview(taskId: string) {
    const task = getTask(taskId);
    if (!task) return;

    // Only auto-review tasks from dev agent in pipeline mode
    if (task.mode !== 'pipeline') return;
    const agent = task.assigneeId ? getAgent(task.assigneeId) : null;
    if (!agent || !['developer', 'dev'].includes(agent.role)) return;

    const attempts = listQualityLoopAttempts({ taskId });
    const latestAttempt = attempts[attempts.length - 1];
    if (latestAttempt?.status === 'approved') return;
    if (attempts.length >= this.maxIterations) {
      addTaskLog(taskId, 'warn', `Quality Loop: max review rounds reached (${this.maxIterations})`, 'quality-loop');
      return;
    }

    const iteration = attempts.length + 1;
    addTaskLog(taskId, 'info', `Quality Loop: auto-review round ${iteration}/${this.maxIterations}`, 'quality-loop');

    // Find review agent
    const reviewAgent = listAgents().find(a =>
      (a.role === 'reviewer' || a.id === 'review') && this.hasCapacity(a)
    );

    if (!reviewAgent) {
      addTaskLog(taskId, 'info', 'Quality Loop: no review agent available, skipping', 'quality-loop');
      return;
    }

    let attempt: QualityLoopAttempt | undefined;

    // Run review
    const reviewPrompt = `Review the following code/output for quality, bugs, security issues, and best practices.

If everything looks good, respond with: APPROVED
If there are issues, list them clearly and respond with: NEEDS_FIX followed by the issues.

Output to review:
${task.output?.slice(0, 10000) || '(empty output)'}`;

    try {
      attempt = createQualityLoopAttempt({
        taskId,
        iteration,
        status: 'reviewing',
        reviewerAgentId: reviewAgent.id,
        developerAgentId: agent.id,
      });
      eventBus.emit('quality:updated', { taskId, attempt });

      const reviewTask = createTask({
        title: `Review: ${task.title}`,
        description: reviewPrompt,
        input: reviewPrompt,
        mode: 'direct',
        priority: task.priority,
        maxRetries: 0,
        assigneeId: reviewAgent.id,
        parentTaskId: task.id,
        createdBy: 'master',
      });
      attempt = updateQualityLoopAttempt(attempt.id, { reviewTaskId: reviewTask.id }) || attempt;
      eventBus.emit('quality:updated', { taskId, attempt });

      const reviewResult = await agentRuntime.execute(reviewAgent, reviewTask);

      const isApproved = reviewResult.output.includes('APPROVED');

      if (isApproved) {
        attempt = updateQualityLoopAttempt(attempt.id, {
          status: 'approved',
          reviewOutput: reviewResult.output,
          completedAt: new Date().toISOString(),
        }) || attempt;
        addTaskLog(taskId, 'info', 'Quality Loop: APPROVED by Review Agent', 'quality-loop');
        eventBus.emit('task:log', { taskId, message: '✅ Review passed' });
        eventBus.emit('quality:updated', { taskId, attempt });
        return;
      }

      // Needs fix — send back to dev agent
      attempt = updateQualityLoopAttempt(attempt.id, {
        status: 'needs_fix',
        reviewOutput: reviewResult.output,
      }) || attempt;
      addTaskLog(taskId, 'warn', 'Quality Loop: Review found issues, sending back for fix', 'quality-loop');
      eventBus.emit('quality:updated', { taskId, attempt });

      const fixPrompt = `The Review Agent found the following issues with your code. Please fix them:

${reviewResult.output}

Original output:
${task.output?.slice(0, 8000) || ''}`;

      if (!this.hasCapacity(agent)) {
        attempt = updateQualityLoopAttempt(attempt.id, {
          status: 'skipped',
          error: 'Developer agent was busy; auto-fix was skipped',
          completedAt: new Date().toISOString(),
        }) || attempt;
        addTaskLog(taskId, 'info', 'Quality Loop: Dev agent busy, skipping auto-fix', 'quality-loop');
        eventBus.emit('quality:updated', { taskId, attempt });
        return;
      }

      const fixTask = createTask({
        title: `Fix: ${task.title}`,
        description: fixPrompt,
        input: fixPrompt,
        mode: 'direct',
        priority: task.priority,
        maxRetries: 0,
        assigneeId: agent.id,
        parentTaskId: task.id,
        createdBy: 'master',
      });
      attempt = updateQualityLoopAttempt(attempt.id, {
        status: 'fixing',
        fixTaskId: fixTask.id,
      }) || attempt;
      eventBus.emit('quality:updated', { taskId, attempt });

      const fixResult = await agentRuntime.execute(agent, fixTask);

      // Update original task with fixed output
      updateTask(taskId, { output: fixResult.output });
      attempt = updateQualityLoopAttempt(attempt.id, {
        status: 'fixed',
        fixOutput: fixResult.output,
        completedAt: new Date().toISOString(),
      }) || attempt;
      addTaskLog(taskId, 'info', `Quality Loop: Fix applied (round ${iteration})`, 'quality-loop');
      eventBus.emit('quality:updated', { taskId, attempt });

      // Re-trigger review for next iteration
      this.maybeReview(taskId);
    } catch (err: any) {
      if (attempt) {
        attempt = updateQualityLoopAttempt(attempt.id, {
          status: 'failed',
          error: err.message,
          completedAt: new Date().toISOString(),
        }) || attempt;
        eventBus.emit('quality:updated', { taskId, attempt });
      }
      addTaskLog(taskId, 'error', `Quality Loop error: ${err.message}`, 'quality-loop');
    }
  }

  private hasCapacity(agent: AgentDefinition): boolean {
    return getActiveExecutionCount(agent.id) < (agent.config.maxConcurrent || 1);
  }

  async recoverInterruptedAttempts() {
    const attempts = listQualityLoopAttempts();
    const latestByTask = new Map<string, QualityLoopAttempt>();
    for (const attempt of attempts) {
      const current = latestByTask.get(attempt.taskId);
      if (!current || attempt.iteration > current.iteration) latestByTask.set(attempt.taskId, attempt);
    }

    for (const attempt of latestByTask.values()) {
      if (attempt.status === 'fixed') {
        await this.maybeReview(attempt.taskId);
        continue;
      }

      if (!['reviewing', 'fixing', 'needs_fix'].includes(attempt.status)) continue;

      const status = attempt.status === 'needs_fix' ? 'skipped' : 'failed';
      const error = attempt.status === 'needs_fix'
        ? 'Quality loop was interrupted before creating a fix task'
        : 'Quality loop attempt was interrupted by server restart';
      const recovered = updateQualityLoopAttempt(attempt.id, {
        status,
        error,
        completedAt: new Date().toISOString(),
      });
      addTaskLog(attempt.taskId, status === 'failed' ? 'error' : 'warn', `Quality Loop recovery: ${error}`, 'quality-loop');
      eventBus.emit('quality:updated', { taskId: attempt.taskId, attempt: recovered });
    }
  }
}
