import type { BackgroundWorker, WorkerContext, WorkerResult } from './scheduler.js';
import { listPipelines } from '../db/models/pipeline.js';
import { listTasks } from '../db/models/task.js';
import { workspaceManager } from '../workspace/workspace-manager.js';

const DEFAULT_RETENTION_HOURS = 7 * 24;
const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);
const TERMINAL_PIPELINE_STATUSES = new Set(['done', 'failed']);

function retentionMs(): number {
  const configured = Number(process.env.MYRMECIA_WORKSPACE_RETENTION_HOURS ?? DEFAULT_RETENTION_HOURS);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_RETENTION_HOURS * 60 * 60 * 1000;
  return configured * 60 * 60 * 1000;
}

function activeWorkspaceKeys(): Set<string> {
  const keys = new Set<string>();
  for (const task of listTasks()) {
    if (!TERMINAL_TASK_STATUSES.has(task.status)) keys.add(`task:${task.id}`);
  }
  for (const pipeline of listPipelines()) {
    if (!TERMINAL_PIPELINE_STATUSES.has(pipeline.status)) keys.add(`pipeline:${pipeline.id}`);
  }
  return keys;
}

export const workspaceCleanupWorker: BackgroundWorker = {
  id: 'workspace-cleanup',
  name: 'Workspace Cleanup',
  intervalMs: 30 * 60 * 1000,
  enabled: true,

  async run(ctx: WorkerContext): Promise<WorkerResult> {
    const result = await workspaceManager.cleanupExpiredWorkspaces({
      retentionMs: retentionMs(),
      protectedWorkspaceKeys: activeWorkspaceKeys(),
    });
    if (result.errors.length > 0) {
      ctx.logger.warn({ errors: result.errors }, 'Some expired workspaces could not be removed');
    }
    return {
      success: result.errors.length === 0,
      message: `Removed ${result.removed} expired workspaces; retained ${result.retained}; protected ${result.protected}`,
      data: result,
    };
  },
};
