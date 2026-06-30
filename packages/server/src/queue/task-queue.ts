import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { eventBus } from '../events/event-bus.js';
import { createTask, getTask, updateTask, addTaskLog, listTasks } from '../db/models/task.js';
import { AgentManager } from '../agents/agent-manager.js';
import { metrics } from '../observability/telemetry.js';
import { logger } from '../lib/logger.js';
import type { Task, TaskMode, Priority } from '../types.js';

const QUEUE_NAME = 'agent-factory-tasks';

// Priority mapping: lower number = higher priority in BullMQ
const PRIORITY_MAP: Record<string, number> = {
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4,
};

export class TaskQueue {
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private queueEvents: QueueEvents | null = null;
  private agentManager: AgentManager;
  private redis: IORedis | null = null;
  private useRedis: boolean;

  constructor(agentManager: AgentManager) {
    this.agentManager = agentManager;
    this.useRedis = !!process.env.REDIS_URL || !!process.env.REDIS_HOST;

    if (this.useRedis) {
      this.initBullMQ();
    } else {
      logger.info('Redis not configured — using in-memory queue (set REDIS_URL for persistence)');
    }

    // Listen for task completions to process waiting tasks
    eventBus.on('task:done', () => { metrics.queueDepth.add(-1, { direction: 'dec' }); this.processNext(); });
    eventBus.on('task:failed', () => { metrics.queueDepth.add(-1, { direction: 'dec' }); this.processNext(); });
  }

