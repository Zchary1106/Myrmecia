import { CronExpressionParser } from 'cron-parser';
import type { ExternalAgentSchedule, WSEventType } from '@myrmecia/shared';
import {
  claimExternalAgentSchedule,
  listExternalAgentSchedules,
  updateExternalAgentSchedule,
} from '../db/models/external-agent.js';
import { getExternalAgentRuntime, type ExternalAgentRuntime } from '../agents/external-agent-runtime.js';
import { eventBus, type BusEvent } from '../events/event-bus.js';
import { logger } from '../lib/logger.js';

export function nextExternalAgentRunAt(
  schedule: Pick<ExternalAgentSchedule, 'triggerType' | 'cron' | 'runAt' | 'timezone'>,
  from = new Date(),
): string | undefined {
  if (schedule.triggerType === 'once') {
    if (!schedule.runAt || !Number.isFinite(Date.parse(schedule.runAt))) throw new Error('A valid runAt is required for a one-time schedule.');
    return schedule.runAt;
  }
  if (schedule.triggerType === 'cron') {
    if (!schedule.cron) throw new Error('A cron expression is required for a cron schedule.');
    return CronExpressionParser.parse(schedule.cron, {
      currentDate: from,
      tz: schedule.timezone || 'UTC',
    }).next().toDate().toISOString();
  }
  return undefined;
}

export class ExternalAgentScheduleWorker {
  private timer?: NodeJS.Timeout;

  constructor(private readonly runtime: Pick<ExternalAgentRuntime, 'run'> = getExternalAgentRuntime()) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(error => logger.warn({ err: error.message }, 'External Agent schedule scan failed'));
    }, intervalMs);
    this.timer.unref?.();
    void this.runOnce().catch(error => logger.warn({ err: error.message }, 'Initial external Agent schedule scan failed'));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(now = new Date()): Promise<number> {
    const dueAt = now.toISOString();
    const schedules = listExternalAgentSchedules({ enabled: true })
      .filter(schedule => schedule.nextRunAt && schedule.nextRunAt <= dueAt);
    let dispatched = 0;
    for (const schedule of schedules) {
      const nextRunAt = schedule.triggerType === 'cron'
        ? nextExternalAgentRunAt(schedule, now)
        : undefined;
      const keepEnabled = schedule.triggerType === 'cron';
      if (!claimExternalAgentSchedule(schedule.id, schedule.workspaceId || 'default', dueAt, nextRunAt, keepEnabled)) continue;
      try {
        await this.runtime.run(
          schedule.externalAgentId,
          schedule.workspaceId || 'default',
          { ...schedule.invocation, workspaceId: schedule.workspaceId },
          schedule.triggerType,
        );
        dispatched += 1;
      } catch (error) {
        logger.warn({ scheduleId: schedule.id, err: error instanceof Error ? error.message : String(error) }, 'External Agent scheduled run failed');
      }
    }
    return dispatched;
  }
}

const TASK_EVENT_TYPES: WSEventType[] = ['task:started', 'task:done', 'task:failed', 'task:cancelled'];

/**
 * Dispatches externally managed Agents after an internal task lifecycle event.
 * The event is deliberately handled in-process: it reacts to events emitted by
 * the runtime, while every resulting external execution is persisted as an
 * ExternalAgentRun by the runtime itself.
 */
export class ExternalAgentTaskEventWorker {
  private started = false;
  private readonly handler = (event: BusEvent) => {
    void this.dispatch(event).catch(error => {
      logger.warn({ eventType: event.type, err: error instanceof Error ? error.message : String(error) }, 'External Agent task-event dispatch failed');
    });
  };

  constructor(private readonly runtime: Pick<ExternalAgentRuntime, 'run'> = getExternalAgentRuntime()) {}

  start(): void {
    if (this.started) return;
    eventBus.on('*', this.handler);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    eventBus.off('*', this.handler);
    this.started = false;
  }

  async dispatch(event: BusEvent): Promise<number> {
    if (!TASK_EVENT_TYPES.includes(event.type)) return 0;
    const payload = event.payload as { taskId?: unknown; workspaceId?: unknown };
    const taskId = typeof payload?.taskId === 'string' ? payload.taskId : undefined;
    const workspaceId = typeof payload?.workspaceId === 'string' && payload.workspaceId ? payload.workspaceId : 'default';
    if (!taskId) return 0;

    const schedules = listExternalAgentSchedules({ workspaceId, enabled: true })
      .filter(schedule => schedule.triggerType === 'task_event' && schedule.eventType === event.type);
    let dispatched = 0;

    for (const schedule of schedules) {
      updateExternalAgentSchedule(schedule.id, workspaceId, { lastRunAt: event.timestamp });
      try {
        await this.runtime.run(
          schedule.externalAgentId,
          workspaceId,
          { ...schedule.invocation, taskId, workspaceId },
          'task_event',
        );
        dispatched += 1;
      } catch (error) {
        logger.warn({
          scheduleId: schedule.id,
          taskId,
          err: error instanceof Error ? error.message : String(error),
        }, 'External Agent task-event run failed');
      }
    }

    return dispatched;
  }
}
