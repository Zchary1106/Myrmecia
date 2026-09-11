import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb } from '../src/db/database.js';
import { createExternalAgent, createExternalAgentSchedule, getExternalAgentSchedule } from '../src/db/models/external-agent.js';
import { ExternalAgentScheduleWorker, ExternalAgentTaskEventWorker, nextExternalAgentRunAt } from '../src/workers/external-agent-scheduler.js';

describe('ExternalAgentScheduleWorker', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-external-schedule-')), 'test.db');
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('calculates a timezone-aware next cron occurrence', () => {
    const next = nextExternalAgentRunAt(
      { triggerType: 'cron', cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' },
      new Date('2026-09-06T00:00:00.000Z'),
    );
    expect(next).toBe('2026-09-07T01:00:00.000Z');
  });

  it('claims a due one-time schedule once before dispatching it', async () => {
    const agent = createExternalAgent({
      workspaceId: 'default',
      name: 'Scheduled HTTP Agent',
      adapter: { kind: 'http', endpoint: 'https://agents.example.test/run', allowedHosts: ['agents.example.test'] },
    });
    const schedule = createExternalAgentSchedule({
      externalAgentId: agent.id,
      workspaceId: 'default',
      triggerType: 'once',
      runAt: '2026-09-06T00:00:00.000Z',
      invocation: { objective: 'Run once', constraints: [] },
      enabled: true,
      nextRunAt: '2026-09-06T00:00:00.000Z',
    });
    const calls: unknown[] = [];
    const worker = new ExternalAgentScheduleWorker({
      run: async (...args: unknown[]) => {
        calls.push(args);
        return {} as any;
      },
    } as any);
    const now = new Date('2026-09-06T00:01:00.000Z');
    expect(await worker.runOnce(now)).toBe(1);
    expect(await worker.runOnce(now)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(getExternalAgentSchedule(schedule.id, 'default')?.enabled).toBe(false);
  });

  it('dispatches task-event schedules only for the matching workspace and event type', async () => {
    const matchingAgent = createExternalAgent({
      workspaceId: 'workspace-a',
      name: 'Completion Agent',
      adapter: { kind: 'http', endpoint: 'https://agents.example.test/completion', allowedHosts: ['agents.example.test'] },
    });
    const differentWorkspaceAgent = createExternalAgent({
      workspaceId: 'workspace-b',
      name: 'Other Workspace Agent',
      adapter: { kind: 'http', endpoint: 'https://agents.example.test/other', allowedHosts: ['agents.example.test'] },
    });
    const matchingSchedule = createExternalAgentSchedule({
      externalAgentId: matchingAgent.id,
      workspaceId: 'workspace-a',
      triggerType: 'task_event',
      eventType: 'task:done',
      invocation: { objective: 'Review the completed task', constraints: [] },
      enabled: true,
    });
    createExternalAgentSchedule({
      externalAgentId: matchingAgent.id,
      workspaceId: 'workspace-a',
      triggerType: 'task_event',
      eventType: 'task:failed',
      invocation: { objective: 'This should not run', constraints: [] },
      enabled: true,
    });
    createExternalAgentSchedule({
      externalAgentId: differentWorkspaceAgent.id,
      workspaceId: 'workspace-b',
      triggerType: 'task_event',
      eventType: 'task:done',
      invocation: { objective: 'This should not run', constraints: [] },
      enabled: true,
    });

    const calls: unknown[][] = [];
    const worker = new ExternalAgentTaskEventWorker({
      run: async (...args: unknown[]) => {
        calls.push(args);
        return {} as any;
      },
    } as any);

    expect(await worker.dispatch({
      type: 'task:done',
      payload: { taskId: 'task-123', workspaceId: 'workspace-a' },
      timestamp: '2026-09-06T00:00:00.000Z',
    })).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      matchingAgent.id,
      'workspace-a',
      { objective: 'Review the completed task', constraints: [], taskId: 'task-123', workspaceId: 'workspace-a' },
      'task_event',
    ]);
    expect(getExternalAgentSchedule(matchingSchedule.id, 'workspace-a')?.lastRunAt).toBe('2026-09-06T00:00:00.000Z');
  });
});
