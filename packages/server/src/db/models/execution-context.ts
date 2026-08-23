import { v4 as uuid } from 'uuid';
import { getDb } from '../database.js';
import type { ExecutionContext, ExecutionContextInput, TaskCheckpoint, TaskCheckpointInput } from '../../types.js';

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return (value as T | null | undefined) ?? fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function rowToExecutionContext(row: any): ExecutionContext {
  return {
    id: row.id,
    taskId: row.task_id,
    workspaceId: row.workspace_id || 'default',
    workspacePath: row.workspace_path || undefined,
    workdir: row.workdir || undefined,
    provider: row.provider || undefined,
    modelId: row.model_id || undefined,
    reasoningEffort: row.reasoning_effort || undefined,
    contextLength: row.context_length ?? undefined,
    goal: row.goal,
    constraints: parseJson<string[]>(row.constraints, []),
    parentTaskId: row.parent_task_id || undefined,
    codeBaseline: parseJson(row.code_baseline, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCheckpoint(row: any): TaskCheckpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    executionContextId: row.execution_context_id,
    phase: row.phase,
    completed: parseJson<string[]>(row.completed, []),
    pending: parseJson<string[]>(row.pending, []),
    blocked: parseJson<string[]>(row.blocked, []),
    lastValidation: row.last_validation ? parseJson<Record<string, unknown>>(row.last_validation, {}) : undefined,
    resumeHint: row.resume_hint || undefined,
    createdAt: row.created_at,
  };
}

/** Create or replace the current durable context for a task. */
export function upsertExecutionContext(input: ExecutionContextInput): ExecutionContext {
  const db = getDb();
  const existing = db.get<{ id: string }>('SELECT id FROM execution_contexts WHERE task_id = ?', input.taskId);
  const id = existing?.id || `ectx_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO execution_contexts (
      id, task_id, workspace_id, workspace_path, workdir, provider, model_id,
      reasoning_effort, context_length, goal, constraints, parent_task_id, code_baseline
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      workspace_path = excluded.workspace_path,
      workdir = excluded.workdir,
      provider = excluded.provider,
      model_id = excluded.model_id,
      reasoning_effort = excluded.reasoning_effort,
      context_length = excluded.context_length,
      goal = excluded.goal,
      constraints = excluded.constraints,
      parent_task_id = excluded.parent_task_id,
      code_baseline = excluded.code_baseline,
      updated_at = CURRENT_TIMESTAMP
  `,
    id, input.taskId, input.workspaceId || 'default', input.workspacePath || null,
    input.workdir || null, input.provider || null, input.modelId || null,
    input.reasoningEffort || null, input.contextLength ?? null, input.goal,
    JSON.stringify(input.constraints || []), input.parentTaskId || null,
    JSON.stringify(input.codeBaseline || {}),
  );
  return getExecutionContext(input.taskId)!;
}

export function getExecutionContext(taskId: string): ExecutionContext | undefined {
  const row = getDb().get('SELECT * FROM execution_contexts WHERE task_id = ?', taskId);
  return row ? rowToExecutionContext(row) : undefined;
}

/** Append-only checkpoints preserve recovery history rather than overwriting it. */
export function appendTaskCheckpoint(input: TaskCheckpointInput): TaskCheckpoint {
  const db = getDb();
  const id = `chk_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO task_checkpoints (
      id, task_id, execution_context_id, phase, completed, pending, blocked, last_validation, resume_hint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    id, input.taskId, input.executionContextId, input.phase,
    JSON.stringify(input.completed || []), JSON.stringify(input.pending || []),
    JSON.stringify(input.blocked || []),
    input.lastValidation ? JSON.stringify(input.lastValidation) : null, input.resumeHint || null,
  );
  return getTaskCheckpoint(id)!;
}

export function getTaskCheckpoint(id: string): TaskCheckpoint | undefined {
  const row = getDb().get('SELECT * FROM task_checkpoints WHERE id = ?', id);
  return row ? rowToCheckpoint(row) : undefined;
}

export function listTaskCheckpoints(taskId: string, limit = 100): TaskCheckpoint[] {
  const bounded = Math.min(Math.max(limit, 1), 500);
  return getDb().all(
    'SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    taskId, bounded,
  ).map(rowToCheckpoint);
}

export function getLatestTaskCheckpoint(taskId: string): TaskCheckpoint | undefined {
  return listTaskCheckpoints(taskId, 1)[0];
}
