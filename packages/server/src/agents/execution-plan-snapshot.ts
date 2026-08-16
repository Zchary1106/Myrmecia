/**
 * Execution Plan Snapshot — 每次运行前把不可变能力与配置快照写入
 * Execution Ledger（append-only），供审计、重放与调试。
 * 记录失败不影响执行（ledger 写入本身 best-effort）。
 */
import type { ExecutionPlanSnapshot } from '../types.js';
import { recordLedgerEntry, listLedgerEntries } from '../db/models/execution-ledger.js';
import { validateExecutionPlanSnapshot } from '../contracts/team-composer-contracts.js';

export const PLAN_SNAPSHOT_LEDGER_TYPE = 'plan.snapshot';

export function recordExecutionPlanSnapshot(input: {
  executionId: string;
  workspaceId: string;
  snapshot: ExecutionPlanSnapshot;
  taskId?: string;
  agentId?: string;
}): ExecutionPlanSnapshot | undefined {
  const validation = validateExecutionPlanSnapshot(input.snapshot);
  if (!validation.valid || !validation.value) {
    throw new Error(
      `Invalid ExecutionPlanSnapshot: ${validation.errors
        .map(issue => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  recordLedgerEntry({
    executionId: input.executionId,
    taskId: input.taskId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    type: PLAN_SNAPSHOT_LEDGER_TYPE,
    summary: `Execution plan snapshot ${input.snapshot.snapshotId} (team ${input.snapshot.teamId} v${input.snapshot.teamVersion})`,
    metadata: { snapshot: input.snapshot },
  });
  return input.snapshot;
}

export function getExecutionPlanSnapshot(executionId: string): ExecutionPlanSnapshot | undefined {
  const entries = listLedgerEntries({ executionId });
  // Ledger is ordered by seq ASC; the latest snapshot wins (append-only).
  const snapshotEntry = [...entries]
    .reverse()
    .find(entry => entry.type === PLAN_SNAPSHOT_LEDGER_TYPE);
  if (!snapshotEntry) return undefined;
  const validation = validateExecutionPlanSnapshot(snapshotEntry.metadata?.snapshot);
  return validation.valid && validation.value ? validation.value : undefined;
}
