import { getDb } from '../db/database.js';
import { getTool } from '../tools/tool-registry.js';
import { XHS_READ_TOOLS } from '../tools/xiaohongshu-read-adapter.js';

const owners = new Map<string, number>();

/** Exactly one layer decides task-level retries for a dispatched execution. */
export function claimQueueRetry(taskId: string): () => void {
  owners.set(taskId, (owners.get(taskId) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (owners.get(taskId) || 1) - 1;
    if (count <= 0) owners.delete(taskId);
    else owners.set(taskId, count);
  };
}

export function queueOwnsRetry(taskId: string): boolean { return owners.has(taskId); }

/** Unknown tool effects are unsafe, not implicitly read-only. */
export function taskMayHaveSideEffects(taskId: string): boolean {
  if (getDb().get('SELECT 1 FROM agent_tool_invocations WHERE task_id = ? LIMIT 1', taskId)) return true;
  const attempts = getDb().all<{ tool_id: string }>(
    'SELECT DISTINCT tool_id FROM tool_executions WHERE task_id = ?', taskId,
  );
  return attempts.some(({ tool_id }) => {
    if (XHS_READ_TOOLS.has(tool_id) || tool_id === 'mcp__xiaohongshu__check_login_status') return false;
    return getTool(tool_id)?.metadata?.readOnly !== true;
  });
}
