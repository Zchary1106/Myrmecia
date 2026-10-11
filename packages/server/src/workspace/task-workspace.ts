import type { Task } from '../types.js';
import type { WorkspaceAccessMode } from '@myrmecia/shared';
import { bindWorkspace, getManagedWorkspace, getWorkspaceBinding, listManagedWorkspaces, registerManagedWorkspace } from '../db/models/managed-workspace.js';
import { canonicalRoot } from './path-policy.js';
import { workspaceManager } from './workspace-manager.js';
import { updateTask } from '../db/models/task.js';
import { getDb } from '../db/database.js';
import { withWorkspaceLease } from './workspace-lease.js';
import { execFileSync } from 'node:child_process';
import { getPauseControl } from '../agents/pause-control.js';
import { getArtifactSnapshot, readArtifactSnapshot } from '../artifacts/artifact-snapshot-store.js';
import { getExecutionArtifact } from '../db/models/execution-artifact.js';

export async function prepareTaskWorkspace(task: Task, options: {
  actorId?: string; sourceWorkspaceId?: string; accessMode?: WorkspaceAccessMode; selectedSource?: boolean;
} = {}): Promise<Task> {
  const workspaceId = task.workspaceId || 'default';
  const requested = getDb().get<any>('SELECT options FROM workspace_preparation_requests WHERE task_id=? AND workspace_id=?', task.id, workspaceId);
  if (requested) options = { ...JSON.parse(requested.options), ...options };
  if (!options.actorId) {
    options.actorId = getDb().get<any>('SELECT actor_id FROM operator_actions WHERE task_id=? ORDER BY id LIMIT 1', task.id)?.actor_id
      || getDb().get<any>(`SELECT r.actor_id FROM agent_evaluation_case_results c JOIN agent_evaluation_runs r ON r.id=c.run_id WHERE c.task_id=? AND r.workspace_id=?`, task.id, workspaceId)?.actor_id;
  }
  let binding = getWorkspaceBinding(task.id);
  const contextParent = getDb().get<any>('SELECT parent_task_id FROM execution_contexts WHERE task_id=?', task.id)?.parent_task_id;
  if (!binding && (task.parentTaskId || contextParent || task.pipelineId)) {
    const parent = getWorkspaceBinding(task.parentTaskId || contextParent || `pipeline_${task.pipelineId}`);
    if (parent && parent.workspaceId === workspaceId) {
      binding = { ...parent, taskId: task.id }; bindWorkspace(binding);
    }
  }
  if (!binding) {
    const rawPath = task.workdir || task.workspacePath;
    const scope = { workspaceId, actorId: options.actorId || 'local-admin' };
    let sourceId = options.sourceWorkspaceId;
    if (rawPath && !sourceId) {
      const path = canonicalRoot(rawPath);
      const registered = listManagedWorkspaces().find(workspace => workspace.canonicalPath === path);
      if (registered && registered.workspaceId !== workspaceId) throw new Error('WORKSPACE_SCOPE_DENIED');
      const source = registered || registerManagedWorkspace({
        ...scope, canonicalPath: path, ownership: options.selectedSource ? 'user_source' : 'legacy_unmanaged',
        sourceKind: options.selectedSource ? 'directory' : 'legacy', accessMode: 'shared_write',
        baseline: { provenance: options.selectedSource ? 'filtered_copy' : 'legacy_recorded', excluded: [] },
      });
      if (options.actorId && source.actorId !== options.actorId) throw new Error('WORKSPACE_ACTOR_DENIED');
      scope.actorId = source.actorId; sourceId = source.id;
    }
    const sharedLegacy = rawPath && !options.selectedSource && !options.sourceWorkspaceId;
    const mode = options.accessMode || (sharedLegacy ? 'shared_write' : 'isolated');
    const prepare = () => workspaceManager.prepareExecutionWorkspace({ ...scope, taskId: task.id, sourceWorkspaceId: sourceId, accessMode: mode });
    const source = sourceId ? getManagedWorkspace(sourceId, scope) : undefined;
    binding = source && mode === 'isolated' ? await withWorkspaceLease({ ...task, workdir: source.canonicalPath, workspacePath: source.canonicalPath }, prepare) : await prepare();
  }
  if (binding.workspaceId !== workspaceId || !getManagedWorkspace(binding.filesystemWorkspaceId)) throw new Error('WORKSPACE_BINDING_DENIED');
  const lastRun = getDb().get<any>('SELECT run_state FROM task_executions WHERE task_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1', task.id);
  if (getPauseControl('task', task.id) || JSON.parse(lastRun?.run_state || '{}').userPaused) {
    if (binding.baseline.head) {
      const checkpoint = getDb().get<any>('SELECT code_baseline FROM execution_contexts WHERE task_id=?', task.id);
      const expected = JSON.parse(checkpoint?.code_baseline || '{}').revision || binding.baseline.head;
      const head = execFileSync('git', ['-C', binding.executionPath, 'rev-parse', 'HEAD'], { stdio: 'pipe', encoding: 'utf8' }).trim();
      if (head !== expected) throw new Error('WORKSPACE_PAUSE_BASELINE_CHANGED: review the directory before resuming');
    }
    for (const row of getDb().all<any>('SELECT id FROM execution_artifacts WHERE task_id=?', task.id)) {
      if (getArtifactSnapshot(row.id)) readArtifactSnapshot(getExecutionArtifact(row.id)!);
    }
  }
  const updated = updateTask(task.id, { workspacePath: binding.executionPath, workdir: binding.executionPath }) || task;
  return { ...updated, workspacePath: binding.executionPath, workdir: binding.executionPath };
}
/** Update current execution facts at a safe boundary, never historical checkpoints. */
export function recordWorkspaceBoundary(task: Task): void {
  const binding = getWorkspaceBinding(task.id);
  if (!binding?.baseline.head) return;
  const revision = execFileSync('git', ['-C', binding.executionPath, 'rev-parse', 'HEAD'], { stdio: 'pipe', encoding: 'utf8' }).trim();
  const current = getDb().get<any>('SELECT code_baseline FROM execution_contexts WHERE task_id=?', task.id);
  getDb().run('UPDATE execution_contexts SET code_baseline=? WHERE task_id=?', JSON.stringify({
    ...JSON.parse(current?.code_baseline || '{}'), revision, branch: binding.baseline.branch, capturedAt: new Date().toISOString(),
  }), task.id);
}
