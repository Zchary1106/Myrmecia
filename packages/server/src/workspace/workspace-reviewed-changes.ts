import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db/database.js';
import { assertWorkspaceIdentity, getManagedWorkspace, workspaceBlockers, workspaceHash, type WorkspaceScope } from '../db/models/managed-workspace.js';
import { getExecutionArtifact } from '../db/models/execution-artifact.js';
import { readArtifactSnapshot, snapshotHash } from '../artifacts/artifact-snapshot-store.js';
import { excludedWorkspacePath, ownGitRoot, safeWorkspacePath, writeWorkspaceBytes } from './path-policy.js';
import { claimWorkspaceLease, releaseWorkspaceLease, type WorkspaceLease } from './workspace-lease.js';
import { observedFile, readWorkspaceBaseline } from './workspace-baseline.js';
import type { Task } from '../types.js';
import type { ManagedWorkspace } from '@myrmecia/shared';
const git = (root: string, ...args: string[]) => execFileSync('git', ['--literal-pathspecs', '-C', root, ...args],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: 'pipe' });
export interface ChangeSetRequest { targetWorkspaceId: string; files: string[] }
const hash = (bytes?: Buffer) => bytes === undefined ? null : snapshotHash(bytes);
interface FileChange { path: string; operation: 'add' | 'modify' | 'delete'; baselineHash: string | null; sourceHash: string | null; targetHash: string | null }
function baseBytes(source: ManagedWorkspace, path: string): Buffer | undefined {
  if (source.baseline.head) {
    const tracked = git(source.canonicalPath, 'ls-tree', '-r', '--name-only', '-z', source.baseline.head, '--', path).split('\0');
    if (!tracked.includes(path)) return undefined;
    return execFileSync('git', ['-C', source.canonicalPath, 'show', `${source.baseline.head}:${path}`],
      { maxBuffer: 20 * 1024 * 1024, stdio: 'pipe' });
  }
  if (!source.baseline.snapshotId) throw new Error('FROZEN_SOURCE_BASELINE_REQUIRED');
  return readWorkspaceBaseline(source.baseline.snapshotId, path);
}
function retainedEvidence(source: ManagedWorkspace, change: FileChange): boolean {
  const rows = getDb().all<{ id: string }>(`SELECT a.id FROM execution_artifacts a
    JOIN execution_artifact_snapshots s ON s.artifact_id=a.id
    JOIN workspace_execution_bindings b ON b.task_id=a.task_id
    WHERE b.filesystem_workspace_id=? AND a.workspace_id=? AND a.relative_path=? AND s.state='complete'`,
  source.id, source.workspaceId, change.operation === 'delete' ? '__workspace_deletions__.json' : change.path);
  return rows.some(row => {
    const artifact = getExecutionArtifact(row.id);
    const bytes = artifact && readArtifactSnapshot(artifact);
    if (!bytes) return false;
    if (change.operation !== 'delete') return snapshotHash(bytes) === change.sourceHash;
    const data = JSON.parse(bytes.toString());
    return data.schemaVersion === 1 && data.deletions?.some((entry: any) =>
      entry.path === change.path && entry.priorSha256 === change.baselineHash);
  });
}
function filePatch(source: string, target: string, files: string[]): string {
  const staging = mkdtempSync(join(tmpdir(), 'myrmecia-reviewed-patch-'));
  try {
    let patch = '';
    for (const file of files) {
      let before = '/dev/null', after = '/dev/null';
      const a = observedFile(target, file), b = observedFile(source, file);
      if (a) { before = `a/${file}`; mkdirSync(join(staging, before, '..'), { recursive: true }); writeFileSync(join(staging, before), a); }
      if (b) { after = `b/${file}`; mkdirSync(join(staging, after, '..'), { recursive: true }); writeFileSync(join(staging, after), b); }
      if (before === after) continue;
      try { patch += execFileSync('git', ['diff', '--no-index', '--no-prefix', '--no-ext-diff', '--no-textconv', '--binary', '--', before, after],
        { cwd: staging, encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 }); }
      catch (error: any) { if (error.status === 1 && typeof error.stdout === 'string') patch += error.stdout; else throw error; }
      if (Buffer.byteLength(patch) > 10 * 1024 * 1024) throw new Error('CHANGESET_PATCH_QUOTA');
    }
    return patch;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
export function previewWorkspaceChanges(scope: WorkspaceScope, id: string, request: ChangeSetRequest, ignoredLeaseIds: string[] = []) {
  const source = getManagedWorkspace(id, scope), target = getManagedWorkspace(request.targetWorkspaceId, scope);
  if (!source || !target) throw new Error('WORKSPACE_NOT_FOUND');
  assertWorkspaceIdentity(source); assertWorkspaceIdentity(target);
  if (source.id === target.id) throw new Error('CHANGESET_REQUIRES_SEPARATE_DESTINATION');
  if (!request.files.length || request.files.length > 100 || new Set(request.files).size !== request.files.length) throw new Error('REVIEWED_FILE_LIST_REQUIRED');
  const files = [...request.files].sort();
  for (const file of files) {
    if (file.startsWith('-') || isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')
      || excludedWorkspacePath(file)) throw new Error('CHANGESET_FILE_DENIED');
    safeWorkspacePath(source.canonicalPath, file); safeWorkspacePath(target.canonicalPath, file);
  }
  const blockers = [...workspaceBlockers(source, ignoredLeaseIds), ...workspaceBlockers(target, ignoredLeaseIds).filter(item => item !== 'Artifact capture not settled')];
  if (source.captureState !== 'complete') blockers.push('Immutable execution evidence required');
  if (!['active', 'candidate'].includes(target.lifecycle)) blockers.push('Destination archived or unresolved');
  const targetGit = !!ownGitRoot(target.canonicalPath);
  const targetHead = targetGit ? git(target.canonicalPath, 'rev-parse', 'HEAD').trim() : 'non-git';
  const targetBranch = targetGit ? git(target.canonicalPath, 'branch', '--show-current').trim() : 'non-git';
  if (source.baseline.head && targetHead !== source.baseline.head) blockers.push('Destination baseline differs');
  if (targetGit && git(target.canonicalPath, 'status', '--porcelain').trim()) blockers.push('Destination has local changes');
  const changes: FileChange[] = [];
  for (const path of files) {
    const after = observedFile(source.canonicalPath, path), destination = observedFile(target.canonicalPath, path);
    let before: Buffer | undefined;
    try { before = baseBytes(source, path); }
    catch (error: any) { blockers.push(error.message); continue; }
    if (hash(before) === hash(after)) continue;
    const change: FileChange = { path, operation: after === undefined ? 'delete' : before === undefined ? 'add' : 'modify',
      baselineHash: hash(before), sourceHash: hash(after), targetHash: hash(destination) };
    changes.push(change);
    if (change.targetHash !== change.baselineHash) blockers.push(`Destination file baseline changed: ${path}`);
    try { if (!retainedEvidence(source, change)) blockers.push(`Reviewed file lacks matching immutable evidence: ${path}`); }
    catch { blockers.push(`Reviewed evidence damaged: ${path}`); }
  }
  if (!changes.length) blockers.push('No changes in reviewed file list');
  const patch = filePatch(source.canonicalPath, target.canonicalPath, changes.map(change => change.path));
  const manifest = { sourceId: id, targetId: target.id, sourceRevision: source.revision, targetRevision: target.revision,
    sourcePath: source.canonicalPath, targetPath: target.canonicalPath, targetHead, targetBranch, files, changes, patch };
  return { ...manifest, diffHash: workspaceHash(manifest), blockers,
    reconciliation: 'Review additions, modifications and deletions. Apply never commits, merges, pushes or creates a PR.' };
}
export function applyWorkspaceChanges(scope: WorkspaceScope, id: string, data: ChangeSetRequest & {
  diffHash: string; targetHead: string; targetBranch: string; confirm: boolean;
}) {
  if (data.confirm !== true) throw new Error('EXPLICIT_CHANGESET_CONFIRMATION_REQUIRED');
  const check = (ignoredLeaseIds: string[] = []) => {
    const preview = previewWorkspaceChanges(scope, id, data, ignoredLeaseIds);
    if (preview.diffHash !== data.diffHash || preview.targetHead !== data.targetHead || preview.targetBranch !== data.targetBranch) throw new Error('CHANGESET_PREVIEW_STALE');
    if (preview.blockers.length) throw new Error(`CHANGESET_BLOCKED: ${preview.blockers.join('; ')}`);
    return preview;
  };
  const preview = check();
  const leases: WorkspaceLease[] = [], operationId = `wop_${randomUUID()}`;
  try {
    for (const path of [preview.sourcePath, preview.targetPath].sort()) leases.push(claimWorkspaceLease({ id: operationId, workdir: path, workspaceId: scope.workspaceId } as Task));
    const locked = check(leases.map(lease => lease.id));
    const now = new Date().toISOString();
    const backups = locked.changes.map(change => ({ ...change, bytes: observedFile(locked.targetPath, change.path) }));
    const backupRoot = join(process.env.MYRMECIA_WORKSPACE_ROOT || process.cwd(), '.agent-factory', 'operation-backups', operationId);
    mkdirSync(backupRoot, { recursive: true });
    for (const backup of backups) {
      if (backup.bytes !== undefined) {
        const path = safeWorkspacePath(backupRoot, backup.path);
        mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, backup.bytes, { flag: 'wx', mode: 0o600 });
      }
    }
    getDb().run(`INSERT INTO workspace_operation_journal
      (id,workspace_id,actor_id,filesystem_workspace_id,operation,manifest_hash,manifest,state,created_at,updated_at)
      VALUES (?,?,?,?,'apply_changes',?,?,'applying',?,?)`, operationId, scope.workspaceId, scope.actorId, id, data.diffHash, JSON.stringify({ ...locked, backupRoot }), now, now);
    if (locked.targetHead !== 'non-git') {
      execFileSync('git', ['-C', locked.targetPath, 'apply', '--check', '-'], { input: locked.patch, stdio: 'pipe' });
      execFileSync('git', ['-C', locked.targetPath, 'apply', '-'], { input: locked.patch, stdio: 'pipe' });
    } else {
      try {
        for (const change of locked.changes) {
          if (change.operation === 'delete') unlinkSync(safeWorkspacePath(locked.targetPath, change.path));
          else writeWorkspaceBytes(locked.targetPath, change.path, observedFile(locked.sourcePath, change.path)!);
        }
      } catch (error) {
        for (const backup of backups.reverse()) {
          if (backup.bytes) writeWorkspaceBytes(locked.targetPath, backup.path, backup.bytes);
          else if (observedFile(locked.targetPath, backup.path)) unlinkSync(safeWorkspacePath(locked.targetPath, backup.path));
        }
        throw error;
      }
    }
    getDb().run("UPDATE workspace_operation_journal SET state='complete',updated_at=? WHERE id=?", new Date().toISOString(), operationId);
    return { operationId, applied: true, committed: false, pushed: false };
  } catch (error: any) {
    getDb().run("UPDATE workspace_operation_journal SET state='reconciliation',error=?,updated_at=? WHERE id=?", error.message, new Date().toISOString(), operationId);
    throw error;
  } finally { for (const lease of leases.reverse()) releaseWorkspaceLease(lease); }
}
