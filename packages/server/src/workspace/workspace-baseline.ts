import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { canonicalRoot, excludedWorkspacePath, readWorkspaceBytes, safeWorkspacePath, WORKSPACE_LIMITS } from './path-policy.js';
import { snapshotHash } from '../artifacts/artifact-snapshot-store.js';
interface BaselineManifest { files: Record<string, { sha256: string; sizeBytes: number }>; }
function store(): string {
  const path = join(process.env.MYRMECIA_WORKSPACE_ROOT || process.cwd(), '.agent-factory', 'workspace-baselines');
  mkdirSync(path, { recursive: true }); return canonicalRoot(path);
}
function directory(id: string): string {
  if (!/^base_[a-f0-9-]{36}_[a-f0-9]{64}$/.test(id)) throw new Error('WORKSPACE_BASELINE_ID_DENIED');
  return safeWorkspacePath(store(), id);
}
/** Bounded immutable source bytes, independent of later destination edits. */
export function captureWorkspaceBaseline(root: string): string {
  const prefix = `base_${randomUUID()}`, target = safeWorkspacePath(store(), `${prefix}.pending`);
  mkdirSync(join(target, 'files'), { recursive: true });
  const manifest: BaselineManifest = { files: {} }; let count = 0, total = 0;
  const walk = (path: string, depth: number) => {
    if (depth > WORKSPACE_LIMITS.depth) throw new Error('WORKSPACE_BASELINE_DEPTH_QUOTA');
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const rel = relative(root, join(path, entry.name));
      if (excludedWorkspacePath(rel) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(join(path, entry.name), depth + 1);
      else if (entry.isFile()) {
        const bytes = readWorkspaceBytes(root, rel); total += bytes.length;
        if (++count > WORKSPACE_LIMITS.files || total > WORKSPACE_LIMITS.totalBytes) throw new Error('WORKSPACE_BASELINE_QUOTA');
        manifest.files[rel] = { sha256: snapshotHash(bytes), sizeBytes: bytes.length };
        const output = safeWorkspacePath(join(target, 'files'), rel); mkdirSync(join(output, '..'), { recursive: true });
        writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
      }
    }
  };
  walk(root, 0);
  const content = JSON.stringify(manifest), id = `${prefix}_${snapshotHash(content)}`;
  writeFileSync(join(target, 'manifest.json'), content, { flag: 'wx', mode: 0o600 });
  renameSync(target, directory(id));
  return id;
}
export function readWorkspaceBaseline(id: string, path: string): Buffer | undefined {
  const root = directory(id);
  const content = readWorkspaceBytes(root, 'manifest.json');
  if (snapshotHash(content) !== id.split('_').at(-1)) throw new Error('WORKSPACE_BASELINE_MANIFEST_CHANGED');
  const manifest = JSON.parse(content.toString()) as BaselineManifest;
  const entry = manifest.files[path];
  if (!entry) return undefined;
  const bytes = readWorkspaceBytes(join(root, 'files'), path);
  if (bytes.length !== entry.sizeBytes || snapshotHash(bytes) !== entry.sha256) throw new Error('WORKSPACE_BASELINE_INTEGRITY_FAILED');
  return bytes;
}
export function observedFile(root: string, path: string): Buffer | undefined {
  const target = safeWorkspacePath(root, path);
  return existsSync(target) ? readWorkspaceBytes(root, path) : undefined;
}
