import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/db/database.js';
import { captureArtifactBaseline, indexExecutionArtifacts } from '../src/artifacts/execution-artifact-indexer.js';
import { getExecutionArtifact, listExecutionArtifacts } from '../src/db/models/execution-artifact.js';
import type { Task } from '../src/types.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution } from '../src/db/models/execution.js';
import { verifyCompletionCriteria } from '../src/agents/completion-gate.js';
import { readArtifactSnapshot } from '../src/artifacts/artifact-snapshot-store.js';

function persistedFixture(root: string, relativePath = 'result.md') {
  const task = createTask({ title: 'Verify existing delivery', input: 'Validate', description: '',
    mode: 'direct', workdir: root, workspacePath: root, workspaceId: 'workspace-a',
    completionCriteria: [{ id: 'file', label: 'Required file', required: true, verifier: 'artifact', relativePath }] });
  const execution = createExecution({ taskId: task.id, agentDefId: 'fixture', workspaceId: 'workspace-a' });
  return { task, execution };
}

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

  it('captures unchanged required files as fresh scoped immutable evidence for a validation run', async () => {
    const { task, execution } = persistedFixture(root);
    writeFileSync(join(root, 'result.md'), 'Existing implementation');
    writeFileSync(join(root, 'unrelated.md'), 'Not requested');
    const baseline = captureArtifactBaseline(root);
    expect(indexExecutionArtifacts({ task, executionId: execution.id, output: 'Validated',
      startedAtMs: Date.now(), baseline })).toBe(2);
    const artifact = listExecutionArtifacts({ executionId: execution.id }).find(item => item.relativePath === 'result.md')!;
    expect(artifact.metadata).toMatchObject({ immutable: true, criterionRequested: true, carriedFromWorkspace: true });
    expect(artifact.taskId).toBe(task.id);
    expect(artifact.executionId).toBe(execution.id);
    expect(readArtifactSnapshot(artifact)?.toString()).toBe('Existing implementation');
    expect((await verifyCompletionCriteria(task, execution.id, 'Validated')).status).toBe('passed');
    writeFileSync(join(root, 'result.md'), 'Later changes');
    expect(readArtifactSnapshot(artifact)?.toString()).toBe('Existing implementation');
    expect(listExecutionArtifacts({ executionId: execution.id }).some(item => item.relativePath === 'unrelated.md')).toBe(false);
  });

  it('uses persisted criteria rather than runtime replacements and keeps missing files failed', async () => {
    const { task, execution } = persistedFixture(root, 'missing.md');
    writeFileSync(join(root, 'replacement.md'), 'Not the submitted artifact');
    indexExecutionArtifacts({ task: { ...task, completionCriteria: [{ id: 'fake', label: 'Fake',
      required: true, verifier: 'artifact', relativePath: 'replacement.md' }] }, executionId: execution.id,
    output: 'Claimed done', startedAtMs: Date.now(), baseline: captureArtifactBaseline(root) });
    expect(listExecutionArtifacts({ executionId: execution.id }).map(item => item.relativePath)).toEqual(['__result__.md']);
    expect((await verifyCompletionCriteria(task, execution.id, 'Claimed done')).status).toBe('failed');
  });

  it.each(['.env', '../outside.md'])('does not bypass excluded/escaping paths requested by a persisted contract: %s', path => {
    writeFileSync(join(root, '.env'), 'sensitive');
    const { task, execution } = persistedFixture(root, path);
    indexExecutionArtifacts({ task, executionId: execution.id, output: 'Checked',
      startedAtMs: Date.now(), baseline: captureArtifactBaseline(root) });
    expect(listExecutionArtifacts({ executionId: execution.id }).map(item => item.relativePath)).toEqual(['__result__.md']);
  });

  it('refuses unchanged required symlinks instead of snapshotting their targets', () => {
    writeFileSync(join(root, 'target.md'), 'Hidden behind a symlink');
    symlinkSync('target.md', join(root, 'result.md'));
    const { task, execution } = persistedFixture(root);
    expect(() => indexExecutionArtifacts({ task, executionId: execution.id, output: 'Checked',
      startedAtMs: Date.now(), baseline: captureArtifactBaseline(root) })).toThrow('WORKSPACE_SYMLINK_DENIED');
    expect(listExecutionArtifacts({ executionId: execution.id }).some(item => item.relativePath === 'result.md')).toBe(false);
  });

  it('refuses a runtime workspace/root replacement and mismatched execution before capturing any evidence', () => {
    const { task, execution } = persistedFixture(root);
    const otherRoot = mkdtempSync(join(tmpdir(), 'myrmecia-artifact-other-'));
    for (const supplied of [{ ...task, workdir: otherRoot }, { ...task, workspaceId: 'other' }]) {
      expect(() => indexExecutionArtifacts({ task: supplied, executionId: execution.id, output: 'Forged',
        startedAtMs: Date.now() })).toThrow('ARTIFACT_CAPTURE_SCOPE_DENIED');
    }
    const other = persistedFixture(otherRoot);
    expect(() => indexExecutionArtifacts({ task, executionId: other.execution.id, output: 'Forged',
      startedAtMs: Date.now() })).toThrow('ARTIFACT_CAPTURE_SCOPE_DENIED');
    expect(listExecutionArtifacts({ executionId: execution.id })).toEqual([]);
    expect(listExecutionArtifacts({ executionId: other.execution.id })).toEqual([]);
  });

  it('does not capture unchanged files when only the runtime task provides a root or the execution is unregistered', () => {
    writeFileSync(join(root, 'result.md'), 'Preexisting file');
    const baseline = captureArtifactBaseline(root);
    const task = createTask({ title: 'No submitted directory', description: '', input: 'Validate',
      mode: 'direct', workspaceId: 'workspace-a', completionCriteria: [
        { id: 'file', label: 'File', required: true, verifier: 'artifact', relativePath: 'result.md' }] });
    const execution = createExecution({ taskId: task.id, agentDefId: 'fixture', workspaceId: 'workspace-a' });
    indexExecutionArtifacts({ task: { ...task, workdir: root }, executionId: execution.id,
      output: 'Claimed done', startedAtMs: Date.now(), baseline });
    const registered = persistedFixture(root);
    indexExecutionArtifacts({ task: registered.task, executionId: 'unregistered-execution',
      output: 'Claimed done', startedAtMs: Date.now(), baseline });
    for (const executionId of [execution.id, 'unregistered-execution']) {
      expect(listExecutionArtifacts({ executionId }).map(item => item.relativePath)).toEqual(['__result__.md']);
    }
  });
});
