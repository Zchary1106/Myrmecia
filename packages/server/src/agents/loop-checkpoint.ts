import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import type { Task } from '../types.js';
import { getDb } from '../db/database.js';
import { getExecution } from '../db/models/execution.js';
import { taskMayHaveSideEffects } from './retry-ownership.js';
import { dlpCheck } from '../security/dlp.js';

export interface AgentLoopCheckpoint {
  schemaVersion: 1;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  turn: number;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  toolRuntimeMs: number;
  elapsedMs: number;
  finalOutput: string;
}

export function loopFingerprint(input: {
  agentId: string; modelId: string; systemPrompt: string;
  input: string; tools: string[]; workdir?: string; skillChecksum?: string;
}): string {
  return createHash('sha256').update(JSON.stringify({ ...input, tools: [...input.tools].sort() })).digest('hex');
}

/** Only a stable, read-only TS-turn boundary can be resumed automatically. */
export function readLoopCheckpoint(task: Task, fingerprint: string, currentExecutionId: string): {
  executionId: string; snapshot: AgentLoopCheckpoint;
} | undefined {
  if (process.env.MYRMECIA_DURABLE_RESUME === 'false' || taskMayHaveSideEffects(task.id)) return undefined;
  const row = getDb().get<any>(
    `SELECT * FROM agent_loop_checkpoints
      WHERE task_id = ? AND workspace_id = ? AND execution_id <> ?
      ORDER BY updated_at DESC LIMIT 1`,
    task.id, task.workspaceId || 'default', currentExecutionId,
  );
  if (!row || !row.resumable || row.fingerprint !== fingerprint) return undefined;
  const run = getExecution(row.execution_id);
  if (run?.status !== 'failed' || run.runState?.stopReason !== 'interrupted') return undefined;
  try {
    const snapshot = JSON.parse(row.snapshot) as AgentLoopCheckpoint;
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.messages)
      || ![snapshot.turn, snapshot.inputTokens, snapshot.outputTokens, snapshot.toolCallCount, snapshot.toolRuntimeMs, snapshot.elapsedMs]
        .every(value => Number.isFinite(value) && value >= 0)) return undefined;
    return { executionId: row.execution_id, snapshot };
  } catch { return undefined; }
}

export function saveLoopCheckpoint(task: Task, executionId: string, fingerprint: string, snapshot: AgentLoopCheckpoint): void {
  const raw = JSON.stringify(snapshot);
  const checked = dlpCheck(raw, { taskId: task.id, workspaceId: task.workspaceId });
  // Sensitive or unrepresentable snapshots disable recovery, not live execution.
  if (checked.violations.some(violation => violation.action === 'block')) {
    sealLoopCheckpoint(executionId);
    return;
  }
  const serialized = checked.redactedContent || raw;
  try { JSON.parse(serialized); } catch { sealLoopCheckpoint(executionId); return; }
  // Bound storage independently of per-message output limits.
  if (Buffer.byteLength(serialized) > 2_000_000) {
    sealLoopCheckpoint(executionId);
    return;
  }
  getDb().run(
    `INSERT INTO agent_loop_checkpoints (execution_id, task_id, workspace_id, fingerprint, snapshot, resumable, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(execution_id) DO UPDATE SET snapshot = excluded.snapshot, resumable = 1, updated_at = excluded.updated_at`,
    executionId, task.id, task.workspaceId || 'default', fingerprint, serialized, new Date().toISOString(),
  );
}

export function sealLoopCheckpoint(executionId: string): void {
  getDb().run('UPDATE agent_loop_checkpoints SET resumable = 0 WHERE execution_id = ?', executionId);
}
