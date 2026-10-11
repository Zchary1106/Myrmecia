import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/database.js';
import { assertWorkspaceIdentity, getManagedWorkspace, registerManagedWorkspace, workspaceHash, type WorkspaceScope } from '../db/models/managed-workspace.js';
import { canonicalRoot, excludedWorkspacePath, ownGitRoot, readWorkspaceBytes, safeWorkspacePath, WORKSPACE_LIMITS } from './path-policy.js';
import { snapshotHash } from '../artifacts/artifact-snapshot-store.js';
import { claimWorkspaceLease, releaseWorkspaceLease } from './workspace-lease.js';
import type { Task } from '../types.js';
function selection(scope: WorkspaceScope, id: string, selectedFiles: string[]) {
  const source = getManagedWorkspace(id, scope);
  if (!source || !['active', 'candidate'].includes(source.lifecycle)) throw new Error('WORKSPACE_SOURCE_NOT_FOUND');
  assertWorkspaceIdentity(source);
  if (!ownGitRoot(source.canonicalPath)) throw new Error('DIRTY_SNAPSHOT_GIT_ROOT_REQUIRED');
  if (!selectedFiles.length || selectedFiles.length > 100 || new Set(selectedFiles).size !== selectedFiles.length) throw new Error('REVIEWED_FILE_LIST_REQUIRED');
  for (const file of selectedFiles) {
    if (excludedWorkspacePath(file) || file.startsWith('-')) throw new Error('DIRTY_SNAPSHOT_FILE_DENIED');
    if (safeWorkspacePath(source.canonicalPath, file) !== join(source.canonicalPath, file)) throw new Error('DIRTY_SNAPSHOT_RELATIVE_PATH_REQUIRED');
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', source.canonicalPath, ...args], { encoding: 'buffer', stdio: 'pipe', maxBuffer: WORKSPACE_LIMITS.fileBytes });
  const head = git('rev-parse', 'HEAD').toString().trim();
  const tracked = git('ls-tree', '-r', '--name-only', '-z', head).toString().split('\0').filter(Boolean);
  const excluded = tracked.filter(excludedWorkspacePath);
  const names = [...new Set([...tracked.filter(file => !excludedWorkspacePath(file)), ...selectedFiles])].sort();
  if (names.length > WORKSPACE_LIMITS.files) throw new Error('DIRTY_SNAPSHOT_FILE_QUOTA: use HEAD-only mode for large repositories');
  let total = 0;
  const deletedFiles = selectedFiles.filter(path => !existsSync(safeWorkspacePath(source.canonicalPath, path)));
  if (deletedFiles.some(path => !tracked.includes(path))) throw new Error('DIRTY_SNAPSHOT_MISSING_UNTRACKED_FILE');
  const files = names.filter(path => !deletedFiles.includes(path)).map(path => {
    if (path.split('/').length > WORKSPACE_LIMITS.depth + 1) throw new Error('DIRTY_SNAPSHOT_DEPTH_QUOTA');
    const bytes = selectedFiles.includes(path) ? readWorkspaceBytes(source.canonicalPath, path) : git('show', `${head}:${path}`);
    total += bytes.length;
    if (bytes.length > WORKSPACE_LIMITS.fileBytes || total > WORKSPACE_LIMITS.totalBytes) throw new Error('DIRTY_SNAPSHOT_BYTE_QUOTA');
    return { path, bytes, sha256: snapshotHash(bytes) };
  });
  const manifest = { sourceId: source.id, sourceRevision: source.revision, head, selectedFiles: [...selectedFiles].sort(), deletedFiles, excluded,
    files: files.map(({ path, bytes, sha256 }) => ({ path, sizeBytes: bytes.length, sha256 })) };
  return { source, files, manifest };
}
export function previewDirtySource(scope: WorkspaceScope, id: string, selectedFiles: string[]) {
  const source = getManagedWorkspace(id, scope);
  if (!source) throw new Error('WORKSPACE_SOURCE_NOT_FOUND');
  const lease = claimWorkspaceLease({ id: `source-preview-${randomUUID()}`, workdir: source.canonicalPath } as Task);
  try {
    const { manifest } = selection(scope, id, selectedFiles);
    const preview = { ...manifest, previewId: `wpreview_${randomUUID()}`, manifestHash: workspaceHash(manifest), expiresAt: new Date(Date.now() + 300_000).toISOString() };
    const now = new Date().toISOString();
    getDb().run(`INSERT INTO workspace_operation_journal
      (id,workspace_id,actor_id,filesystem_workspace_id,operation,manifest_hash,manifest,state,created_at,updated_at)
      VALUES (?,?,?,?, 'dirty_source_snapshot',?,?, 'preview',?,?)`,
      preview.previewId, scope.workspaceId, scope.actorId, id, preview.manifestHash, JSON.stringify(preview), now, now);
    return preview;
  } finally { releaseWorkspaceLease(lease); }
}
export function createDirtySourceSnapshot(scope: WorkspaceScope, id: string, data: { selectedFiles: string[]; previewId: string; manifestHash: string; confirm: boolean }) {
  if (!data.confirm) throw new Error('EXPLICIT_DIRTY_SNAPSHOT_CONFIRMATION_REQUIRED');
  const receipt = getDb().get<any>("SELECT manifest FROM workspace_operation_journal WHERE id=? AND workspace_id=? AND actor_id=? AND filesystem_workspace_id=? AND state='preview' AND operation='dirty_source_snapshot'",
    data.previewId, scope.workspaceId, scope.actorId, id);
  if (!receipt || Date.parse(JSON.parse(receipt.manifest).expiresAt) < Date.now()) throw new Error('DIRTY_SNAPSHOT_PREVIEW_EXPIRED');
  const source = getManagedWorkspace(id, scope);
  if (!source) throw new Error('WORKSPACE_SOURCE_NOT_FOUND');
  const lease = claimWorkspaceLease({ id: `source-copy-${randomUUID()}`, workdir: source.canonicalPath } as Task);
  try {
    const { files, manifest } = selection(scope, id, data.selectedFiles);
    if (workspaceHash(manifest) !== data.manifestHash || JSON.parse(receipt.manifest).manifestHash !== data.manifestHash) throw new Error('DIRTY_SNAPSHOT_PREVIEW_STALE');
    const store = join(process.env.MYRMECIA_WORKSPACE_ROOT || process.cwd(), '.agent-factory', 'reviewed-sources');
    mkdirSync(store, { recursive: true });
    const root = safeWorkspacePath(canonicalRoot(store), `selected-${randomUUID()}`); mkdirSync(root);
    getDb().run("UPDATE workspace_operation_journal SET state='applying', updated_at=? WHERE id=?", new Date().toISOString(), data.previewId);
    for (const file of files) {
      const target = safeWorkspacePath(root, file.path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, file.bytes, { flag: 'wx' });
    }
    const result = registerManagedWorkspace({ ...scope, canonicalPath: root, sourceKind: 'import', ownership: 'managed_import', sourcePath: source.canonicalPath,
      accessMode: 'shared_write', baseline: { provenance: 'filtered_copy', excluded: [...manifest.excluded, `Reviewed dirty-source snapshot at ${manifest.head}`] } });
    getDb().run("UPDATE workspace_operation_journal SET state='complete', updated_at=? WHERE id=?", new Date().toISOString(), data.previewId);
    return result;
  } catch (error: any) {
    getDb().run("UPDATE workspace_operation_journal SET state='reconciliation', error=?, updated_at=? WHERE id=? AND state='applying'", error.message, new Date().toISOString(), data.previewId);
    throw error;
  } finally { releaseWorkspaceLease(lease); }
}
