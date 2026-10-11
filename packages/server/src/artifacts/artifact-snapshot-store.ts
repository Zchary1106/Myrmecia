import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDb } from '../db/database.js';
import type { StoredExecutionArtifact } from '../db/models/execution-artifact.js';
import { canonicalRoot, readWorkspaceBytes, safeWorkspacePath, WORKSPACE_LIMITS } from '../workspace/path-policy.js';
export const snapshotHash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function snapshotRoot(): string {
  const root = resolve(process.env.MYRMECIA_ARTIFACT_SNAPSHOT_ROOT || join(process.env.MYRMECIA_WORKSPACE_ROOT || process.cwd(), '.agent-factory', 'artifact-snapshots'));
  mkdirSync(root, { recursive: true }); return canonicalRoot(root);
}
export function getArtifactSnapshot(artifactId: string): { artifact_id: string; workspace_id: string; execution_id: string; snapshot_path: string; sha256: string; size_bytes: number; state: string } | undefined {
  return getDb().get('SELECT * FROM execution_artifact_snapshots WHERE artifact_id=?', artifactId);
}
export function saveArtifactSnapshot(artifact: StoredExecutionArtifact, bytes: Buffer, state: 'complete' | 'partial' = 'complete'): void {
  const existing = getArtifactSnapshot(artifact.id);
  if (existing) {
    if (existing.sha256 !== snapshotHash(bytes)) throw new Error('ARTIFACT_SNAPSHOT_IMMUTABLE');
    return;
  }
  if (bytes.length > WORKSPACE_LIMITS.fileBytes) throw new Error('ARTIFACT_FILE_QUOTA');
  const captured = getDb().get<any>('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes),0) AS bytes FROM execution_artifact_snapshots WHERE workspace_id=? AND execution_id=?', artifact.workspaceId, artifact.executionId);
  if (captured.files >= WORKSPACE_LIMITS.files || captured.bytes + bytes.length > WORKSPACE_LIMITS.totalBytes) throw new Error('ARTIFACT_EXECUTION_QUOTA');
  const root = snapshotRoot();
  // Storage keys never include client-provided path components.
  const directory = safeWorkspacePath(root, snapshotHash(`${artifact.workspaceId}:${artifact.executionId}`));
  mkdirSync(directory, { recursive: true });
  const final = safeWorkspacePath(root, join(directory, snapshotHash(artifact.id)));
  const staging = `${final}.pending-${randomUUID()}`;
  writeFileSync(staging, bytes, { flag: 'wx', mode: 0o600 });
  renameSync(staging, final);
  // A crash before metadata commit leaves an orphaned byte file, never a verified live ref.
  getDb().run(`INSERT INTO execution_artifact_snapshots (artifact_id, workspace_id, execution_id, snapshot_path, sha256, size_bytes, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, artifact.id, artifact.workspaceId, artifact.executionId, final, snapshotHash(bytes), bytes.length, state, new Date().toISOString());
  const metadata = { ...artifact.metadata, captureState: state, immutable: true, sha256: snapshotHash(bytes) };
  getDb().run('UPDATE execution_artifacts SET metadata=?, root_path=NULL WHERE id=?', JSON.stringify(metadata), artifact.id);
}
export function readArtifactSnapshot(artifact: StoredExecutionArtifact): Buffer | undefined {
  const snapshot = getArtifactSnapshot(artifact.id);
  if (!snapshot) return undefined;
  if (snapshot.workspace_id !== artifact.workspaceId || snapshot.execution_id !== artifact.executionId) throw new Error('ARTIFACT_SNAPSHOT_SCOPE_DENIED');
  const root = snapshotRoot(), target = safeWorkspacePath(root, snapshot.snapshot_path);
  const bytes = readWorkspaceBytes(root, target);
  if (bytes.length !== snapshot.size_bytes || snapshotHash(bytes) !== snapshot.sha256) throw new Error('ARTIFACT_SNAPSHOT_INTEGRITY_FAILED');
  return bytes;
}
