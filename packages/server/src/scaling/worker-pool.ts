import { logger } from '../lib/logger.js';
import { INSTANCE_ID } from './redis-pubsub.js';

export type WorkerMode = 'scheduler' | 'worker' | 'both';

export interface TaskJob {
  id: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface TaskResult {
  jobId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

type TaskHandler = (job: TaskJob) => Promise<TaskResult>;

/**
 * WorkerPool distributes task execution using BullMQ.
 * Falls back to direct in-process execution when REDIS_URL is not set.
 */
export class WorkerPool {
  public readonly mode: WorkerMode;
  private handlers = new Map<string, TaskHandler>();
  private queue: import('bullmq').Queue | null = null;
  private worker: import('bullmq').Worker | null = null;

  constructor() {
    this.mode = (process.env.WORKER_MODE as WorkerMode) || 'both';
  }

  async initialize(): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      logger.info({ mode: this.mode }, 'WorkerPool: no REDIS_URL, running in-process mode');
      return;
    }

    const { Queue, Worker } = await import('bullmq');
    const connection = { url: redisUrl };

    if (this.mode === 'scheduler' || this.mode === 'both') {
      this.queue = new Queue('af:tasks', { connection });
      logger.info('WorkerPool: scheduler queue initialized');
    }

    if (this.mode === 'worker' || this.mode === 'both') {
      this.worker = new Worker(
        'af:tasks',
        async (job) => {
          const taskJob: TaskJob = job.data;
          const handler = this.handlers.get(taskJob.type);
          if (!handler) {
            throw new Error(`No handler registered for task type: ${taskJob.type}`);
          }
          const result = await handler(taskJob);
          return result;
        },
        {
          connection,
          concurrency: Number(process.env.WORKER_CONCURRENCY) || 5,
        }
      );

      this.worker.on('completed', (job) => {
        logger.debug({ jobId: job?.id }, 'WorkerPool: job completed');
      });

      this.worker.on('failed', (job, err) => {
        logger.error({ jobId: job?.id, err: err.message }, 'WorkerPool: job failed');
      });

      logger.info({ instanceId: INSTANCE_ID }, 'WorkerPool: worker initialized');
    }
  }

  registerHandler(taskType: string, handler: TaskHandler): void {
    this.handlers.set(taskType, handler);
  }

  async enqueue(job: TaskJob): Promise<string> {
    if (this.queue) {
      const bullJob = await this.queue.add(job.type, job, {
        jobId: job.id,
        removeOnComplete: 100,
        removeOnFail: 500,
      });
      return bullJob.id || job.id;
    }

    // In-process fallback
    const handler = this.handlers.get(job.type);
    if (handler) {
      handler(job).catch((err) => {
        logger.error({ jobId: job.id, err }, 'WorkerPool: in-process job failed');
      });
    }
    return job.id;
  }

  async shutdown(): Promise<void> {
    if (this.worker) await this.worker.close();
    if (this.queue) await this.queue.close();
  }
}

export const workerPool = new WorkerPool();
