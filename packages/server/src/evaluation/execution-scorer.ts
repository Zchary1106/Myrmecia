import { eventBus } from '../events/event-bus.js';
import { getTask } from '../db/models/task.js';
import { listExecutions } from '../db/models/execution.js';
import { createExecutionScore } from '../db/models/execution-score.js';
import { logger } from '../lib/logger.js';

interface BaseScoreInput {
  hasError: boolean;
  durationMs: number;
  avgDurationMs: number;
  outputLength: number;
  inputLength: number;
}

export class ExecutionScorer {
  constructor() {
    eventBus.on('task:done', (event) => {
      const { taskId } = event.payload as { taskId: string };
      this.score(taskId).catch(err =>
        logger.warn({ taskId, error: err.message }, 'Execution scoring failed')
      );
    });
    logger.info('Execution scorer active');
  }

  calculateBaseScore(input: BaseScoreInput): number {
    let score = 100;
    if (input.hasError) score -= 30;
    if (input.avgDurationMs > 0) {
      const ratio = input.durationMs / input.avgDurationMs;
      if (ratio > 2) score -= 20;
      else if (ratio > 1.5) score -= 10;
    }
    if (input.outputLength < 50 && input.inputLength > 0) score -= 10;
    if (input.outputLength > 50000) score -= 5;
    return Math.max(0, Math.min(100, score));
  }

  computeRouteWeight(avgScore: number): number {
    return Math.max(0.1, Math.min(1.0, avgScore / 100));
  }

  async score(taskId: string): Promise<void> {
    const task = getTask(taskId);
    if (!task || !task.assigneeId) return;

    const executions = listExecutions({ taskId });
    const execution = executions[executions.length - 1];
    if (!execution) return;

    const durationMs = execution.completedAt && execution.startedAt
      ? new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime()
      : 0;

    const hasError = execution.status === 'failed' || !!(task as any).error;
    const outputLength = (task.output || '').length;
    const inputLength = (task.input || '').length;
    const avgDurationMs = (task as any).assignee?.stats?.avgDurationMs || durationMs;

    const baseScore = this.calculateBaseScore({
      hasError, durationMs, avgDurationMs, outputLength, inputLength,
    });

    const llmScore: number | null = null;
    let dimensions: Record<string, number | undefined> = {};
    const finalScore = baseScore;

    // Length/timing heuristics are operational diagnostics, not a quality review.
    dimensions = { operational: baseScore };

    createExecutionScore({
      executionId: execution.id,
      agentId: task.assigneeId,
      taskId,
      baseScore,
      llmScore,
      finalScore,
      dimensions,
    });

    eventBus.emit('score:recorded', { taskId, agentId: task.assigneeId, finalScore, scoreSource: 'operational_heuristic', affectsRouting: false });
    logger.info({ taskId, agentId: task.assigneeId, finalScore, affectsRouting: false }, 'Operational execution scored; quality not verified');
  }
}
