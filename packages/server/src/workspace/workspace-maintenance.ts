import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/database.js';
import { assertWorkspaceIdentity, getManagedWorkspace, workspaceBlockers, workspaceHash, type WorkspaceScope } from '../db/models/managed-workspace.js';
import { canonicalRoot, rootIdentity } from './path-policy.js';
import { claimWorkspaceLease, releaseWorkspaceLease } from './workspace-lease.js';
import type { Task } from '../types.js';
export type MaintenanceAction = 'adopt_source' | 'delete_branch';
function manifest(scope: WorkspaceScope, id: string, action: MaintenanceAction, ignoredLeaseIds: string[] = []) {
  const workspace = getManagedWorkspace(id, scope);
  if (!workspace) throw new Error('WORKSPACE_NOT_FOUND');
  let blockers: string[] = [], targetPath = workspace.canonicalPath, branch = '', branchHead = '', identity = '';
  if (action === 'adopt_source') {
    assertWorkspaceIdentity(workspace); identity = rootIdentity(workspace.canonicalPath);
    blockers = workspaceBlockers(workspace, ignoredLeaseIds).filter(item => item !== 'Legacy ownership is unresolved');
    if (workspace.ownership !== 'legacy_unmanaged') blockers.push('Only a legacy directory can be explicitly adopted');
    if (!['active', 'candidate'].includes(workspace.lifecycle)) blockers.push('Legacy lifecycle is not settled');
  } else {
    if (workspace.ownership !== 'managed_execution' || workspace.lifecycle !== 'purged') blockers.push('Purge the owned worktree before deleting its branch');
    const source = workspace.sourcePath && getDb().get<{ id: string }>('SELECT id FROM managed_workspaces WHERE canonical_path=? AND workspace_id=? AND actor_id=?',
      workspace.sourcePath, scope.workspaceId, scope.actorId);
    const repository = source && getManagedWorkspace(source.id, scope);
    if (!repository) throw new Error('BRANCH_SOURCE_REGISTRATION_REQUIRED');
    assertWorkspaceIdentity(repository);
    blockers.push(...workspaceBlockers(repository, ignoredLeaseIds).filter(item => item !== 'Artifact capture not settled'));
    targetPath = repository.canonicalPath; identity = rootIdentity(targetPath);
    branch = workspace.baseline.branch || '';
    if (!/^codex\/task-[a-zA-Z0-9_-]+$/.test(branch)) throw new Error('ONLY_OWNED_TASK_BRANCH_ALLOWED');
    const git = (...args: string[]) => execFileSync('git', ['-C', targetPath, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    branchHead = git('rev-parse', '--verify', `refs/heads/${branch}`);
    if (git('worktree', 'list', '--porcelain').split('\n').includes(`branch refs/heads/${branch}`)) blockers.push('Branch is still checked out');
    try { git('merge-base', '--is-ancestor', branchHead, 'HEAD'); }
    catch { blockers.push('Branch contains unmerged commits; force deletion is not supported'); }
  }
  return { action, workspaceId: scope.workspaceId, filesystemWorkspaceId: id, revision: workspace.revision,
    targetPath, identity, branch, branchHead, blockers };
}
export function previewWorkspaceMaintenance(scope: WorkspaceScope, id: string, action: MaintenanceAction) {
  const value = manifest(scope, id, action);
  const preview = { ...value, previewId: `wpreview_${randomUUID()}`, manifestHash: workspaceHash(value), expiresAt: new Date(Date.now() + 300_000).toISOString() };
  const now = new Date().toISOString();
  getDb().run(`INSERT INTO workspace_operation_journal
    (id,workspace_id,actor_id,filesystem_workspace_id,operation,manifest_hash,manifest,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'preview',?,?)`, preview.previewId, scope.workspaceId, scope.actorId, id, action, preview.manifestHash, JSON.stringify(preview), now, now);
  return preview;
}
export function applyWorkspaceMaintenance(scope: WorkspaceScope, id: string, data: {
  action: MaintenanceAction; previewId: string; manifestHash: string; confirm: boolean;
}) {
  if (!data.confirm) throw new Error('EXPLICIT_MAINTENANCE_CONFIRMATION_REQUIRED');
  const receipt = getDb().get<{ manifest: string }>(`SELECT manifest FROM workspace_operation_journal
    WHERE id=? AND workspace_id=? AND actor_id=? AND filesystem_workspace_id=? AND operation=? AND state='preview'`,
  data.previewId, scope.workspaceId, scope.actorId, id, data.action);
  if (!receipt || Date.parse(JSON.parse(receipt.manifest).expiresAt) < Date.now()) throw new Error('MAINTENANCE_PREVIEW_EXPIRED');
  const check = (ignored: string[] = []) => {
    const current = manifest(scope, id, data.action, ignored);
    if (workspaceHash(current) !== data.manifestHash || JSON.parse(receipt.manifest).manifestHash !== data.manifestHash) throw new Error('MAINTENANCE_PREVIEW_STALE');
    if (current.blockers.length) throw new Error(`MAINTENANCE_BLOCKED: ${current.blockers.join('; ')}`);
    return current;
  };
  const current = check(), lease = claimWorkspaceLease({ id: data.previewId, workdir: current.targetPath, workspaceId: scope.workspaceId } as Task);
  try {
    check([lease.id]);
    getDb().run("UPDATE workspace_operation_journal SET state='applying' WHERE id=?", data.previewId);
    if (data.action === 'adopt_source') {
      getDb().run("UPDATE managed_workspaces SET ownership='user_source',source_kind='directory',revision=revision+1 WHERE id=? AND revision=?",
        id, current.revision);
    } else {
      if (canonicalRoot(current.targetPath) !== current.targetPath || rootIdentity(current.targetPath) !== current.identity) throw new Error('BRANCH_SOURCE_CHANGED');
      execFileSync('git', ['-C', current.targetPath, 'branch', '-d', '--', current.branch], { stdio: 'pipe' });
      getDb().run('UPDATE managed_workspaces SET revision=revision+1 WHERE id=?', id);
    }
    getDb().run("UPDATE workspace_operation_journal SET state='complete',updated_at=? WHERE id=?", new Date().toISOString(), data.previewId);
    return { completed: true, deletedDirectory: false, action: data.action };
  } catch (error: any) {
    getDb().run("UPDATE workspace_operation_journal SET state='reconciliation',error=? WHERE id=? AND state='applying'", error.message, data.previewId);
    throw error;
  } finally { releaseWorkspaceLease(lease); }
}
