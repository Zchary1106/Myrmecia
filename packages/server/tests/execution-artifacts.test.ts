import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/db/database.js';
import { indexExecutionArtifacts } from '../src/artifacts/execution-artifact-indexer.js';
import { getExecutionArtifact, listExecutionArtifacts } from '../src/db/models/execution-artifact.js';
import type { Task } from '../src/types.js';

describe('execution artifact indexing', () => {
  let root: string;

  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-artifact-db-')), 'test.db');
    getDb();
    root = mkdtempSync(join(tmpdir(), 'myrmecia-artifact-workspace-'));
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('indexes the final result and generated files', () => {
    mkdirSync(join(root, 'output'));
    writeFileSync(join(root, 'output', 'report.md'), '# report');
    writeFileSync(join(root, 'output', 'cover.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const task = {
      id: 'task-artifact',
      mode: 'direct',
      workdir: root,
      workspacePath: root,
      workspaceId: 'workspace-a',
    } as Task;

    const count = indexExecutionArtifacts({
      task,
      executionId: 'exec-artifact',
      output: 'Final answer',
      startedAtMs: Date.now() - 1000,
    });

    expect(count).toBe(3);
    const artifacts = listExecutionArtifacts({ executionId: 'exec-artifact' });
    expect(artifacts.map(item => item.relativePath).sort()).toEqual([
      '__result__.md',
      'output/cover.svg',
      'output/report.md',
    ]);
    expect(artifacts.find(item => item.name === 'cover.svg')?.kind).toBe('image');
    expect(getExecutionArtifact(artifacts[0].id)?.previewUrl).toContain('/artifacts/workbench/');
  });
});
