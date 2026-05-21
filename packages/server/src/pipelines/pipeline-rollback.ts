import { execSync } from 'child_process';
import { eventBus } from '../events/event-bus.js';
import { getPipeline, updatePipeline, listPipelines } from '../db/models/pipeline.js';
import { createNotification } from '../db/models/notification.js';
import { workspaceManager } from '../workspace/workspace-manager.js';
import { logger } from '../lib/logger.js';

export class PipelineRollback {
  constructor() {
    eventBus.on('task:failed', (event) => {
      const { taskId } = event.payload as { taskId: string; error?: string };
      this.onTaskFailed(taskId).catch(err =>
        logger.error({ taskId, error: err.message }, 'Pipeline rollback failed')
      );
    });
    logger.info('Pipeline rollback handler active');
  }

  private async onTaskFailed(taskId: string): Promise<void> {
    const pipelines = listPipelines({ status: 'running' });

    for (const pipeline of pipelines) {
      const stageIdx = pipeline.stages.findIndex((s: any) => s.taskId === taskId);
      if (stageIdx === -1) continue;

      logger.info({ pipelineId: pipeline.id, stageIndex: stageIdx }, 'Stage failed, initiating rollback');

      await this.gitRollback(pipeline.id, stageIdx);
      this.updateStageStatus(pipeline.id, stageIdx);

      eventBus.emit('pipeline:stage:rolled_back', {
        pipelineId: pipeline.id,
        stageIndex: stageIdx,
        taskId,
      });
      return;
    }
  }

  getCheckpoint(pipelineId: string, stageIndex: number): string | undefined {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) return undefined;
    const checkpoints = JSON.parse((pipeline as any).stageCheckpoints || '{}');
    return checkpoints[String(stageIndex)];
  }

  private async gitRollback(pipelineId: string, stageIndex: number): Promise<void> {
    const sha = this.getCheckpoint(pipelineId, stageIndex);
    if (!sha) {
      logger.warn({ pipelineId, stageIndex }, 'No checkpoint found, skipping git rollback');
      return;
    }

    const ws = workspaceManager.getWorkspaceInfo(pipelineId, 'pipeline');
    if (!ws) {
      logger.warn({ pipelineId }, 'No workspace found, skipping git rollback');
      return;
    }

    try {
      execSync(`git reset --hard ${sha}`, {
        cwd: ws.path,
        encoding: 'utf-8',
        timeout: 30000,
      });
      logger.info({ pipelineId, stageIndex, sha }, 'Git rollback successful');
    } catch (err: any) {
      logger.error({ pipelineId, stageIndex, error: err.message }, 'Git rollback failed');
    }
  }

  updateStageStatus(pipelineId: string, stageIndex: number): void {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) return;

    const stages = [...pipeline.stages];
    stages[stageIndex] = { ...stages[stageIndex], status: 'rolled_back' };
    updatePipeline(pipelineId, { stages, status: 'awaiting_retry' as any });

    createNotification({
      type: 'pipeline_stage',
      title: 'Pipeline Stage Rolled Back',
      message: `Pipeline "${pipeline.name}" stage ${stageIndex} (${stages[stageIndex].name}) failed and was rolled back. Ready for retry.`,
      pipelineId,
    });
  }
}

export function saveStageCheckpoint(pipelineId: string, stageIndex: number, sha: string): void {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;
  const checkpoints = JSON.parse((pipeline as any).stageCheckpoints || '{}');
  checkpoints[String(stageIndex)] = sha;
  updatePipeline(pipelineId, { stageCheckpoints: JSON.stringify(checkpoints) } as any);
}
