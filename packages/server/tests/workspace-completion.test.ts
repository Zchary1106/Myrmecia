import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';
import { registerManagedWorkspace, touchWorkspace, getManagedWorkspace } from '../src/db/models/managed-workspace.js';
import { captureArtifactBaseline, indexExecutionArtifacts } from '../src/artifacts/execution-artifact-indexer.js';
import { previewWorkspaceChanges, applyWorkspaceChanges } from '../src/workspace/workspace-changes.js';
import { previewWorkspaceMaintenance, applyWorkspaceMaintenance } from '../src/workspace/workspace-maintenance.js';
import { previewDirtySource, createDirtySourceSnapshot } from '../src/workspace/workspace-source-snapshot.js';
import { readWorkspaceBaseline } from '../src/workspace/workspace-baseline.js';
import { getDb } from '../src/db/database.js';
import type { Task } from '../src/types.js';
const scope = { workspaceId: 'default', actorId: 'local-admin' }, roots: string[] = [];
function fixture() { const path = mkdtempSync(join(tmpdir(), 'myrmecia-completion-')); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe('completed reviewed workspace operations', () => {
  it.each([false, true])('applies additions/modifications/deletions with frozen evidence (Git=%s)', async gitSource => {
    const root = fixture(), path = join(root, 'source'); mkdirSync(path);
    writeFileSync(join(path, 'edit.md'), 'before\n'); writeFileSync(join(path, 'delete.md'), 'deleted baseline\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (gitSource) {
      git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
      git('add', 'edit.md', 'delete.md'); git('commit', '-m', 'baseline');
    }
    const source = registerManagedWorkspace({ ...scope, canonicalPath: path, ownership: 'user_source',
      sourceKind: gitSource ? 'git' : 'directory', accessMode: 'shared_write',
      baseline: { provenance: gitSource ? 'head_only' : 'filtered_copy', excluded: [], ...(gitSource ? { head: git('rev-parse', 'HEAD') } : {}) } });
    const binding = await new WorkspaceManager(root).prepareExecutionWorkspace({ ...scope, taskId: `operations-${gitSource}`, sourceWorkspaceId: source.id });
    const baseline = captureArtifactBaseline(binding.executionPath);
    writeFileSync(join(binding.executionPath, 'edit.md'), 'after\n');
    writeFileSync(join(binding.executionPath, 'add.md'), 'new\n'); rmSync(join(binding.executionPath, 'delete.md'));
    const task = { id: binding.taskId, workspaceId: 'default', workdir: binding.executionPath } as Task;
    indexExecutionArtifacts({ task, executionId: `execution-${gitSource}`, output: 'Changes', startedAtMs: 0, baseline });
    const request = { targetWorkspaceId: source.id, files: ['edit.md', 'add.md', 'delete.md'] };
    const preview = previewWorkspaceChanges(scope, binding.filesystemWorkspaceId, request);
    expect(preview.blockers).toEqual([]);
    expect(preview.changes.map(change => change.operation).sort()).toEqual(['add', 'delete', 'modify']);
    writeFileSync(join(path, 'edit.md'), 'external target change\n');
    expect(() => applyWorkspaceChanges(scope, binding.filesystemWorkspaceId, { ...request, ...preview, confirm: true })).toThrow('STALE');
    writeFileSync(join(path, 'edit.md'), 'before\n');
    expect(applyWorkspaceChanges(scope, binding.filesystemWorkspaceId, { ...request, ...preview, confirm: true })).toMatchObject({ committed: false, pushed: false });
    expect(readFileSync(join(path, 'edit.md'), 'utf8')).toBe('after\n');
    expect(readFileSync(join(path, 'add.md'), 'utf8')).toBe('new\n'); expect(existsSync(join(path, 'delete.md'))).toBe(false);
    if (gitSource) expect(git('rev-parse', 'HEAD')).toBe(binding.baseline.head);
  });
  it('supports explicitly selected source deletions without changing original source', () => {
    const path = fixture(), git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    writeFileSync(join(path, 'gone.md'), 'baseline'); git('add', 'gone.md'); git('commit', '-m', 'baseline');
    const source = registerManagedWorkspace({ ...scope, canonicalPath: path, ownership: 'user_source', sourceKind: 'git',
      accessMode: 'shared_write', baseline: { provenance: 'head_only', head: git('rev-parse', 'HEAD'), excluded: [] } });
    rmSync(join(path, 'gone.md'));
    const preview = previewDirtySource(scope, source.id, ['gone.md']); expect(preview.deletedFiles).toEqual(['gone.md']);
    const copy = createDirtySourceSnapshot(scope, source.id, { ...preview, confirm: true });
    expect(existsSync(join(copy.canonicalPath, 'gone.md'))).toBe(false);
    expect(git('status', '--porcelain')).toContain('gone.md');
  });
  it('detects tampering with the frozen baseline manifest', async () => {
    const path = fixture(); writeFileSync(join(path, 'a.md'), 'original');
    const source = registerManagedWorkspace({ ...scope, canonicalPath: path, ownership: 'user_source', sourceKind: 'directory',
      accessMode: 'shared_write', baseline: { provenance: 'filtered_copy', excluded: [] } });
    const binding = await new WorkspaceManager(fixture()).prepareExecutionWorkspace({ ...scope, taskId: 'manifest-tamper', sourceWorkspaceId: source.id });
    expect(readWorkspaceBaseline(binding.baseline.snapshotId!, 'a.md')?.toString()).toBe('original');
    const root = join(process.env.MYRMECIA_WORKSPACE_ROOT!, '.agent-factory', 'workspace-baselines', binding.baseline.snapshotId!);
    writeFileSync(join(root, 'manifest.json'), '{"files":{}}');
    expect(() => readWorkspaceBaseline(binding.baseline.snapshotId!, 'a.md')).toThrow('MANIFEST_CHANGED');
  });
  it('adopts legacy as non-purgeable source only after a scoped preview', () => {
    const path = fixture(); writeFileSync(join(path, 'keep.md'), 'keep');
    const legacy = registerManagedWorkspace({ ...scope, canonicalPath: path, ownership: 'legacy_unmanaged', sourceKind: 'legacy',
      accessMode: 'shared_write', baseline: { provenance: 'legacy_recorded', excluded: [] } });
    const preview = previewWorkspaceMaintenance(scope, legacy.id, 'adopt_source');
    expect(preview.blockers).toEqual([]);
    expect(() => applyWorkspaceMaintenance(scope, legacy.id, { ...preview, confirm: false })).toThrow('CONFIRMATION');
    expect(() => applyWorkspaceMaintenance({ ...scope, actorId: 'other' }, legacy.id, { ...preview, confirm: true })).toThrow('EXPIRED');
    applyWorkspaceMaintenance(scope, legacy.id, { ...preview, confirm: true });
    expect(getManagedWorkspace(legacy.id)?.ownership).toBe('user_source');
    expect(readFileSync(join(path, 'keep.md'), 'utf8')).toBe('keep');
  });
  it('deletes only a purged owned branch with no unmerged commits and stale previews fail', async () => {
    const root = fixture(), path = join(root, 'git'); mkdirSync(path);
    const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    git('commit', '--allow-empty', '-m', 'baseline');
    const source = registerManagedWorkspace({ ...scope, canonicalPath: path, ownership: 'user_source', sourceKind: 'git',
      accessMode: 'shared_write', baseline: { provenance: 'head_only', excluded: [] } });
    const binding = await new WorkspaceManager(root).prepareExecutionWorkspace({ ...scope, taskId: 'branch-cleanup', sourceWorkspaceId: source.id });
    expect(previewWorkspaceMaintenance(scope, binding.filesystemWorkspaceId, 'delete_branch').blockers.length).toBeGreaterThan(0);
    git('worktree', 'remove', binding.executionPath);
    getDb().run("UPDATE managed_workspaces SET lifecycle='purged' WHERE id=?", binding.filesystemWorkspaceId);
    const preview = previewWorkspaceMaintenance(scope, binding.filesystemWorkspaceId, 'delete_branch'); expect(preview.blockers).toEqual([]);
    getDb().run('UPDATE managed_workspaces SET revision=revision+1 WHERE id=?', binding.filesystemWorkspaceId);
    expect(() => applyWorkspaceMaintenance(scope, binding.filesystemWorkspaceId, { ...preview, confirm: true })).toThrow('STALE');
    const fresh = previewWorkspaceMaintenance(scope, binding.filesystemWorkspaceId, 'delete_branch');
    applyWorkspaceMaintenance(scope, binding.filesystemWorkspaceId, { ...fresh, confirm: true });
    expect(() => git('rev-parse', '--verify', `refs/heads/${binding.baseline.branch}`)).toThrow();
    expect(existsSync(path)).toBe(true);
  });
  it('refuses removal of an owned branch with unmerged commits', async () => {
    const root = fixture(), path = join(root, 'git'); mkdirSync(path);
    const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    git('commit', '--allow-empty', '-m', 'baseline');
    const source = registerManagedWorkspace({ ...scope, canonicalPath: path, ownership: 'user_source', sourceKind: 'git',
      accessMode: 'shared_write', baseline: { provenance: 'head_only', excluded: [] } });
    const binding = await new WorkspaceManager(root).prepareExecutionWorkspace({ ...scope, taskId: 'unmerged-branch', sourceWorkspaceId: source.id });
    execFileSync('git', ['-C', binding.executionPath, 'commit', '--allow-empty', '-m', 'unmerged fixture'], { stdio: 'pipe' });
    git('worktree', 'remove', binding.executionPath);
    getDb().run("UPDATE managed_workspaces SET lifecycle='purged' WHERE id=?", binding.filesystemWorkspaceId);
    const preview = previewWorkspaceMaintenance(scope, binding.filesystemWorkspaceId, 'delete_branch');
    expect(preview.blockers.join(' ')).toContain('unmerged commits');
    expect(() => applyWorkspaceMaintenance(scope, binding.filesystemWorkspaceId, { ...preview, confirm: true })).toThrow('BLOCKED');
    expect(git('rev-parse', '--verify', `refs/heads/${binding.baseline.branch}`)).toBeTruthy();
  });
});
