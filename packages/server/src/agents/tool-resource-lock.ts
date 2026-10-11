import { randomUUID } from 'node:crypto';
import { getDb } from '../db/database.js';
import { getTask } from '../db/models/task.js';
import type { Task } from '../types.js';
import { assertRunWrite, fencedRunWrite } from './run-coordinator.js';
import { classifyRuntimeTool } from './tool-dispatch-policy.js';
import { runtimeV2Enabled } from './runtime-version.js';
import { getRuntimeLimits } from './runtime-limits.js';
import { updateAgentRun } from './run-state.js';
import { getExecution } from '../db/models/execution.js';
class ToolResourceBusy extends Error {}

/** Shared DB authority, not a per-batch/process mutex. Unknown writes remain sealed for operator review. */
export async function withToolResourceLock<T extends { status: 'done' | 'failed' }>(
  task: Task, executionId: string, toolName: string, input: Record<string, unknown>, operation: () => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  if (!runtimeV2Enabled()) return operation();
  const key = `lock:${randomUUID()}`;
  const workspaceId = task.workspaceId || 'default';
  const classified = classifyRuntimeTool({ id: key, name: toolName, arguments: JSON.stringify(input) }, task.workdir || process.cwd());
  const deadline = Date.now() + Math.min(120_000, getRuntimeLimits().maxToolCallTimeoutMs);
  let reportedWait = false;
  for (;;) {
    if (signal?.aborted) throw new Error('Request aborted');
    assertRunWrite(task.id);
    if (['cancelled', 'done', 'failed'].includes(getTask(task.id)?.status || '')) throw new Error('Request aborted');
    try {
      fencedRunWrite(task.id, () => getDb().transaction(() => {
        getDb().run(`INSERT INTO agent_tool_resource_locks(lock_key, workspace_id, task_id, execution_id, effect, resources, server_key, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'held')`,
          key, workspaceId, task.id, executionId, classified.effect, JSON.stringify(classified.resources), classified.serverKey || null);
        const active = getDb().all<any>(
          "SELECT * FROM agent_tool_resource_locks WHERE workspace_id = ? AND lock_key <> ? AND status IN ('held','unknown')", workspaceId, key);
        if (active.some(row => row.effect !== 'read' || classified.effect !== 'read'
          || (classified.serverKey && classified.serverKey === row.server_key)
          || (JSON.parse(row.resources) as string[]).some(resource => classified.resources.includes(resource)))) throw new ToolResourceBusy();
      }));
      break;
    } catch (error) {
      if (!(error instanceof ToolResourceBusy)) throw error;
      if (!reportedWait) {
        const phase = getExecution(executionId)?.runState?.phase;
        if (phase && ['deciding', 'acting', 'observing', 'waiting_for_tool'].includes(phase)) {
          updateAgentRun(executionId, 'waiting_for_tool', { deadlineAt: new Date(deadline).toISOString() });
        }
        reportedWait = true;
      }
      if (Date.now() >= deadline) throw new Error('TOOL_RESOURCE_QUEUE_TIMEOUT: resource held by another execution or an unknown write awaiting review');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 25);
        const abort = () => { clearTimeout(timer); reject(new Error('Request aborted')); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  try {
    const result = await operation();
    fencedRunWrite(task.id, () => getDb().run(`UPDATE agent_tool_resource_locks SET status = ? WHERE lock_key = ?`,
      result.status === 'done' || classified.effect === 'read' ? 'released' : 'unknown', key));
    return result;
  } catch (error) {
    // Even a lost worker must leave a conservative unknown marker, not clear another owner's lock.
    getDb().run(`UPDATE agent_tool_resource_locks SET status = ? WHERE lock_key = ? AND task_id = ?`,
      classified.effect === 'read' ? 'released' : 'unknown', key, task.id);
    throw error;
  }
}

export function reconcileToolResourceLocks(workspaceId: string, executionId: string): number {
  return getDb().run(`UPDATE agent_tool_resource_locks SET status = 'released'
    WHERE workspace_id = ? AND execution_id = ? AND status IN ('held','unknown')`, workspaceId, executionId).changes;
}
