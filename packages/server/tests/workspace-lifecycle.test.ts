import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';
import { markWorkspaceCandidates, registerManagedWorkspace, getManagedWorkspace, touchWorkspace } from '../src/db/models/managed-workspace.js';
import { safeWorkspacePath } from '../src/workspace/path-policy.js';
import { executeTool } from '../src/skills/tool-sandbox.js';
const roots: string[] = [];
const scope = { workspaceId: 'default', actorId: 'local-admin' };
function fixture() { const root = mkdtempSync(join(tmpdir(), 'myrmecia-lifecycle-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('workspace lifecycle', () => {
  it('prepares filtered isolated copies, preserves sources, and never guesses ownership', async () => {
    const root = fixture(), sourcePath = join(root, 'source'); mkdirSync(sourcePath);
    writeFileSync(join(sourcePath, 'a.md'), 'source'); writeFileSync(join(sourcePath, '.env'), 'secret');
    const source = registerManagedWorkspace({ ...scope, canonicalPath: sourcePath, ownership: 'user_source', sourceKind: 'directory',
      accessMode: 'shared_write', baseline: { provenance: 'filtered_copy', excluded: [] } });
    expect(getManagedWorkspace(source.id, { ...scope, actorId: 'other' })).toBeUndefined();
    const binding = await new WorkspaceManager(root).prepareExecutionWorkspace({ ...scope, taskId: 'copy1', sourceWorkspaceId: source.id });
    expect(readFileSync(join(binding.executionPath, 'a.md'), 'utf8')).toBe('source');
    expect(existsSync(join(binding.executionPath, '.env'))).toBe(false);
    expect(binding.executionPath).not.toBe(sourcePath);
    touchWorkspace(binding.filesystemWorkspaceId, 'complete');
    expect(markWorkspaceCandidates(0, Date.now() + 1000)).toBeGreaterThan(0);
    expect(existsSync(binding.executionPath)).toBe(true);
    expect(readFileSync(join(sourcePath, 'a.md'), 'utf8')).toBe('source');
  });
  it('pins registered repository HEAD, not the manager/server repository', async () => {
    const root = fixture(), sourcePath = join(root, 'repo'); mkdirSync(sourcePath);
    const git = (...args: string[]) => execFileSync('git', ['-C', sourcePath, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    writeFileSync(join(sourcePath, 'a.txt'), 'committed');
    writeFileSync(join(sourcePath, '.env'), 'fixture secret excluded even when tracked');
    git('add', 'a.txt', '.env'); git('commit', '-m', 'baseline');
    const head = git('rev-parse', 'HEAD'); writeFileSync(join(sourcePath, 'a.txt'), 'dirty');
    const source = registerManagedWorkspace({ ...scope, canonicalPath: sourcePath, ownership: 'user_source', sourceKind: 'git',
      accessMode: 'shared_write', baseline: { provenance: 'head_only', head, excluded: [] } });
    const binding = await new WorkspaceManager(root).prepareExecutionWorkspace({ ...scope, taskId: 'git1', sourceWorkspaceId: source.id });
    expect(readFileSync(join(binding.executionPath, 'a.txt'), 'utf8')).toBe('committed');
    expect(existsSync(join(binding.executionPath, '.env'))).toBe(false);
    expect(binding.baseline.excluded).toContain('.env');
    expect(binding.baseline.head).toBe(head); expect(binding.baseline.branch).toBe('codex/task-git1');
    expect(git('rev-parse', 'HEAD')).toBe(head); expect(git('status', '--porcelain')).toContain('a.txt');
  });
  it('rejects traversal and symlink write escapes including dangling links', () => {
    const root = fixture(), outside = fixture();
    symlinkSync(outside, join(root, 'link')); symlinkSync(join(outside, 'missing'), join(root, 'dangling'));
    expect(() => safeWorkspacePath(root, '../escape')).toThrow();
    expect(() => safeWorkspacePath(root, 'link/file')).toThrow('SYMLINK');
    expect(() => safeWorkspacePath(root, 'dangling')).toThrow('SYMLINK');
    expect(safeWorkspacePath(root, 'nested/new')).toBe(join(realpathSync(root), 'nested/new'));
  });
  it('does not borrow a parent server repository for an imported non-Git source or host Git discovery', async () => {
    const root = fixture();
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
    writeFileSync(join(root, 'server-only.md'), 'not the selected project');
    execFileSync('git', ['-C', root, 'add', 'server-only.md']);
    execFileSync('git', ['-C', root, 'commit', '-m', 'server']);
    const imported = join(root, 'imported'); mkdirSync(imported);
    writeFileSync(join(imported, 'selected.md'), 'selected project');
    const source = registerManagedWorkspace({ ...scope, canonicalPath: imported, sourceKind: 'import',
      ownership: 'managed_import', accessMode: 'shared_write', baseline: { provenance: 'filtered_copy', excluded: [] } });
    const binding = await new WorkspaceManager(root).prepareExecutionWorkspace({ ...scope, taskId: 'nested-source', sourceWorkspaceId: source.id });
    expect(binding.baseline.provenance).toBe('filtered_copy');
    expect(readFileSync(join(binding.executionPath, 'selected.md'), 'utf8')).toBe('selected project');
    expect(existsSync(join(binding.executionPath, 'server-only.md'))).toBe(false);
    expect((await executeTool('shell_exec', { command: 'git rev-parse --show-toplevel' }, binding.executionPath)).status).toBe('failed');
  });
});
