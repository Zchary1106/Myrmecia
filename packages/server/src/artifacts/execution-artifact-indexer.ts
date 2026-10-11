import { existsSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import type { Task } from '../types.js';
import { getExecutionArtifact, upsertExecutionArtifact } from '../db/models/execution-artifact.js';
import { getDb } from '../db/database.js';
import { eventBus } from '../events/event-bus.js';
import { excludedWorkspacePath, readWorkspaceBytes, safeWorkspacePath, WORKSPACE_LIMITS } from '../workspace/path-policy.js';
import { saveArtifactSnapshot } from './artifact-snapshot-store.js';
import { getWorkspaceBinding, getManagedWorkspace, assertWorkspaceIdentity, touchWorkspace } from '../db/models/managed-workspace.js';
import { assertWorkspaceToolAllowed } from '../workspace/workspace-lease.js';
import { readWorkspaceBaseline } from '../workspace/workspace-baseline.js';
import { execFileSync } from 'node:child_process';
import { snapshotHash } from './artifact-snapshot-store.js';

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', '.agent-factory', 'dist', 'build', '.next']);
const MAX_FILES = 250;
const MAX_DEPTH = 8;

const MIME: Record<string, [string, any]> = {
  '.md': ['text/markdown; charset=utf-8', 'text'],
  '.txt': ['text/plain; charset=utf-8', 'text'],
  '.log': ['text/plain; charset=utf-8', 'text'],
  '.json': ['application/json; charset=utf-8', 'json'],
  '.yaml': ['text/yaml; charset=utf-8', 'code'],
  '.yml': ['text/yaml; charset=utf-8', 'code'],
  '.html': ['text/html; charset=utf-8', 'html'],
  '.htm': ['text/html; charset=utf-8', 'html'],
  '.ts': ['text/plain; charset=utf-8', 'code'],
  '.tsx': ['text/plain; charset=utf-8', 'code'],
  '.js': ['text/plain; charset=utf-8', 'code'],
  '.jsx': ['text/plain; charset=utf-8', 'code'],
  '.py': ['text/plain; charset=utf-8', 'code'],
  '.css': ['text/css; charset=utf-8', 'code'],
  '.svg': ['image/svg+xml', 'image'],
  '.png': ['image/png', 'image'],
  '.jpg': ['image/jpeg', 'image'],
  '.jpeg': ['image/jpeg', 'image'],
  '.webp': ['image/webp', 'image'],
  '.gif': ['image/gif', 'image'],
  '.mp4': ['video/mp4', 'video'],
  '.webm': ['video/webm', 'video'],
  '.mov': ['video/quicktime', 'video'],
  '.mp3': ['audio/mpeg', 'audio'],
  '.wav': ['audio/wav', 'audio'],
  '.m4a': ['audio/mp4', 'audio'],
  '.pdf': ['application/pdf', 'pdf'],
};

function describe(path: string): { mimeType: string; kind: any } {
  const extension = extname(path).toLowerCase();
  const [mimeType, kind] = MIME[extension] || ['application/octet-stream', 'file'];
  return { mimeType, kind };
}

export type ArtifactFileBaseline = Record<string, string>;
const signature = (stats: Stats) => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
export function captureArtifactBaseline(root: string): ArtifactFileBaseline {
  const baseline: ArtifactFileBaseline = {}; let visited = 0;
  const walk = (directory: string, depth: number) => {
    if (depth > 32) throw new Error('ARTIFACT_BASELINE_SCAN_QUOTA');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++visited > 20_000) throw new Error('ARTIFACT_BASELINE_SCAN_QUOTA');
      const path = join(directory, entry.name), rel = relative(root, path);
      if (excludedWorkspacePath(rel) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile()) baseline[rel] = signature(statSync(path));
    }
  };
  walk(root, 0); return baseline;
}
function collectFiles(root: string, sinceMs: number, baseline?: ArtifactFileBaseline, excluded: string[] = []): string[] {
  const files: string[] = [];
  let visited = 0;
  const walk = (directory: string, depth: number) => {
    if (depth > 32) throw new Error('ARTIFACT_SCAN_QUOTA');
    let entries;
    entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > 20_000) throw new Error('ARTIFACT_SCAN_QUOTA');
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) { excluded.push(relative(root, join(directory, entry.name))); continue; }
      const path = join(directory, entry.name);
      if (excludedWorkspacePath(relative(root, path)) || entry.isSymbolicLink()) { excluded.push(relative(root, path)); continue; }
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = statSync(path);
        const changed = baseline ? baseline[relative(root, path)] !== signature(stats) : stats.mtimeMs >= sinceMs;
        if (changed) {
          if (depth > MAX_DEPTH) throw new Error('ARTIFACT_DEPTH_QUOTA');
          if (files.length >= MAX_FILES) throw new Error('ARTIFACT_FILE_COUNT_QUOTA');
          files.push(path);
        }
      } catch (error: any) { if (error.message?.startsWith('ARTIFACT_')) throw error; throw new Error('ARTIFACT_FILE_UNSTABLE'); }
    }
  };
  walk(root, 0);
  return files;
}

