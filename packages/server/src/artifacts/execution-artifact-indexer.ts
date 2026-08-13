import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import type { Task } from '../types.js';
import { upsertExecutionArtifact } from '../db/models/execution-artifact.js';
import { eventBus } from '../events/event-bus.js';

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

function collectFiles(root: string, sinceMs: number): string[] {
  const files: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = statSync(path);
        if (stats.mtimeMs >= sinceMs - 2_000) {
          files.push(path);
        }
      } catch { /* file disappeared during scan */ }
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
}): number {
  const root = data.task.workdir || data.task.workspacePath;
  const indexed = [];
  indexed.push(upsertExecutionArtifact({
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
  }));

  if (root) {
    let realRoot: string | undefined;
    try { realRoot = realpathSync(resolve(root)); } catch { realRoot = undefined; }
    if (realRoot) {
      for (const path of collectFiles(realRoot, data.startedAtMs)) {
        try {
          const realPath = realpathSync(path);
          const rel = relative(realRoot, realPath);
          if (!rel || rel.startsWith('..')) continue;
          const stats = statSync(realPath);
          const descriptor = describe(realPath);
          indexed.push(upsertExecutionArtifact({
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
            metadata: { modifiedAt: stats.mtime.toISOString() },
          }));
        } catch { /* unreadable artifact */ }
      }
    }
  }

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
