import { createHash } from 'node:crypto';
import { getDb } from '../db/database.js';
import { getTask } from '../db/models/task.js';
import { getTool } from './tool-registry.js';
import { XHS_READ_TOOLS } from './xiaohongshu-read-adapter.js';
import type { Task } from '../types.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  }
  return value;
}

/** Journal before dispatch. Unknown effects are never silently replayed. */
export async function runWriteOnce<T extends { status: 'done' | 'failed' }>(
  task: Task, executionId: string, toolId: string, input: Record<string, unknown>, operation: () => Promise<T>,
): Promise<T> {
  const current = getTask(task.id);
  if (current && ['cancelled', 'done', 'failed'].includes(current.status)) throw new Error('Request aborted: task is settled');
  if (XHS_READ_TOOLS.has(toolId) || toolId === 'mcp__xiaohongshu__check_login_status' || getTool(toolId)?.metadata?.readOnly === true) {
    return operation();
  }
  const inputHash = createHash('sha256').update(JSON.stringify(canonical({ input, workdir: task.workdir }))).digest('hex');
  const db = getDb();
  const claimed = db.run(
    `INSERT INTO agent_tool_invocations (task_id, tool_id, input_hash, execution_id, outcome, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?) ON CONFLICT DO NOTHING`,
    task.id, toolId, inputHash, executionId, new Date().toISOString(),
  );
  if (claimed.changes !== 1) {
    throw new Error('TOOL_REPLAY_BLOCKED: this write was already attempted; verify the prior outcome or request a new task instead of repeating it');
  }
  try {
    const result = await operation();
    db.run(
      'UPDATE agent_tool_invocations SET outcome = ?, updated_at = ? WHERE task_id = ? AND tool_id = ? AND input_hash = ?',
      result.status === 'done' ? 'done' : 'unknown', new Date().toISOString(), task.id, toolId, inputHash,
    );
    return result;
  } catch (error) {
    db.run(
      "UPDATE agent_tool_invocations SET outcome = 'unknown', updated_at = ? WHERE task_id = ? AND tool_id = ? AND input_hash = ?",
      new Date().toISOString(), task.id, toolId, inputHash,
    );
    throw error;
  }
}
