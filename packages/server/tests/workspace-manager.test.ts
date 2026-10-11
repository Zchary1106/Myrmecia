import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';

const temporaryRoots: string[] = [];

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'myrmecia-workspace-manager-'));
  temporaryRoots.push(root);
  execFileSync('git', ['init', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Myrmecia Test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  writeFileSync(join(root, 'README.md'), '# test\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '-m', 'initial']);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('WorkspaceManager', () => {
  it('rejects unattended merge and leaves the source unchanged', async () => {
    const root = createRepository();
    const marker = join(root, 'shell-injection-marker');
    const manager = new WorkspaceManager(root);
    const workspace = await manager.createPipelineWorkspace('pipe_security');
    writeFileSync(join(workspace.path, 'result.txt'), 'complete\n');

    const result = await manager.mergePipelineWorkspace(
      'pipe_security',
      `safe"; touch "${marker}"; #`,
    );

    expect(result).toEqual({ success: false, error: 'EXPLICIT_REVIEWED_CHANGESET_REQUIRED' });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, 'result.txt'))).toBe(false);
    expect(existsSync(join(workspace.path, 'result.txt'))).toBe(true);
  });

  it('retains legacy directories regardless of age and rejects unguarded cleanup', async () => {
    const root = createRepository();
    const manager = new WorkspaceManager(root);
    const workspace = await manager.createTaskWorkspace('task_retention');
    expect(workspace.type).toBe('task');
    const old = new Date('2025-01-01T00:00:00Z');
    utimesSync(workspace.path, old, old);

    const protectedResult = await manager.cleanupExpiredWorkspaces({
      retentionMs: 60_000,
      protectedWorkspaceKeys: new Set(['task:task_retention']),
      now: old.getTime() + 120_000,
    });
    expect(protectedResult.protected).toBe(1);
    expect(existsSync(workspace.path)).toBe(true);

    const cleanupResult = await manager.cleanupExpiredWorkspaces({
      retentionMs: 60_000,
      now: old.getTime() + 120_000,
    });
    expect(cleanupResult.removed).toBe(0);
    expect(existsSync(workspace.path)).toBe(true);
    await expect(manager.cleanupWorkspace('task_retention', 'task')).rejects.toThrow('EXPLICIT_WORKSPACE_PURGE_REQUIRED');
  });
});
