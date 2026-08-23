import type { ExecutionContext, ExecutionContextInput, Task, TaskCheckpoint, TaskCheckpointInput } from '../types.js';
import {
  appendTaskCheckpoint,
  getExecutionContext,
  upsertExecutionContext,
} from '../db/models/execution-context.js';
import { getModel } from '../models/model-registry.js';

export type ExecutionContextOverrides = Partial<Omit<ExecutionContextInput, 'taskId'>>;

/**
 * Converts a legacy Task into the durable contract without requiring callers to
 * migrate all task creation code at once.
 */
export function executionContextFromTask(task: Task, overrides: ExecutionContextOverrides = {}): ExecutionContextInput {
  return {
    taskId: task.id,
    workspaceId: overrides.workspaceId || task.workspaceId || 'default',
    workspacePath: overrides.workspacePath ?? task.workspacePath,
    workdir: overrides.workdir ?? task.workdir,
    provider: overrides.provider,
    modelId: overrides.modelId ?? task.modelId,
    reasoningEffort: overrides.reasoningEffort ?? task.reasoningEffort,
    contextLength: overrides.contextLength ?? task.contextLength,
    goal: overrides.goal || task.description || task.title,
    constraints: overrides.constraints || [],
    parentTaskId: overrides.parentTaskId ?? task.parentTaskId,
    codeBaseline: overrides.codeBaseline,
  };
}

/**
 * Produces a child contract for Master, Test, Review, and Fix tasks. The
 * child gets its own goal but retains the parent workspace, model, constraints,
 * and code baseline unless an explicit override is supplied.
 */
export function inheritExecutionContext(
  parent: ExecutionContext | Task,
  child: Task,
  overrides: ExecutionContextOverrides = {},
): ExecutionContextInput {
  const source = 'taskId' in parent ? parent : executionContextFromTask(parent);
  return {
    taskId: child.id,
    workspaceId: overrides.workspaceId || source.workspaceId || child.workspaceId || 'default',
    workspacePath: overrides.workspacePath ?? source.workspacePath ?? child.workspacePath,
    workdir: overrides.workdir ?? source.workdir ?? child.workdir,
    provider: overrides.provider ?? source.provider,
    modelId: overrides.modelId ?? source.modelId ?? child.modelId,
    reasoningEffort: overrides.reasoningEffort ?? source.reasoningEffort ?? child.reasoningEffort,
    contextLength: overrides.contextLength ?? source.contextLength ?? child.contextLength,
    goal: overrides.goal || child.description || child.title,
    constraints: overrides.constraints || source.constraints || [],
    parentTaskId: overrides.parentTaskId ?? child.parentTaskId ?? source.taskId,
    codeBaseline: overrides.codeBaseline ?? source.codeBaseline,
  };
}

export function persistExecutionContext(task: Task, overrides: ExecutionContextOverrides = {}): ExecutionContext {
  // Runtime updates happen after a task has inherited its parent contract.
  // Merge, rather than rebuild from Task, so adding a workspace path or the
  // resolved runtime model never drops inherited constraints/baseline/provider.
  const existing = getExecutionContext(task.id);
  const preserved: ExecutionContextOverrides = {
    // Task fields are the current execution facts (for example the isolated
    // workspace assigned just before runtime starts); the existing contract
    // supplies durable fields Task cannot represent.
    workspaceId: task.workspaceId || existing?.workspaceId,
    workspacePath: task.workspacePath ?? existing?.workspacePath,
    workdir: task.workdir ?? existing?.workdir,
    provider: existing?.provider,
    modelId: task.modelId ?? existing?.modelId,
    reasoningEffort: task.reasoningEffort ?? existing?.reasoningEffort,
    contextLength: task.contextLength ?? existing?.contextLength,
    goal: existing?.goal,
    constraints: existing?.constraints,
    parentTaskId: task.parentTaskId ?? existing?.parentTaskId,
    codeBaseline: existing?.codeBaseline,
    contextUsage: existing?.contextUsage,
  };
  const merged = { ...preserved, ...overrides };
  if (!merged.provider && merged.modelId) merged.provider = getModel(merged.modelId)?.provider;
  return upsertExecutionContext(executionContextFromTask(task, merged));
}

export function persistInheritedExecutionContext(
  parent: ExecutionContext | Task,
  child: Task,
  overrides: ExecutionContextOverrides = {},
): ExecutionContext {
  return upsertExecutionContext(inheritExecutionContext(parent, child, overrides));
}

export function loadExecutionContext(task: Task): ExecutionContext {
  return getExecutionContext(task.id) || persistExecutionContext(task);
}

export function checkpointExecutionContext(
  context: ExecutionContext,
  checkpoint: Omit<TaskCheckpointInput, 'taskId' | 'executionContextId'>,
): TaskCheckpoint {
  return appendTaskCheckpoint({
    ...checkpoint,
    taskId: context.taskId,
    executionContextId: context.id,
  });
}
