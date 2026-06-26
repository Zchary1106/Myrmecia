import { describe, it, expect } from 'vitest';
import type { InboxEntry, OperatorAction, Pipeline, PlatformEvent, Task } from '@myrmecia/shared';
import { buildActivitySummary, handoffTotal } from '../src/lib/activitySummary';

const CHECKPOINT = '2026-01-01T00:00:00Z';
const BEFORE = '2025-12-31T00:00:00Z';
const AFTER = '2026-01-02T00:00:00Z';

const task = (status: string, createdAt: string, id = `t_${Math.random()}`) =>
  ({ id, status, createdAt } as unknown as Task);
const inbox = (status: string, createdAt: string) =>
  ({ id: `i_${Math.random()}`, status, createdAt } as unknown as InboxEntry);
const pipeline = (status: string, createdAt: string) =>
  ({ id: `p_${Math.random()}`, status, createdAt } as unknown as Pipeline);
const event = (createdAt: string) =>
  ({ id: Math.floor(Math.random() * 1e6), createdAt } as unknown as PlatformEvent);
const action = (act: string, createdAt: string) =>
  ({ id: Math.floor(Math.random() * 1e6), action: act, createdAt } as unknown as OperatorAction);

function summary(overrides: Partial<Parameters<typeof buildActivitySummary>[0]> = {}) {
  return buildActivitySummary({
    diagnostics: null,
    checkpoint: CHECKPOINT,
    tasks: [],
    inboxEntries: [],
    pipelines: [],
    platformEvents: [],
    operatorActions: [],
    ...overrides,
  });
}

describe('buildActivitySummary', () => {
  it('only includes items created after the checkpoint', () => {
    const result = summary({
      tasks: [task('failed', BEFORE), task('failed', AFTER)],
    });
    expect(result.failedWork).toHaveLength(1);
    expect(result.failedWork[0].createdAt).toBe(AFTER);
  });

  it('selects failed/cancelled tasks, pending inbox, and blocked/failed pipelines', () => {
    const result = summary({
      tasks: [task('failed', AFTER), task('cancelled', AFTER), task('done', AFTER)],
      inboxEntries: [inbox('pending', AFTER), inbox('approved', AFTER)],
      pipelines: [pipeline('blocked', AFTER), pipeline('failed', AFTER), pipeline('running', AFTER)],
    });
    expect(result.failedWork).toHaveLength(2);
    expect(result.pendingDecisions).toHaveLength(1);
    expect(result.blockedPipelines).toHaveLength(2);
  });

  it('treats only task.create / pipeline.create actions as recent launches', () => {
    const result = summary({
      operatorActions: [action('task.create', AFTER), action('pipeline.create', AFTER), action('task.cancel', AFTER)],
    });
    expect(result.recentLaunches).toHaveLength(2);
    expect(result.operatorActions).toHaveLength(3);
  });

  it('caps newEvents at 12', () => {
    const result = summary({ platformEvents: Array.from({ length: 20 }, () => event(AFTER)) });
    expect(result.newEvents).toHaveLength(12);
  });
});

describe('handoffTotal', () => {
  it('sums the actionable buckets (excluding operatorActions)', () => {
    const result = summary({
      tasks: [task('failed', AFTER)],
      inboxEntries: [inbox('pending', AFTER)],
      pipelines: [pipeline('blocked', AFTER)],
      platformEvents: [event(AFTER), event(AFTER)],
      operatorActions: [action('task.create', AFTER)],
    });
    // failedWork(1) + pendingDecisions(1) + blockedPipelines(1) + newEvents(2) + recentLaunches(1) = 6
    expect(handoffTotal(result)).toBe(6);
  });
});
