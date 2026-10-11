import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '../src/types.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';
import { getDb } from '../src/db/database.js';
import { registerManagedWorkspace, getManagedWorkspace, touchWorkspace } from '../src/db/models/managed-workspace.js';
import { claimWorkspaceLease, releaseWorkspaceLease, withWorkspaceLease } from '../src/workspace/workspace-lease.js';
import { executeTool } from '../src/skills/tool-sandbox.js';
import { indexExecutionArtifacts } from '../src/artifacts/execution-artifact-indexer.js';
import { listExecutionArtifacts } from '../src/db/models/execution-artifact.js';
import { readArtifactSnapshot } from '../src/artifacts/artifact-snapshot-store.js';
import { applyWorkspaceOperation, previewWorkspaceOperation } from '../src/workspace/workspace-lifecycle.js';
import { applyWorkspaceChanges, previewWorkspaceChanges } from '../src/workspace/workspace-changes.js';
import { previewDirtySource, createDirtySourceSnapshot } from '../src/workspace/workspace-source-snapshot.js';
import { previewLeaseReconciliation, reconcileWorkspaceLeases } from '../src/workspace/workspace-reconciliation.js';
import { captureArtifactBaseline } from '../src/artifacts/execution-artifact-indexer.js';
import { prepareTaskWorkspace } from '../src/workspace/task-workspace.js';
import { createTask } from '../src/db/models/task.js';
import { setPauseControl } from '../src/agents/pause-control.js';
const roots: string[] = [], scope = { workspaceId: 'default', actorId: 'local-admin' };
function root() { const path = mkdtempSync(join(tmpdir(), 'myrmecia-storage-')); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function task(id: string, path: string): Task { return { id, workspaceId: 'default', workspacePath: path, workdir: path } as Task; }
function operation(preview: ReturnType<typeof previewWorkspaceOperation>) { return { operation: preview.operation, expectedRevision: preview.workspace.revision,
  manifestHash: preview.manifestHash, expiresAt: preview.expiresAt, previewId: preview.previewId, confirm: true }; }
describe('workspace storage authority', () => {
  it('refuses paused Git continuation when the execution HEAD changed outside its checkpoint', async () => {
    const sourcePath = root();
    execFileSync('git', ['init', '-b', 'main', sourcePath], { stdio: 'pipe' });
    execFileSync('git', ['-C', sourcePath, 'config', 'user.email', 'fixture@example.test']);
    execFileSync('git', ['-C', sourcePath, 'config', 'user.name', 'Fixture']);
    writeFileSync(join(sourcePath, 'report.md'), 'baseline');
    execFileSync('git', ['-C', sourcePath, 'add', 'report.md']);
    execFileSync('git', ['-C', sourcePath, 'commit', '-m', 'fixture baseline'], { stdio: 'pipe' });
    const source = registerManagedWorkspace({ ...scope, canonicalPath: sourcePath, ownership: 'user_source',
      sourceKind: 'git', accessMode: 'isolated', baseline: { provenance: 'head_only', excluded: [] } });
    const pending = createTask({ title: 'Paused fixture', description: '', input: '', mode: 'direct' });
    const prepared = await prepareTaskWorkspace(pending, { actorId: scope.actorId, sourceWorkspaceId: source.id });
    setPauseControl('task', pending.id, 'paused', 'running');
    await expect(prepareTaskWorkspace(prepared)).resolves.toMatchObject({ workspacePath: prepared.workspacePath });
    execFileSync('git', ['-C', prepared.workspacePath!, 'commit', '--allow-empty', '-m', 'external checkpoint drift'], { stdio: 'pipe' });
    await expect(prepareTaskWorkspace(prepared)).rejects.toThrow('WORKSPACE_PAUSE_BASELINE_CHANGED');
  });
  it('serializes canonical/overlapping roots and denies readonly writes and opaque tools', async () => {
    const path = root();
    const workspace = registerManagedWorkspace({ ...scope, canonicalPath: path, ownership: 'user_source', sourceKind: 'directory',
      accessMode: 'shared_write', baseline: { provenance: 'filtered_copy', excluded: [] } });
    const manager = new WorkspaceManager(root());
    const binding = await manager.prepareExecutionWorkspace({ ...scope, taskId: 'reader', sourceWorkspaceId: workspace.id, accessMode: 'shared_readonly' });
    await withWorkspaceLease(task('reader', binding.executionPath), async () => {
      expect(() => claimWorkspaceLease(task('writer', path))).toThrow('WORKSPACE_BUSY');
      expect((await executeTool('file_write', { path: 'bad', content: 'x' }, path)).output).toContain('READONLY');
      expect((await executeTool('shell_exec', { command: 'pwd' }, path)).output).toContain('READONLY');
      expect(existsSync(join(path, 'bad'))).toBe(false);
    });
    const lease = claimWorkspaceLease(task('writer', path));
    const nested = join(path, 'nested'); mkdirSync(nested);
    expect(() => claimWorkspaceLease(task('other', nested))).toThrow('WORKSPACE_BUSY');
    releaseWorkspaceLease(lease);
    const next = claimWorkspaceLease(task('next', path)); expect(next.fence).toBeGreaterThan(lease.fence); releaseWorkspaceLease(next);
  });
  it('historical bytes remain unchanged after overwrite and deletion; secrets are excluded', () => {
    const path = root();
    writeFileSync(join(path, 'report.md'), 'version A'); writeFileSync(join(path, '.env'), 'never capture');
    indexExecutionArtifacts({ task: task('immutable', path), executionId: 'immutable-a', output: 'A', startedAtMs: 0 });
    const report = listExecutionArtifacts({ executionId: 'immutable-a' }).find(item => item.name === 'report.md')!;
    expect(report.metadata.immutable).toBe(true);
    expect(listExecutionArtifacts({ executionId: 'immutable-a' }).some(item => item.relativePath === '.env')).toBe(false);
    writeFileSync(join(path, 'report.md'), 'version B');
    expect(readArtifactSnapshot(report)?.toString()).toBe('version A');
    rmSync(join(path, 'report.md'));
    expect(readArtifactSnapshot(report)?.toString()).toBe('version A');
    expect(() => indexExecutionArtifacts({ task: task('quota', path), executionId: 'quota', output: 'x'.repeat(21 * 1024 * 1024), startedAtMs: 0 })).toThrow('ARTIFACT_CAPTURE_FAILED');
  });
  it('archives in place, refuses stale previews and purges only retained owned fixture bytes', async () => {
    const manager = new WorkspaceManager(root());
    const binding = await manager.prepareExecutionWorkspace({ ...scope, taskId: 'lifecycle-owned' });
    writeFileSync(join(binding.executionPath, 'report.md'), 'saved');
    indexExecutionArtifacts({ task: task('lifecycle-owned', binding.executionPath), executionId: 'lifecycle-output', output: 'result', startedAtMs: 0 });
    const preview = previewWorkspaceOperation(scope, binding.filesystemWorkspaceId, 'archive');
    expect(preview.blockers).toEqual([]);
    expect(() => applyWorkspaceOperation(scope, binding.filesystemWorkspaceId, { ...operation(preview), confirm: false })).toThrow('CONFIRMATION');
    applyWorkspaceOperation(scope, binding.filesystemWorkspaceId, operation(preview));
    expect(readFileSync(join(binding.executionPath, 'report.md'), 'utf8')).toBe('saved');
    expect(() => claimWorkspaceLease(task('lifecycle-owned', binding.executionPath))).toThrow('ARCHIVED');
    expect(() => applyWorkspaceOperation(scope, binding.filesystemWorkspaceId, operation(preview))).toThrow('PREVIEW');
    const restore = previewWorkspaceOperation(scope, binding.filesystemWorkspaceId, 'restore');
    applyWorkspaceOperation(scope, binding.filesystemWorkspaceId, operation(restore));
    expect(getManagedWorkspace(binding.filesystemWorkspaceId)?.lifecycle).toBe('active');
    const archive = previewWorkspaceOperation(scope, binding.filesystemWorkspaceId, 'archive');
    applyWorkspaceOperation(scope, binding.filesystemWorkspaceId, operation(archive));
    const purge = previewWorkspaceOperation(scope, binding.filesystemWorkspaceId, 'purge');
    expect(purge.blockers).toEqual([]);
    const artifact = listExecutionArtifacts({ executionId: 'lifecycle-output' }).find(item => item.name === 'report.md')!;
    applyWorkspaceOperation(scope, binding.filesystemWorkspaceId, operation(purge));
    expect(existsSync(binding.executionPath)).toBe(false);
    expect(readArtifactSnapshot(artifact)?.toString()).toBe('saved');
  });
  it('blocks a persisted uncertain owner across a separate process/database connection', () => {
    const path = root(), lease = claimWorkspaceLease(task('crashed', path));
    const script = `import { claimWorkspaceLease } from './src/workspace/workspace-lease.ts'; try { claimWorkspaceLease({id:'second',workdir:process.env.FIXTURE_WORKSPACE_PATH}); process.exit(2); } catch(e) { console.log(e.message); }`;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: process.cwd(), env: { ...process.env, FIXTURE_WORKSPACE_PATH: path }, encoding: 'utf8' });
    expect(output).toContain('WORKSPACE_BUSY'); releaseWorkspaceLease(lease);
  });
  it('requires an explicit stopped-effects attestation before releasing an uncertain claim', () => {
    const path = root();
    const workspace = registerManagedWorkspace({ ...scope, canonicalPath: path, ownership: 'user_source', sourceKind: 'directory',
      accessMode: 'shared_write', baseline: { provenance: 'filtered_copy', excluded: [] } });
    const lease = claimWorkspaceLease(task('uncertain-owner', path));
    getDb().run("UPDATE workspace_leases SET state='uncertain' WHERE id=?", lease.id);
    const preview = previewLeaseReconciliation(scope, workspace.id);
    expect(() => reconcileWorkspaceLeases(scope, workspace.id, { ...preview, effectsStopped: false, confirm: true })).toThrow('ATTESTATION');
    expect(() => claimWorkspaceLease(task('still-blocked', path))).toThrow('WORKSPACE_BUSY');
    expect(reconcileWorkspaceLeases(scope, workspace.id, { ...preview, effectsStopped: true, confirm: true })).toMatchObject({ released: 1, replayed: false });
    const next = claimWorkspaceLease(task('fresh', path)); expect(next.fence).toBeGreaterThan(lease.fence); releaseWorkspaceLease(next);
  });
  it('captures changed outputs instead of freshly copied inputs and exports unsupported non-Git patches', async () => {
    const base = root(), sourcePath = join(base, 'source'); mkdirSync(sourcePath);
    writeFileSync(join(sourcePath, 'input.md'), 'original\n');
    const source = registerManagedWorkspace({ ...scope, canonicalPath: sourcePath, ownership: 'user_source', sourceKind: 'directory',
      accessMode: 'shared_write', baseline: { provenance: 'filtered_copy', excluded: [] } });
    const binding = await new WorkspaceManager(base).prepareExecutionWorkspace({ ...scope, taskId: 'baseline-output', sourceWorkspaceId: source.id });
    const baseline = captureArtifactBaseline(binding.executionPath);
    writeFileSync(join(binding.executionPath, 'report.md'), 'new output\n');
    indexExecutionArtifacts({ task: task('baseline-output', binding.executionPath), executionId: 'baseline-output-exec', output: 'result', startedAtMs: 0, baseline });
    expect(listExecutionArtifacts({ executionId: 'baseline-output-exec' }).map(artifact => artifact.relativePath).sort()).toEqual(['__result__.md', 'report.md']);
    const patch = previewWorkspaceChanges(scope, binding.filesystemWorkspaceId, { targetWorkspaceId: source.id, files: ['report.md'] });
    expect(patch.patch).toContain('+new output'); expect(patch.blockers).toEqual([]);
    writeFileSync(join(binding.executionPath, '.env'), 'must not disappear');
    const archive = previewWorkspaceOperation(scope, binding.filesystemWorkspaceId, 'archive');
    applyWorkspaceOperation(scope, binding.filesystemWorkspaceId, operation(archive));
    expect(previewWorkspaceOperation(scope, binding.filesystemWorkspaceId, 'purge').blockers.join(' ')).toContain('EXCLUDED_FILES');
    expect(existsSync(join(binding.executionPath, '.env'))).toBe(true);
  });
  it('applies only explicitly reviewed tracked changes without committing or pushing', async () => {
    const base = root(), sourcePath = join(base, 'repo'); mkdirSync(sourcePath);
    const git = (...args: string[]) => execFileSync('git', ['-C', sourcePath, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    writeFileSync(join(sourcePath, 'a.md'), 'old\n'); git('add', 'a.md'); git('commit', '-m', 'baseline');
    const head = git('rev-parse', 'HEAD');
    const dirty = previewDirtySource(scope, registerManagedWorkspace({ ...scope, canonicalPath: sourcePath, ownership: 'user_source', sourceKind: 'git',
      accessMode: 'shared_write', baseline: { provenance: 'head_only', head, excluded: [] } }).id, ['a.md']);
    expect(dirty.selectedFiles).toEqual(['a.md']);
    writeFileSync(join(sourcePath, 'a.md'), 'dirty for preview\n');
    expect(() => createDirtySourceSnapshot(scope, dirty.sourceId, { ...dirty, confirm: true })).toThrow('STALE');
    const fresh = previewDirtySource(scope, dirty.sourceId, ['a.md']);
    const snapshot = createDirtySourceSnapshot(scope, dirty.sourceId, { ...fresh, confirm: true });
    expect(readFileSync(join(snapshot.canonicalPath, 'a.md'), 'utf8')).toBe('dirty for preview\n');
    writeFileSync(join(sourcePath, 'a.md'), 'old\n');
    const source = registerManagedWorkspace({ ...scope, canonicalPath: sourcePath, ownership: 'user_source', sourceKind: 'git',
      accessMode: 'shared_write', baseline: { provenance: 'head_only', head, excluded: [] } });
    const binding = await new WorkspaceManager(base).prepareExecutionWorkspace({ ...scope, taskId: 'apply-fixture', sourceWorkspaceId: source.id });
    writeFileSync(join(binding.executionPath, 'a.md'), 'new\n');
    indexExecutionArtifacts({ task: task('apply-fixture', binding.executionPath), executionId: 'apply-evidence', output: 'Changed a.md', startedAtMs: 0 });
    touchWorkspace(binding.filesystemWorkspaceId, 'complete');
    writeFileSync(join(binding.executionPath, 'a.md'), 'unsealed external change\n');
    const unsealed = previewWorkspaceChanges(scope, binding.filesystemWorkspaceId, { targetWorkspaceId: source.id, files: ['a.md'] });
    expect(unsealed.blockers.join(' ')).toContain('matching immutable evidence');
    expect(() => applyWorkspaceChanges(scope, binding.filesystemWorkspaceId, { targetWorkspaceId: source.id, files: ['a.md'], ...unsealed, confirm: true })).toThrow('CHANGESET_BLOCKED');
    expect(readFileSync(join(sourcePath, 'a.md'), 'utf8')).toBe('old\n');
    rmSync(join(binding.executionPath, 'a.md'));
    const deleted = previewWorkspaceChanges(scope, binding.filesystemWorkspaceId, { targetWorkspaceId: source.id, files: ['a.md'] });
    expect(deleted.blockers.join(' ')).toContain('matching immutable evidence');
    writeFileSync(join(binding.executionPath, 'a.md'), 'new\n');
    writeFileSync(join(binding.executionPath, 'new.md'), 'new untracked output\n');
    const manual = previewWorkspaceChanges(scope, binding.filesystemWorkspaceId, { targetWorkspaceId: source.id, files: ['new.md'] });
    expect(manual.patch).toContain('+new untracked output');
    expect(manual.blockers.join(' ')).toContain('matching immutable evidence');
    const request = { targetWorkspaceId: source.id, files: ['a.md'] };
    const preview = previewWorkspaceChanges(scope, binding.filesystemWorkspaceId, request);
    expect(preview.blockers).toEqual([]);
    expect(() => applyWorkspaceChanges(scope, binding.filesystemWorkspaceId, { ...request, ...preview, confirm: false })).toThrow('CONFIRMATION');
    expect(readFileSync(join(sourcePath, 'a.md'), 'utf8')).toBe('old\n');
    applyWorkspaceChanges(scope, binding.filesystemWorkspaceId, { ...request, ...preview, confirm: true });
    expect(readFileSync(join(sourcePath, 'a.md'), 'utf8')).toBe('new\n');
    expect(existsSync(join(sourcePath, 'new.md'))).toBe(false);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(getDb().get<any>("SELECT state FROM workspace_operation_journal WHERE operation='apply_changes' ORDER BY created_at DESC LIMIT 1")?.state).toBe('complete');
  });
});
