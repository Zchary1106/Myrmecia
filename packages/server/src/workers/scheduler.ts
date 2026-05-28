/**
 * Background Worker Scheduler
 *
 * Manages periodic background workers that run independently.
 * Each worker has its own interval and error isolation.
 */

import { logger } from '../lib/logger.js';
import { eventBus } from '../events/event-bus.js';

// ---------- Types ----------

export interface WorkerContext {
  logger: typeof logger;
  emit: (type: string, payload: unknown) => void;
}

export interface WorkerResult {
  success: boolean;
  message?: string;
  data?: unknown;
}

export interface BackgroundWorker {
  id: string;
  name: string;
  intervalMs: number;
  enabled: boolean;
  run(context: WorkerContext): Promise<WorkerResult>;
}

// ---------- Scheduler ----------

export class WorkerScheduler {
  private workers: BackgroundWorker[] = [];
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;

  register(worker: BackgroundWorker): void {
    this.workers.push(worker);
    logger.info({ workerId: worker.id, interval: worker.intervalMs }, `Worker registered: ${worker.name}`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const context: WorkerContext = {
      logger,
      emit: (type, payload) => eventBus.emit(type as any, payload),
    };

    for (const worker of this.workers) {
      if (!worker.enabled) continue;

      // Run once immediately (after short delay to let server finish starting)
      setTimeout(() => this.executeWorker(worker, context), 5000);

      // Then on interval
      const timer = setInterval(() => this.executeWorker(worker, context), worker.intervalMs);
      this.timers.set(worker.id, timer);
    }

    logger.info({ count: this.workers.filter(w => w.enabled).length }, 'Worker scheduler started');
  }

  stop(): void {
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.running = false;
    logger.info('Worker scheduler stopped');
  }

  getStatus(): Array<{ id: string; name: string; enabled: boolean; intervalMs: number }> {
    return this.workers.map(w => ({
      id: w.id,
      name: w.name,
      enabled: w.enabled,
      intervalMs: w.intervalMs,
    }));
  }

  private async executeWorker(worker: BackgroundWorker, context: WorkerContext): Promise<void> {
    try {
      const result = await worker.run(context);
      if (result.message) {
        logger.debug({ workerId: worker.id, message: result.message }, `Worker [${worker.id}] completed`);
      }
    } catch (err: any) {
      logger.warn({ workerId: worker.id, error: err.message }, `Worker [${worker.id}] failed`);
    }
  }
}
