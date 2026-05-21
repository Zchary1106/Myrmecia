import { eventBus } from '../events/event-bus.js';
import { getTask } from '../db/models/task.js';
import { listExecutions } from '../db/models/execution.js';
import { createExecutionScore, getAgentAvgScore } from '../db/models/execution-score.js';
import { updateAgent } from '../db/models/agent.js';
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

    let llmScore: number | null = null;
    let dimensions: Record<string, number | undefined> = {};
    let finalScore = baseScore;

    if (baseScore >= 40 && baseScore <= 80) {
      try {
        const llmResult = await this.llmJudge(task.input || '', task.output || '');
        llmScore = llmResult.score;
        dimensions = llmResult.dimensions;
        finalScore = llmScore;
      } catch (err: any) {
        logger.warn({ taskId, error: err.message }, 'LLM judge failed, using base score');
      }
    }

    createExecutionScore({
      executionId: execution.id,
      agentId: task.assigneeId,
      taskId,
      baseScore,
      llmScore,
      finalScore,
      dimensions,
    });

    const avgScore = getAgentAvgScore(task.assigneeId, 20);
    const weight = this.computeRouteWeight(avgScore);
    updateAgent(task.assigneeId, { routeWeight: weight } as any);

    eventBus.emit('score:recorded', { taskId, agentId: task.assigneeId, finalScore, routeWeight: weight });
    logger.info({ taskId, agentId: task.assigneeId, finalScore, routeWeight: weight }, 'Execution scored');
  }

  private async llmJudge(input: string, output: string): Promise<{
    score: number;
    dimensions: { completeness?: number; correctness?: number; codeQuality?: number };
  }> {
    const inputLen = input.length;
    const outputLen = output.length;
    const completeness = Math.min(100, (outputLen / Math.max(inputLen, 1)) * 20);
    const correctness = output.toLowerCase().includes('error') ? 40 : 80;
    const codeQuality = outputLen > 100 && outputLen < 30000 ? 80 : 50;
    const score = completeness * 0.4 + correctness * 0.4 + codeQuality * 0.2;
    return {
      score: Math.round(Math.max(0, Math.min(100, score))),
      dimensions: { completeness, correctness, codeQuality },
    };
  }
}
