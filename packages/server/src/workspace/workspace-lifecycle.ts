import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import type { WorkspaceOperationPreview } from '@myrmecia/shared';
import { getDb } from '../db/database.js';
import { assertWorkspaceIdentity, getManagedWorkspace, workspaceBlockers, workspaceHash, type WorkspaceScope } from '../db/models/managed-workspace.js';
import { excludedWorkspacePath, readWorkspaceBytes, safeWorkspacePath, WORKSPACE_LIMITS } from './path-policy.js';
import { snapshotHash, readArtifactSnapshot } from '../artifacts/artifact-snapshot-store.js';
import { getExecutionArtifact } from '../db/models/execution-artifact.js';
type Operation = WorkspaceOperationPreview['operation'];
function directoryManifest(root: string): Array<{ path: string; sha256: string; bytes: number }> {
  const files: Array<{ path: string; sha256: string; bytes: number }> = []; let total = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > WORKSPACE_LIMITS.depth) throw new Error('LIFECYCLE_MANIFEST_DEPTH_QUOTA');
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative(root, join(dir, entry.name));
      if (entry.isSymbolicLink()) throw new Error('LIFECYCLE_SYMLINK_NEEDS_RECONCILIATION');
      if (excludedWorkspacePath(path)) {
        if (path === '.git') continue; // Git registration is removed by Git, branches remain.
        throw new Error('LIFECYCLE_EXCLUDED_FILES_REMAIN: archive in place; excluded bytes are not covered by evidence');
      }
      if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
      else if (entry.isFile()) {
        const bytes = readWorkspaceBytes(root, path); total += bytes.length;
        if (files.length >= WORKSPACE_LIMITS.files || total > WORKSPACE_LIMITS.totalBytes) throw new Error('LIFECYCLE_MANIFEST_QUOTA');
        files.push({ path, sha256: snapshotHash(bytes), bytes: bytes.length });
      }
    }
  };
  walk(root, 0); return files;
}
export function previewWorkspaceOperation(scope: WorkspaceScope, id: string, operation: Operation, persist = true): WorkspaceOperationPreview & { files: ReturnType<typeof directoryManifest> } {
  const workspace = getManagedWorkspace(id, scope);
  if (!workspace) throw new Error('WORKSPACE_NOT_FOUND');
  const blockers = workspaceBlockers(workspace);
  let files: ReturnType<typeof directoryManifest> = [];
  try { assertWorkspaceIdentity(workspace); } catch (error: any) { blockers.push(error.message); }
  if (operation === 'restore') {
    if (workspace.lifecycle !== 'archived') blockers.push('Only archived directories can be restored');
    if (workspace.baseline.head && existsSync(workspace.canonicalPath)) {
      try {
        const head = execFileSync('git', ['-C', workspace.canonicalPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        if (head !== workspace.baseline.head) blockers.push('Recorded Git baseline changed');
      } catch { blockers.push('Git baseline unavailable'); }
    }
  } else if (!['active', 'candidate', 'archived'].includes(workspace.lifecycle)) blockers.push('Lifecycle requires reconciliation');
  if (operation === 'purge') {
    if (workspace.ownership !== 'managed_execution') blockers.push('Only explicitly owned execution directories can be purged');
    if (workspace.lifecycle !== 'archived') blockers.push('Archive before purge');
    if (workspace.captureState !== 'complete') blockers.push('Complete immutable evidence required');
    try { files = directoryManifest(workspace.canonicalPath); } catch (error: any) { blockers.push(error.message); }
    const snapshots = getDb().all<any>(`SELECT a.id FROM execution_artifacts a JOIN execution_artifact_snapshots s ON s.artifact_id=a.id
      JOIN workspace_execution_bindings b ON b.task_id=a.task_id WHERE b.filesystem_workspace_id=? AND s.state='complete'`, id);
    const captured = new Set<string>();
    for (const row of snapshots) {
      try {
        const artifact = getExecutionArtifact(row.id)!;
        const bytes = readArtifactSnapshot(artifact);
        if (bytes) captured.add(`${artifact.relativePath}:${snapshotHash(bytes)}`);
      } catch { blockers.push('Retained artifact integrity failed'); }
    }
    // Conservative coverage: even baseline files need a retained matching snapshot.
    if (files.some(file => !captured.has(`${file.path}:${file.sha256}`))) blockers.push('Unsnapshotted files remain; archive in place instead');
    if (existsSync(join(workspace.canonicalPath, '.git'))) {
      try {
        if (execFileSync('git', ['-C', workspace.canonicalPath, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) blockers.push('Dirty Git worktree; no force removal');
      } catch { blockers.push('Git worktree metadata unavailable'); }
    }
  }
  const manifest = { operation, workspace, blockers, files };
  const preview = { ...manifest, previewId: `wpreview_${randomUUID()}`, manifestHash: workspaceHash(manifest), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), preservesFiles: operation !== 'purge' };
  if (persist) {
    const now = new Date().toISOString();
    getDb().run(`INSERT INTO workspace_operation_journal
      (id, workspace_id, actor_id, filesystem_workspace_id, operation, manifest_hash, manifest, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'preview', ?, ?)`, preview.previewId, scope.workspaceId, scope.actorId, id, operation, preview.manifestHash, JSON.stringify(preview), now, now);
  }
  return preview;
}
export function applyWorkspaceOperation(scope: WorkspaceScope, id: string, data: {
  operation: Operation; expectedRevision: number; manifestHash: string; expiresAt: string; previewId: string; confirm: boolean;
}): { operationId: string; lifecycle: string } {
  if (data.confirm !== true || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) < Date.now()
    || Date.parse(data.expiresAt) > Date.now() + 5 * 60_000) throw new Error('FRESH_EXPLICIT_CONFIRMATION_REQUIRED');
  const operationId = `wop_${randomUUID()}`;
  getDb().transaction(() => {
    const receipt = getDb().get<any>("SELECT * FROM workspace_operation_journal WHERE id=? AND workspace_id=? AND actor_id=? AND filesystem_workspace_id=? AND state='preview'",
      data.previewId, scope.workspaceId, scope.actorId, id);
    if (!receipt || receipt.manifest_hash !== data.manifestHash || JSON.parse(receipt.manifest).expiresAt !== data.expiresAt) throw new Error('WORKSPACE_PREVIEW_NOT_FOUND_OR_EXPIRED');
    const preview = previewWorkspaceOperation(scope, id, data.operation, false);
    if (preview.workspace.revision !== data.expectedRevision || preview.manifestHash !== data.manifestHash) throw new Error('WORKSPACE_PREVIEW_STALE');
    if (preview.blockers.length) throw new Error(`WORKSPACE_OPERATION_BLOCKED: ${preview.blockers.join('; ')}`);
    const now = new Date().toISOString();
    getDb().run(`INSERT INTO workspace_operation_journal
      (id, workspace_id, actor_id, filesystem_workspace_id, operation, manifest_hash, manifest, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'applying', ?, ?)`, operationId, scope.workspaceId, scope.actorId, id, data.operation, data.manifestHash, JSON.stringify(preview), now, now);
    getDb().run("UPDATE managed_workspaces SET lifecycle='reconciliation', revision=revision+1 WHERE id=? AND revision=?", id, data.expectedRevision);
    getDb().run("UPDATE workspace_operation_journal SET state='consumed' WHERE id=?", data.previewId);
  });
  try {
    const workspace = getManagedWorkspace(id, scope)!;
    assertWorkspaceIdentity(workspace);
    if (data.operation === 'purge') {
      const path = safeWorkspacePath(workspace.canonicalPath, '');
      if (existsSync(join(path, '.git'))) execFileSync('git', ['-C', workspace.sourcePath || path, 'worktree', 'remove', path], { stdio: 'pipe' });
      else rmSync(path, { recursive: true }); // exact owned, archived, covered target; no force fallback
      // Branches and artifact snapshots are intentionally retained.
    }
    const lifecycle = data.operation === 'archive' ? 'archived' : data.operation === 'restore' ? 'active' : 'purged';
    getDb().transaction(() => {
      getDb().run('UPDATE managed_workspaces SET lifecycle=?, revision=revision+1 WHERE id=?', lifecycle, id);
      getDb().run("UPDATE workspace_operation_journal SET state='complete', updated_at=? WHERE id=?", new Date().toISOString(), operationId);
    });
    return { operationId, lifecycle };
  } catch (error: any) {
    getDb().run("UPDATE workspace_operation_journal SET state='reconciliation', error=?, updated_at=? WHERE id=?", error.message, new Date().toISOString(), operationId);
    throw new Error(`WORKSPACE_RECONCILIATION_REQUIRED: ${operationId}`);
  }
}
