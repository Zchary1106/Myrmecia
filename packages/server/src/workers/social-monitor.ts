import type { AgentManager } from '../agents/agent-manager.js';
import type { TaskQueue } from '../queue/task-queue.js';
import { eventBus } from '../events/event-bus.js';
import { getTask } from '../db/models/task.js';
import {
  getSocialMonitorJobByTaskId,
  listSocialMonitorJobs,
  updateSocialMonitorJob,
} from '../db/models/social-workflow.js';
import { logger } from '../lib/logger.js';

export class SocialMonitorWorker {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly taskQueue: TaskQueue,
    private readonly agentManager: AgentManager,
  ) {
    eventBus.on('task:done', event => {
      const taskId = (event.payload as any)?.taskId;
      if (taskId) this.finishTask(taskId, true);
    });
    eventBus.on('task:failed', event => {
      const taskId = (event.payload as any)?.taskId;
      if (taskId) this.finishTask(taskId, false);
    });
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch(error => logger.warn({ err: error.message }, 'Social monitor worker failed'));
    }, intervalMs);
    this.timer.unref?.();
    this.runOnce().catch(error => logger.warn({ err: error.message }, 'Initial social monitor scan failed'));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(now = new Date()): Promise<number> {
    const dueJobs = listSocialMonitorJobs({
      status: 'pending',
      dueBefore: now.toISOString(),
    });
    let dispatched = 0;
    for (const job of dueJobs) {
      const agent = this.agentManager.findAvailableAgent('social-analytics');
      if (!agent) continue;
      const task = await this.taskQueue.enqueue({
        title: `社媒 ${job.windowHours}h 数据复盘 — ${job.platform}`,
        description: [
          '这是已经持久化的发布后监控任务，不要再次调用 social.monitor_plan。',
          '请尝试通过可用且已授权的平台工具采集真实指标。',
          '无法获得的字段必须标记 unavailable，不得猜测。',
          `content_id: ${job.contentId}`,
          `platform: ${job.platform}`,
          `publish_id: ${job.publishId}`,
          `window_hours: ${job.windowHours}`,
          `due_at: ${job.dueAt}`,
        ].join('\n'),
        input: JSON.stringify(job),
        mode: 'direct',
        assigneeId: agent.id,
        workspaceId: job.workspaceId,
      });
      updateSocialMonitorJob(job.id, { status: 'running', taskId: task.id });
      dispatched += 1;
    }
    return dispatched;
  }

  private finishTask(taskId: string, success: boolean): void {
    const job = getSocialMonitorJobByTaskId(taskId);
    if (!job) return;
    const task = getTask(taskId);
    updateSocialMonitorJob(job.id, {
      status: success ? 'completed' : 'failed',
      result: success
        ? { output: task?.output || '', completed_at: new Date().toISOString() }
        : { error: task?.error || 'monitor task failed', failed_at: new Date().toISOString() },
    });
  }
}
