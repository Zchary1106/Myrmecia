/**
 * Stale Task Cleanup Worker
 * Finds tasks stuck in 'running' state beyond timeout and marks them as failed.
 */

import { listTasks, updateTask, addTaskLog } from '../db/models/task.js';
import { createNotification } from '../db/models/notification.js';
import type { BackgroundWorker, WorkerContext, WorkerResult } from './scheduler.js';

const TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export const staleTaskCleanupWorker: BackgroundWorker = {
  id: 'stale-task-cleanup',
  name: 'Stale Task Cleanup',
  intervalMs: 15 * 60 * 1000, // 15 minutes
  enabled: true,

  async run(ctx: WorkerContext): Promise<WorkerResult> {
    const runningTasks = listTasks({ status: 'running' });
    let cleaned = 0;

    for (const task of runningTasks) {
      if (!task.startedAt) continue;
      const elapsed = Date.now() - new Date(task.startedAt).getTime();

      if (elapsed > TASK_TIMEOUT_MS) {
        updateTask(task.id, {
          status: 'failed',
          error: `Task timed out after ${Math.round(elapsed / 60000)} minutes`,
        });
        addTaskLog(task.id, 'warn', 'Task marked as failed (timeout)', 'stale-task-cleanup');
        createNotification({
          type: 'needs_input',
          title: `Task timed out: ${task.title}`,
          message: `Task ${task.id} was running for ${Math.round(elapsed / 60000)} minutes and has been marked as failed.`,
          taskId: task.id,
        });
        cleaned++;
      }
    }

    return {
      success: true,
      message: cleaned > 0 ? `Cleaned ${cleaned} stale tasks` : 'No stale tasks',
    };
  },
};