export function indexExecutionArtifacts(data: {
  task: Task;
  executionId: string;
  output: string;
  startedAtMs: number;
  captureState?: 'complete' | 'partial';
  baseline?: ArtifactFileBaseline;
}): number {
  assertWorkspaceToolAllowed();
  const root = data.task.workdir || data.task.workspacePath;
  const indexed: ReturnType<typeof upsertExecutionArtifact>[] = [];
  const binding = getWorkspaceBinding(data.task.id);
  if (binding) {
    const workspace = getManagedWorkspace(binding.filesystemWorkspaceId);
    if (!workspace || workspace.workspaceId !== (data.task.workspaceId || 'default')) throw new Error('ARTIFACT_CAPTURE_SCOPE_DENIED');
    assertWorkspaceIdentity(workspace);
  }
  if (Buffer.byteLength(data.output) > WORKSPACE_LIMITS.fileBytes) {
    if (binding) touchWorkspace(binding.filesystemWorkspaceId, 'failed');
    throw new Error('ARTIFACT_CAPTURE_FAILED: ARTIFACT_FILE_QUOTA');
  }
  const state = data.captureState || 'complete';
  const errors: string[] = [];
  const exclusions: string[] = [];
  const capture = (artifact: ReturnType<typeof upsertExecutionArtifact>, bytes: Buffer) => {
    try {
      saveArtifactSnapshot(artifact, bytes, state);
      indexed.push(getExecutionArtifact(artifact.id)!);
    } catch (error: any) { errors.push(`${artifact.relativePath}: ${error.message}`); }
  };
  capture(upsertExecutionArtifact({
    workspaceId: data.task.workspaceId,
    taskId: data.task.id,
    executionId: data.executionId,
    pipelineId: data.task.pipelineId,
    stageIndex: data.task.stageIndex,
    name: 'Execution result',
    kind: 'text',
    mimeType: 'text/markdown; charset=utf-8',
    source: 'result',
    relativePath: '__result__.md',
    content: data.output,
    sizeBytes: Buffer.byteLength(data.output),
    metadata: { captureState: 'pending' },
  }), Buffer.from(data.output));

  if (root) {
    let realRoot: string | undefined;
    try { realRoot = realpathSync(resolve(root)); } catch { errors.push('Artifact workspace unavailable'); }
    if (realRoot) {
      const deletions: Array<{ path: string; priorSha256: string }> = [];
      if (binding && data.baseline) {
        for (const path of Object.keys(data.baseline)) {
          try {
            if (excludedWorkspacePath(path) || existsSync(safeWorkspacePath(realRoot, path))) continue;
            let prior: Buffer | undefined;
            if (binding.baseline.head) {
              const tracked = execFileSync('git', ['--literal-pathspecs', '-C', realRoot, 'ls-tree', '-r', '--name-only', '-z', binding.baseline.head, '--', path],
                { stdio: 'pipe', encoding: 'utf8' }).split('\0');
              if (tracked.includes(path)) prior = execFileSync('git', ['-C', realRoot, 'show', `${binding.baseline.head}:${path}`], { stdio: 'pipe', maxBuffer: WORKSPACE_LIMITS.fileBytes });
            } else if (binding.baseline.snapshotId) prior = readWorkspaceBaseline(binding.baseline.snapshotId, path);
            if (prior) deletions.push({ path, priorSha256: snapshotHash(prior) });
          } catch (error: any) { errors.push(`Deletion evidence ${path}: ${error.message}`); }
        }
      }
      if (deletions.length) {
        const content = JSON.stringify({ schemaVersion: 1, deletions });
        capture(upsertExecutionArtifact({ workspaceId: data.task.workspaceId, taskId: data.task.id,
          executionId: data.executionId, name: 'Reviewed deletion evidence', kind: 'json', mimeType: 'application/json',
          source: 'result', relativePath: '__workspace_deletions__.json', content,
          sizeBytes: Buffer.byteLength(content), metadata: { workspaceDeletions: true } }), Buffer.from(content));
      }
      let files: string[] = [];
      try { files = collectFiles(realRoot, data.startedAtMs, data.baseline, exclusions); } catch (error: any) { errors.push(error.message); }
      for (const path of files) {
        try {
          const realPath = realpathSync(path);
          const rel = relative(realRoot, realPath);
          if (!rel || rel.startsWith('..')) continue;
          const stats = statSync(realPath);
          const descriptor = describe(realPath);
          const bytes = readWorkspaceBytes(realRoot, rel, WORKSPACE_LIMITS.fileBytes);
          capture(upsertExecutionArtifact({
            workspaceId: data.task.workspaceId,
            taskId: data.task.id,
            executionId: data.executionId,
            pipelineId: data.task.pipelineId,
            stageIndex: data.task.stageIndex,
            name: basename(realPath),
            kind: descriptor.kind,
            mimeType: descriptor.mimeType,
            source: rel.startsWith('output/') ? 'output' : 'workspace',
            relativePath: rel,
            rootPath: realRoot,
            sizeBytes: stats.size,
            metadata: { modifiedAt: stats.mtime.toISOString(), captureState: 'pending' },
          }), bytes);
        } catch (error: any) { errors.push(error.message); }
      }
    }
  }
  const resultArtifact = indexed.find(artifact => artifact.relativePath === '__result__.md');
  if (resultArtifact) getDb().run('UPDATE execution_artifacts SET metadata=? WHERE id=?', JSON.stringify({
    ...resultArtifact.metadata, captureReport: { exclusions: exclusions.slice(0, 250), errors, filteredPolicy: true },
  }), resultArtifact.id);
  if (binding) touchWorkspace(binding.filesystemWorkspaceId, errors.length ? 'failed' : state);
  if (errors.length) throw new Error(`ARTIFACT_CAPTURE_FAILED: ${errors.join('; ')}`);

  for (const artifact of indexed) {
    eventBus.emit('artifact:published', {
      artifact: { ...artifact, rootPath: undefined, content: undefined },
      artifactId: artifact.id,
      taskId: artifact.taskId,
      executionId: artifact.executionId,
      workspaceId: artifact.workspaceId,
    });
  }
  return indexed.length;
}
