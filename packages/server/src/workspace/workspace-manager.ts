import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ExecutionWorkspaceBinding, WorkspaceAccessMode } from '@myrmecia/shared';
import { assertWorkspaceIdentity, bindWorkspace, getManagedWorkspace, getWorkspaceBinding, markWorkspaceCandidates, registerManagedWorkspace, type WorkspaceScope } from '../db/models/managed-workspace.js';
import { excludedWorkspacePath, ownGitRoot, readWorkspaceBytes, safeWorkspacePath, WORKSPACE_LIMITS } from './path-policy.js';
import { withWorkspaceLease } from './workspace-lease.js';
import type { Task } from '../types.js';
import { captureWorkspaceBaseline } from './workspace-baseline.js';

/** Filesystem preparation is separate from output acceptance and Git integration. */
export class WorkspaceManager {
  private workspacesDir: string;
  constructor(private baseDir = process.env.MYRMECIA_WORKSPACE_ROOT || process.cwd()) {
    this.workspacesDir = join(baseDir, '.agent-factory', 'workspaces');
    mkdirSync(this.workspacesDir, { recursive: true });
  }
  async createPipelineWorkspace(id: string, options?: WorkspaceScope & { sourceWorkspaceId?: string; accessMode?: WorkspaceAccessMode }): Promise<WorkspaceInfo> {
    if (!options) return this.createEmpty(id, 'pipeline');
    const source = options.sourceWorkspaceId ? getManagedWorkspace(options.sourceWorkspaceId, options) : undefined;
    const prepare = () => this.prepareExecutionWorkspace({ ...options, taskId: `pipeline_${id}` });
    const binding = source && (options.accessMode || 'isolated') === 'isolated'
      ? await withWorkspaceLease({ id: `pipeline_${id}`, workdir: source.canonicalPath, workspaceId: options.workspaceId } as Task, prepare)
      : await prepare();
    return { id, type: 'pipeline', path: binding.executionPath, isGitWorktree: !!binding.baseline.head, branchName: binding.baseline.branch, accessMode: binding.accessMode };
  }
  async createTaskWorkspace(id: string): Promise<WorkspaceInfo> { return this.createEmpty(id, 'task'); }
  private createEmpty(id: string, type: 'pipeline' | 'task'): WorkspaceInfo {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('INVALID_WORKSPACE_ID');
    const path = safeWorkspacePath(this.workspacesDir, `${type}-${id}`);
    mkdirSync(join(path, 'output'), { recursive: true });
    return this.getWorkspaceInfo(id, type)!;
  }
  async prepareExecutionWorkspace(data: WorkspaceScope & {
    taskId: string; sourceWorkspaceId?: string; accessMode?: WorkspaceAccessMode;
  }): Promise<ExecutionWorkspaceBinding> {
    const existing = getWorkspaceBinding(data.taskId);
    if (existing) {
      const workspace = getManagedWorkspace(existing.filesystemWorkspaceId, data);
      if (!workspace || !['active', 'candidate'].includes(workspace.lifecycle)) throw new Error('WORKSPACE_NOT_WRITABLE');
      assertWorkspaceIdentity(workspace);
      return existing;
    }
    const mode = data.accessMode || 'isolated';
    const source = data.sourceWorkspaceId ? getManagedWorkspace(data.sourceWorkspaceId, data) : undefined;
    if (data.sourceWorkspaceId && !source) throw new Error('WORKSPACE_SOURCE_NOT_FOUND');
    if (source) {
      assertWorkspaceIdentity(source);
      if (!['active', 'candidate'].includes(source.lifecycle)) throw new Error('WORKSPACE_SOURCE_ARCHIVED');
    }
    if (mode !== 'isolated' && !source) throw new Error('SHARED_MODE_REQUIRES_SOURCE');
    let workspace = source;
    if (mode === 'isolated') {
      if (!/^[a-zA-Z0-9_-]+$/.test(data.taskId)) throw new Error('INVALID_WORKSPACE_ID');
      const path = safeWorkspacePath(this.workspacesDir, `task-${data.taskId}`);
      if (existsSync(path)) throw new Error('WORKSPACE_PATH_NEEDS_RECONCILIATION');
      let baseline: ExecutionWorkspaceBinding['baseline'] = { provenance: 'empty', excluded: [] };
      if (source) {
        let head: string | undefined;
        try { if (ownGitRoot(source.canonicalPath)) head = execFileSync('git', ['-C', source.canonicalPath, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim(); }
        catch { if (existsSync(join(source.canonicalPath, '.git'))) throw new Error('GIT_BASELINE_UNAVAILABLE'); }
        if (head) {
          const tracked = execFileSync('git', ['-C', source.canonicalPath, 'ls-tree', '-r', '--name-only', '-z', head], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
          const excluded = tracked.split('\0').filter(Boolean).filter(excludedWorkspacePath);
          if (excluded.some(path => /[\n\r*?\[\]!\\]/.test(path))) throw new Error('GIT_EXCLUSION_PATH_UNSUPPORTED');
          const branch = `codex/task-${data.taskId}`;
          const dirty = execFileSync('git', ['-C', source.canonicalPath, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
          baseline = { head, branch, provenance: 'head_only', excluded: [...excluded, ...(dirty ? ['Uncommitted/untracked source changes excluded (HEAD only)'] : [])] };
          // Fail closed: no retry with a stale branch, no empty-folder fallback.
          execFileSync('git', ['-C', source.canonicalPath, 'worktree', 'add', '--no-checkout', '-b', branch, path, head], { stdio: 'pipe' });
          execFileSync('git', ['-C', path, 'sparse-checkout', 'set', '--no-cone', '--stdin'], {
            input: `/*\n${excluded.map(file => `!/${file}`).join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'],
          });
          execFileSync('git', ['-C', path, 'read-tree', '-mu', 'HEAD'], { stdio: 'pipe' });
        } else {
          mkdirSync(path, { recursive: true });
          baseline = { provenance: 'filtered_copy', excluded: [] };
          let total = 0, count = 0;
          const walk = (dir: string, depth: number) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const rel = relative(source.canonicalPath, join(dir, entry.name));
              if (excludedWorkspacePath(rel) || entry.isSymbolicLink()) { baseline.excluded.push(rel); continue; }
              if (depth > WORKSPACE_LIMITS.depth) throw new Error('WORKSPACE_COPY_DEPTH_QUOTA');
              if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
              else if (entry.isFile()) {
                const bytes = readWorkspaceBytes(source.canonicalPath, rel);
                total += bytes.length;
                if (++count > WORKSPACE_LIMITS.files || total > WORKSPACE_LIMITS.totalBytes) throw new Error('WORKSPACE_COPY_QUOTA');
                const target = safeWorkspacePath(path, rel);
                mkdirSync(join(target, '..'), { recursive: true });
                writeFileSync(target, bytes, { flag: 'wx' });
              }
            }
          };
          walk(source.canonicalPath, 0);
        }
      } else mkdirSync(path, { recursive: true });
      if (source && !baseline.head) baseline.snapshotId = captureWorkspaceBaseline(path);
      mkdirSync(safeWorkspacePath(path, 'output'), { recursive: true });
      workspace = registerManagedWorkspace({ ...data, canonicalPath: path, sourcePath: source?.canonicalPath,
        sourceKind: baseline.head ? 'git' : source ? 'directory' : 'empty', ownership: 'managed_execution', accessMode: mode, baseline });
    }
    let bindingBaseline = workspace!.baseline;
    if (mode !== 'isolated') {
      bindingBaseline = { provenance: 'shared_live', excluded: [] };
      try {
        if (ownGitRoot(workspace!.canonicalPath)) {
          bindingBaseline.head = execFileSync('git', ['-C', workspace!.canonicalPath, 'rev-parse', 'HEAD'], { stdio: 'pipe', encoding: 'utf8' }).trim();
          bindingBaseline.branch = execFileSync('git', ['-C', workspace!.canonicalPath, 'branch', '--show-current'], { stdio: 'pipe', encoding: 'utf8' }).trim();
        }
      } catch { /* A shared non-Git directory is a live source, not a pinned copy. */ }
    }
    const binding: ExecutionWorkspaceBinding = { taskId: data.taskId, workspaceId: data.workspaceId,
      filesystemWorkspaceId: workspace!.id, sourceWorkspaceId: source?.id, executionPath: workspace!.canonicalPath,
      accessMode: mode, baseline: bindingBaseline };
    bindWorkspace(binding);
    return binding;
  }
  createStageDir(root: string, index: number, name: string): string {
    const path = safeWorkspacePath(root, `stage-${index}-${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`);
    mkdirSync(path, { recursive: true }); return path;
  }
  writeStageArtifact(root: string, output: string, fileName = 'output.md'): string {
    const path = safeWorkspacePath(root, fileName); writeFileSync(path, output, 'utf8'); return path;
  }
  readStageArtifact(root: string, fileName = 'output.md'): string | null {
    try { return readWorkspaceBytes(root, fileName).toString('utf8'); } catch { return null; }
  }
  /** Removed unsafe API. Explicit preview/apply lives in workspace-changes. */
  async mergePipelineWorkspace(_id: string, _message?: string): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'EXPLICIT_REVIEWED_CHANGESET_REQUIRED' };
  }
  async cleanupWorkspace(_id: string, _type: 'pipeline' | 'task' = 'pipeline'): Promise<void> {
    throw new Error('EXPLICIT_WORKSPACE_PURGE_REQUIRED');
  }
  getWorkspaceInfo(id: string, type: 'pipeline' | 'task' = 'pipeline'): WorkspaceInfo | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    const binding = getWorkspaceBinding(type === 'pipeline' ? `pipeline_${id}` : id);
    if (binding && existsSync(binding.executionPath)) return { id, type, path: binding.executionPath, isGitWorktree: !!binding.baseline.head, branchName: binding.baseline.branch, accessMode: binding.accessMode };
    const path = join(this.workspacesDir, `${type}-${id}`);
    if (!existsSync(path)) return null;
    let branchName: string | undefined;
    // Parent Git discovery alone is not evidence that this entry is a worktree.
    if (existsSync(join(path, '.git'))) {
      try { branchName = execFileSync('git', ['-C', path, 'branch', '--show-current'], { encoding: 'utf8' }).trim(); } catch { /* legacy */ }
    }
    return { id, type, path, isGitWorktree: !!branchName, branchName };
  }
  getOutputDir(id: string, type: 'pipeline' | 'task' = 'task'): string | null {
    const workspace = this.getWorkspaceInfo(id, type);
    if (!workspace) return null;
    const path = safeWorkspacePath(workspace.path, 'output'); mkdirSync(path, { recursive: true }); return path;
  }
  listWorkspaces(): WorkspaceInfo[] {
    return readdirSync(this.workspacesDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
      const match = entry.name.match(/^(pipeline|task)-(.+)$/);
      const info = match ? this.getWorkspaceInfo(match[2], match[1] as 'pipeline' | 'task') : null;
      return info ? [info] : [];
    });
  }
  async cleanupExpiredWorkspaces(options: { retentionMs: number; protectedWorkspaceKeys?: ReadonlySet<string>; now?: number }): Promise<WorkspaceCleanupResult> {
    if (!Number.isFinite(options.retentionMs) || options.retentionMs < 0) throw new Error('Invalid workspace retention');
    const candidates = markWorkspaceCandidates(options.retentionMs, options.now);
    return { removed: 0, candidates, protected: options.protectedWorkspaceKeys?.size || 0, retained: this.listWorkspaces().length, errors: [] };
  }
}
export interface WorkspaceInfo { path: string; type: 'pipeline' | 'task'; id: string; isGitWorktree: boolean; branchName?: string; accessMode?: WorkspaceAccessMode }
export interface WorkspaceCleanupResult { removed: number; candidates: number; protected: number; retained: number; errors: Array<{ key: string; message: string }> }
export const workspaceManager = new WorkspaceManager();
