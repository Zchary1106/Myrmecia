import type { InboxEntry, OperatorAction, Pipeline, PlatformEvent, RuntimeDiagnostics, Task } from '@agent-factory/shared';
import { api } from './api';
import { savedViewScope } from './savedViews';

const HANDOFF_PREFIX = 'agentFactory.handoffReviewedAt';
const HANDOFF_NAMESPACE = 'handoff';
const HANDOFF_KEY = 'reviewedAt';

export interface ActivitySummary {
  checkpoint?: string;
  failedWork: Task[];
  pendingDecisions: InboxEntry[];
  blockedPipelines: Pipeline[];
  newEvents: PlatformEvent[];
  recentLaunches: OperatorAction[];
  operatorActions: OperatorAction[];
}

function handoffKey(scope: string): string {
  return `${HANDOFF_PREFIX}.${scope}`;
}

export function getHandoffCheckpoint(diagnostics: RuntimeDiagnostics | null): string | undefined {
  try {
    return localStorage.getItem(handoffKey(savedViewScope(diagnostics))) || undefined;
  } catch {
    return undefined;
  }
}

function persistLocalHandoffCheckpoint(diagnostics: RuntimeDiagnostics | null, value: string) {
  try {
    localStorage.setItem(handoffKey(savedViewScope(diagnostics)), value);
  } catch (err) {
    console.warn('[activitySummary] Failed to persist local handoff checkpoint', err);
  }
}

export async function loadHandoffCheckpoint(diagnostics: RuntimeDiagnostics | null): Promise<string | undefined> {
  const localCheckpoint = getHandoffCheckpoint(diagnostics);
  try {
    const preference = await api.preferences.get<{ reviewedAt?: string }>(HANDOFF_NAMESPACE, HANDOFF_KEY);
    const reviewedAt = preference.value?.reviewedAt;
    if (reviewedAt) {
      persistLocalHandoffCheckpoint(diagnostics, reviewedAt);
      return reviewedAt;
    }
    return localCheckpoint;
  } catch (err) {
    if (localCheckpoint) {
      void api.preferences.put(HANDOFF_NAMESPACE, HANDOFF_KEY, { reviewedAt: localCheckpoint })
        .catch(syncErr => console.warn('[activitySummary] Failed to sync local handoff checkpoint', syncErr));
    }
    return localCheckpoint;
  }
}

export async function markHandoffReviewed(diagnostics: RuntimeDiagnostics | null): Promise<string> {
  const value = new Date().toISOString();
  persistLocalHandoffCheckpoint(diagnostics, value);
  try {
    await api.preferences.put(HANDOFF_NAMESPACE, HANDOFF_KEY, { reviewedAt: value });
  } catch (err) {
    console.warn('[activitySummary] Failed to persist server handoff checkpoint', err);
  }
  return value;
}

function afterCheckpoint<T extends { createdAt: string }>(items: T[], checkpoint?: string): T[] {
  if (!checkpoint) return items;
  const threshold = new Date(checkpoint).getTime();
  return items.filter(item => new Date(item.createdAt).getTime() > threshold);
}

export function buildActivitySummary(input: {
  diagnostics: RuntimeDiagnostics | null;
  checkpoint?: string;
  tasks: Task[];
  inboxEntries: InboxEntry[];
  pipelines: Pipeline[];
  platformEvents: PlatformEvent[];
  operatorActions: OperatorAction[];
}): ActivitySummary {
  const checkpoint = input.checkpoint ?? getHandoffCheckpoint(input.diagnostics);
  const tasksSince = afterCheckpoint(input.tasks, checkpoint);
  const inboxSince = afterCheckpoint(input.inboxEntries, checkpoint);
  const pipelinesSince = afterCheckpoint(input.pipelines, checkpoint);
  const eventsSince = afterCheckpoint(input.platformEvents, checkpoint);
  const actionsSince = afterCheckpoint(input.operatorActions, checkpoint);

  return {
    checkpoint,
    failedWork: tasksSince.filter(task => task.status === 'failed' || task.status === 'cancelled').slice(0, 8),
    pendingDecisions: inboxSince.filter(entry => entry.status === 'pending').slice(0, 8),
    blockedPipelines: pipelinesSince.filter(pipeline => pipeline.status === 'blocked' || pipeline.status === 'failed').slice(0, 8),
    newEvents: eventsSince.slice(0, 12),
    recentLaunches: actionsSince.filter(action => action.action === 'task.create' || action.action === 'pipeline.create').slice(0, 8),
    operatorActions: actionsSince.slice(0, 8),
  };
}

export function handoffTotal(summary: ActivitySummary): number {
  return summary.failedWork.length
    + summary.pendingDecisions.length
    + summary.blockedPipelines.length
    + summary.newEvents.length
    + summary.recentLaunches.length;
}
