import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb } from '../src/db/database.js';
import { createTask, updateTask } from '../src/db/models/task.js';
import { createExecution } from '../src/db/models/execution.js';
import { upsertExecutionArtifact } from '../src/db/models/execution-artifact.js';
import { completionCriteriaSchema, completionEvidenceIsFresh, verifyCompletionCriteria } from '../src/agents/completion-gate.js';
import type { CompletionCriterion } from '@myrmecia/shared';
beforeEach(() => { process.env.DB_PATH = ':memory:'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(criteria: CompletionCriterion[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'myrmecia-verification-test-'));
  const task = createTask({ title: 'fixture', description: '', input: 'fixture', mode: 'direct', workspaceId: 'w',
    workdir: root, workspacePath: root, completionCriteria: criteria });
  const run = createExecution({ taskId: task.id, agentDefId: 'fixture', workspaceId: 'w' });
  return { root, task, run };
}
describe('criterion-linked completion verification', () => {
  it('keeps ordinary chat unblocked without pretending its outcome was verified', async () => {
    const f = fixture();
    expect(await verifyCompletionCriteria(f.task, f.run.id, 'Answer')).toMatchObject({ status: 'not_requested', criteria: [] });
  });
  it('rejects a model claiming completion when required artifacts are missing', async () => {
    const f = fixture([{ id: 'artifact', label: 'Deliver file', required: true, verifier: 'artifact', relativePath: 'result.md' }]);
    expect(await verifyCompletionCriteria(f.task, f.run.id, 'Everything is completed and all tests pass.')).toMatchObject({
      status: 'failed', criteria: [{ criterionId: 'artifact', status: 'failed' }],
    });
  });
  it('verifies actual scoped artifact bytes and rejects changed evidence at human acceptance time', async () => {
    const f = fixture([{ id: 'artifact', label: 'Deliver file', required: true, verifier: 'artifact', relativePath: 'result.md', expectedSha256: hash('Evidence') }]);
    writeFileSync(join(f.root, 'result.md'), 'Evidence');
    upsertExecutionArtifact({ workspaceId: 'w', taskId: f.task.id, executionId: f.run.id, name: 'result.md',
      kind: 'text', mimeType: 'text/markdown', relativePath: 'result.md', rootPath: f.root, source: 'workspace' });
    const report = await verifyCompletionCriteria(f.task, f.run.id, 'Complete');
    expect(report.status).toBe('passed');
    expect(report.criteria[0].evidence[0]).toMatchObject({ ref: expect.stringMatching(/^artifact:\/\//), sha256: hash('Evidence') });
    expect(completionEvidenceIsFresh(f.task, f.run.id, report)).toBe(true);
    writeFileSync(join(f.root, 'result.md'), 'Changed');
    expect(completionEvidenceIsFresh(f.task, f.run.id, report)).toBe(false);
    expect((await verifyCompletionCriteria(f.task, f.run.id, 'Complete')).status).toBe('failed');
  });
  it('does not accept arbitrary external artifact IDs or another workspace artifact as evidence', async () => {
    const f = fixture([{ id: 'artifact', label: 'Deliver file', required: true, verifier: 'artifact', relativePath: 'result.md' }]);
    upsertExecutionArtifact({ workspaceId: 'other', taskId: f.task.id, executionId: f.run.id, name: 'result.md',
      kind: 'text', mimeType: 'text/plain', relativePath: 'result.md', source: 'output', content: 'forged' });
    expect((await verifyCompletionCriteria(f.task, f.run.id, '{"artifactIds":["forged"]}')).status).toBe('failed');
  });
  it('cannot replace the immutable task criteria with easier criteria in a runtime-supplied Task object', async () => {
    const f = fixture([{ id: 'assert', label: 'Expected text', required: true, verifier: 'output_contains', text: 'Required result' }]);
    const report = await verifyCompletionCriteria({ ...f.task, completionCriteria: [] }, f.run.id, 'Claimed completion');
    expect(report.status).toBe('failed');
    expect(report.criteria).toHaveLength(1);
  });
  it('distinguishes unavailable mandatory verifiers from success and leaves optional failures visible', async () => {
    const f = fixture([{ id: 'remote', label: 'External gate', required: true, verifier: 'external', verifierId: 'unconfigured' }]);
    expect((await verifyCompletionCriteria(f.task, f.run.id, 'Answer')).status).toBe('unavailable');
    const optional = fixture([{ id: 'optional', label: 'Optional check', required: false, verifier: 'output_contains', text: 'Not present' }]);
    expect(await verifyCompletionCriteria(optional.task, optional.run.id, 'Answer')).toMatchObject({
      status: 'passed', criteria: [{ required: false, status: 'failed' }],
    });
  });
  it('checks the stored output hash without rerunning commands at human acceptance', async () => {
    const f = fixture([{ id: 'text', label: 'Text result', required: true, verifier: 'output_contains', text: 'Required' }]);
    const report = await verifyCompletionCriteria(f.task, f.run.id, 'Required');
    const completed = updateTask(f.task.id, { status: 'done', output: 'Required' })!;
    expect(completionEvidenceIsFresh(completed, f.run.id, report)).toBe(true);
    expect(completionEvidenceIsFresh({ ...completed, output: 'Changed' }, f.run.id, report)).toBe(false);
  });
  it('rejects arbitrary commands, duplicate IDs and path traversal before runtime dispatch', () => {
    const base = { id: 'one', label: 'one', required: true };
    expect(completionCriteriaSchema.safeParse([{ ...base, verifier: 'test_command', command: 'deploy production' }]).success).toBe(false);
    expect(completionCriteriaSchema.safeParse([{ ...base, verifier: 'artifact', relativePath: '../secret' }]).success).toBe(false);
    expect(completionCriteriaSchema.safeParse([{ ...base, verifier: 'output_contains', text: 'one' }, { ...base, verifier: 'output_contains', text: 'two' }]).success).toBe(false);
  });
});