  /** Initialize BullMQ with Redis */
  private initBullMQ() {
    const connection = process.env.REDIS_URL
      ? new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
      : new IORedis({
          host: process.env.REDIS_HOST || 'localhost',
          port: Number(process.env.REDIS_PORT) || 6379,
          maxRetriesPerRequest: null,
        });

    this.redis = connection;

    this.queue = new Queue(QUEUE_NAME, { connection });

    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        const { taskId } = job.data;
        await this.processJob(taskId, job);
      },
      {
        connection,
        concurrency: 6, // Support 6+ concurrent agents
      }
    );

    this.worker.on('failed', (job, err) => {
      if (job) {
        addTaskLog(job.data.taskId, 'error', `Queue worker error: ${err.message}`, 'system');
      }
    });

    this.queueEvents = new QueueEvents(QUEUE_NAME, { connection });

    logger.info('BullMQ connected to Redis');
  }

  /** Enqueue a new task */
  async enqueue(data: {
    title: string;
    description: string;
    mode: TaskMode;
    priority?: Priority;
    assigneeId?: string;
    input: string;
    parentTaskId?: string;
    pipelineId?: string;
    stageIndex?: number;
    dependsOn?: string[];
    workdir?: string;
    workspacePath?: string;
    workspaceId?: string;
    domainId?: string;
  }): Promise<Task> {
    const task = createTask({
      ...data,
      createdBy: data.parentTaskId ? 'master' : 'user',
    });

    eventBus.emit('task:created', { taskId: task.id, task, workspaceId: task.workspaceId });
    addTaskLog(task.id, 'info', `Task created: ${task.title}`, 'system');
    metrics.queueDepth.add(1, { direction: 'inc' });

    if (this.queue) {
      // Use BullMQ
      await this.queue.add('execute-task', { taskId: task.id }, {
        priority: PRIORITY_MAP[task.priority] || 3,
        jobId: task.id,
        attempts: task.maxRetries + 1,
        backoff: { type: 'exponential', delay: 5000 },
      });
      updateTask(task.id, { status: 'queued' });
    } else {
      // In-memory: try to execute immediately
      await this.tryExecute(task);
    }

    return getTask(task.id)!;
  }

  /** Process a BullMQ job */
  private async processJob(taskId: string, job?: Job) {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status === 'cancelled') return;

    // Check dependencies
    if (!this.checkDependencies(task)) {
      // Re-queue with delay
      if (this.queue) {
        await this.queue.add('execute-task', { taskId }, {
          delay: 5000,
          priority: PRIORITY_MAP[task.priority] || 3,
        });
      }
      return;
    }

    // Find agent
    let agentId = task.assigneeId;
    if (!agentId) {
      const agent = this.agentManager.findAvailableAgent(task.mode === 'direct' ? '' : 'dev');
      if (!agent) {
        // No agent available, re-queue
        if (this.queue) {
          await this.queue.add('execute-task', { taskId }, {
            delay: 10000,
            priority: PRIORITY_MAP[task.priority] || 3,
          });
        }
        return;
      }
      agentId = agent.id;
    }

    updateTask(taskId, { status: 'assigned', assigneeId: agentId });
    eventBus.emit('task:assigned', { taskId, agentId, workspaceId: getTask(taskId)?.workspaceId });

    try {
      await this.agentManager.executeTask(agentId, getTask(taskId)!);
    } catch (err: any) {
      this.recordExecutionFailure(taskId, err, job);
      throw err;
    }
  }

  private recordExecutionFailure(taskId: string, err: any, job?: Job) {
    const current = getTask(taskId);
    if (!current || ['done', 'failed', 'cancelled'].includes(current.status)) return;

    const attemptsMade = job ? job.attemptsMade + 1 : current.retryCount + 1;
    const maxAttempts = job?.opts.attempts ?? (current.maxRetries + 1);
    const willRetry = attemptsMade < maxAttempts;
    const error = err?.message || String(err);

    const updated = updateTask(taskId, {
      status: willRetry ? 'queued' : 'failed',
      retryCount: Math.max(current.retryCount, attemptsMade - 1),
      error,
      completedAt: willRetry ? null : new Date().toISOString(),
    });

    addTaskLog(
      taskId,
      willRetry ? 'warn' : 'error',
      willRetry
        ? `Execution attempt failed; retrying (${attemptsMade}/${maxAttempts}): ${error}`
        : `Execution failed after ${attemptsMade}/${maxAttempts} attempts: ${error}`,
      'system',
    );

    if (!willRetry && updated) {
      eventBus.emit('task:failed', { taskId, task: updated, error, workspaceId: updated.workspaceId });
    }
  }

  /** Check if a task's dependencies are met */
  private checkDependencies(task: Task): boolean {
    if (!task.dependsOn || task.dependsOn.length === 0) return true;
    return task.dependsOn.every(depId => {
      const dep = getTask(depId);
      return dep?.status === 'done';
    });
  }

  /** In-memory mode: try to execute a task */
  private async tryExecute(task: Task) {
    if (task.status !== 'pending') return;
    if (!this.checkDependencies(task)) {
      updateTask(task.id, { status: 'queued' });
      return;
    }

    let agentId = task.assigneeId;
    if (!agentId && task.mode === 'direct') return;

    if (!agentId) {
      updateTask(task.id, { status: 'queued' });
      return;
    }

    updateTask(task.id, { status: 'assigned', assigneeId: agentId });
    eventBus.emit('task:assigned', { taskId: task.id, agentId, workspaceId: task.workspaceId });

    // Execute asynchronously
    this.agentManager.executeTask(agentId, getTask(task.id)!).catch(err => {
      logger.error({ taskId: task.id, err: err.message }, 'Task execution failed');
      const current = getTask(task.id)!;
      if (current.retryCount < current.maxRetries) {
        updateTask(task.id, { status: 'pending', retryCount: current.retryCount + 1 });
        addTaskLog(task.id, 'warn', `Retrying (${current.retryCount + 1}/${current.maxRetries})`, 'system');
        this.tryExecute(getTask(task.id)!);
      } else {
        this.recordExecutionFailure(task.id, err);
      }
    });
  }

  /** Process next queued task (in-memory mode) */
  private async processNext() {
    if (this.queue) return; // BullMQ handles this

    const queued = listTasks({ status: 'queued' });
    const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
    queued.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

    for (const task of queued) {
      if (this.checkDependencies(task)) {
        updateTask(task.id, { status: 'pending' });
        await this.tryExecute(getTask(task.id)!);
      }
    }
  }

  /** Cancel a task and stop its runtime if it is currently executing. */
  async cancelTask(taskId: string): Promise<Task> {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (['done', 'failed', 'cancelled'].includes(task.status)) return task;

    if (task.status === 'running' || task.status === 'assigned') {
      this.agentManager.cancelTask(taskId);
    }

    if (this.queue) {
      const job = await this.queue.getJob(taskId);
      if (job) {
        try {
          await job.remove();
        } catch (err: any) {
          addTaskLog(taskId, 'warn', `Queue job removal skipped: ${err.message}`, 'system');
        }
      }
    }

    const cancelled = updateTask(taskId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    })!;
    addTaskLog(taskId, 'warn', 'Task cancelled by user', 'system');
    eventBus.emit('task:cancelled', { taskId, task: cancelled, workspaceId: cancelled.workspaceId });
    return cancelled;
  }

  /** Retry a failed or cancelled task with the same assignment and input. */
  async retryTask(taskId: string): Promise<Task> {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!['failed', 'cancelled'].includes(task.status)) {
      throw new Error(`Task ${taskId} is not retryable from status ${task.status}`);
    }

    const retryCount = task.retryCount + 1;
    updateTask(taskId, {
      status: 'pending',
      retryCount,
      completedAt: null,
      startedAt: null,
      error: null,
    });
    addTaskLog(taskId, 'info', `Retry requested (${retryCount})`, 'system');

    if (this.queue) {
      await this.queue.add('execute-task', { taskId }, {
        priority: PRIORITY_MAP[task.priority] || 3,
        jobId: `${taskId}-retry-${Date.now()}`,
        attempts: task.maxRetries + 1,
        backoff: { type: 'exponential', delay: 5000 },
      });
      updateTask(taskId, { status: 'queued' });
    } else {
      await this.tryExecute(getTask(taskId)!);
    }

    const retried = getTask(taskId)!;
    eventBus.emit('task:updated', { taskId, task: retried, workspaceId: retried.workspaceId });
    return retried;
  }

  /**
   * Server restart recovery.
   * Re-enqueue any tasks that were 'running' or 'assigned' when server crashed.
   */
  async recoverRunningTasks() {
    const runningTasks = listTasks({ status: 'running' });
    const assignedTasks = listTasks({ status: 'assigned' });
    const toRecover = [...runningTasks, ...assignedTasks];

    if (toRecover.length === 0) return;

    logger.info({ count: toRecover.length }, 'Recovering interrupted tasks');

    for (const task of toRecover) {
      addTaskLog(task.id, 'warn', 'Task interrupted by server restart — re-queuing', 'system');
      updateTask(task.id, { status: 'pending' });

      if (this.queue) {
        await this.queue.add('execute-task', { taskId: task.id }, {
          priority: PRIORITY_MAP[task.priority] || 3,
        });
      } else {
        await this.tryExecute(getTask(task.id)!);
      }
    }
  }

  /** Get queue stats */
  async getStats() {
    if (this.queue) {
      const [waiting, active, completed, failed] = await Promise.all([
        this.queue.getWaitingCount(),
        this.queue.getActiveCount(),
        this.queue.getCompletedCount(),
        this.queue.getFailedCount(),
      ]);
      return { waiting, active, completed, failed, backend: 'redis' };
    }

    const tasks = listTasks();
    return {
      waiting: tasks.filter(t => ['pending', 'queued'].includes(t.status)).length,
      active: tasks.filter(t => t.status === 'running').length,
      completed: tasks.filter(t => t.status === 'done').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      backend: 'memory',
    };
  }

  /** Shutdown gracefully */
  async shutdown() {
    if (this.worker) await this.worker.close();
    if (this.queueEvents) await this.queueEvents.close();
    if (this.queue) await this.queue.close();
    if (this.redis) this.redis.disconnect();
  }
}
