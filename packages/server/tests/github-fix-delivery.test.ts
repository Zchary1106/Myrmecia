import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../src/db/database.js';
import { createTask, updateTask } from '../src/db/models/task.js';
import { createExecution, updateExecution } from '../src/db/models/execution.js';
import { initialAgentRunState } from '../src/agents/run-state.js';
import { createGitHubFixRun, getGitHubFixRun } from '../src/db/models/github-fix.js';
import { GitHubFixDelivery, type GitHubCommandRunner } from '../src/github/github-fix-delivery.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import * as completion from '../src/agents/completion-gate.js';
const exec = promisify(execFile);
const roots: string[] = [];
const local: GitHubCommandRunner = async (command, args, cwd) =>
  (await exec(command, args, { cwd, encoding: 'utf8', maxBuffer: 2_000_000 })).stdout.trim();
beforeEach(() => { vi.stubEnv('DB_PATH', ':memory:'); vi.stubEnv('MYRMECIA_RUNTIME_V2', 'false'); vi.stubEnv('SANDBOX_PROFILE', 'standard'); });
afterEach(() => { closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(failingTests = false, persistent = false) {
  const root = mkdtempSync(join(tmpdir(), 'myrmecia-github-delivery-')); roots.push(root);
  if (persistent) {
    mkdirSync(join(root, '.agent-factory')); vi.stubEnv('DB_PATH', join(root, '.agent-factory', 'delivery.sqlite'));
  }
  vi.stubEnv('MYRMECIA_WORKSPACE_ROOT', root);
  const git = (...args: string[]) => local('git', args, root);
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.test');
  await git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test check.test.mjs' } }));
  writeFileSync(join(root, 'check.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict';
test('real fixture check', () => assert.equal(${!failingTests}, true));\n`);
  writeFileSync(join(root, 'old.js'), 'export const value = 1;\n');
  await git('add', 'package.json', 'check.test.mjs', 'old.js'); await git('commit', '-m', 'baseline');
  const baseHead = await git('rev-parse', 'HEAD'); await git('switch', '-c', 'codex/fix-fixture');
  writeFileSync(join(root, 'old.js'), 'export const value = 2;\n');
  writeFileSync(join(root, 'new.py'), 'print("newly reviewed code")\n');
  const task = createTask({ title: 'Fix fixture', description: '', input: 'Fix fixture', mode: 'master', workspaceId: 'w', workdir: root });
  updateTask(task.id, { status: 'done', output: 'Implemented fixture' });
  const fix = createGitHubFixRun({ id: `ghfix_${task.id}`, workspaceId: 'w', repository: 'example/repo',
    repositoryUrl: 'https://github.com/example/repo', baseBranch: 'main', workBranch: 'codex/fix-fixture',
    localPath: root, viewerPermission: 'WRITE', status: 'running', taskId: task.id });
  const remote = vi.fn<GitHubCommandRunner>(async (command, args, cwd) => {
    if (command === 'git' && args.includes('push')) return 'pushed fixture (no network)';
    if (command === 'gh') return 'https://github.com/example/repo/pull/123';
    return local(command, args, cwd);
  });
  const delivery = new GitHubFixDelivery(remote);
  const diff = await delivery.diff(fix);
  const review = { diffHash: diff.diffHash, files: diff.files.map(file => file.path) };
  return { root, task, fix, delivery, diff, review, remote, git, baseHead };
}
describe('reviewed GitHub delivery', () => {
  it('previews untracked new-file content and never infers validation from task done', async () => {
    const f = await fixture();
    expect(f.diff.patch).toContain('newly reviewed code');
    expect(f.diff.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'new.py', change: 'added' })]));
    expect(f.diff.validation).toBeUndefined();
    await expect(f.delivery.publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture')).rejects.toThrow('GITHUB_VERIFICATION_REQUIRED');
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.baseHead);
  });
  it.each([false, true])('runs a real bounded command without double-locking (V2=%s)', async v2 => {
    const f = await fixture(); vi.stubEnv('MYRMECIA_RUNTIME_V2', String(v2));
    const result = await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    expect(result.validation).toMatchObject({ status: 'passed', command: 'npm test', diffHash: f.diff.diffHash });
    expect(result.validation?.outputArtifactId).toBeTruthy();
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.baseHead);
    expect(f.remote.mock.calls.some(([command, args]) => command === 'gh' || args.includes('push'))).toBe(false);
  });
  it('blocks failed test evidence and does not commit', async () => {
    const f = await fixture(true);
    const result = await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    expect(result.validation?.status).toBe('failed');
    await expect(f.delivery.publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture')).rejects.toThrow('GITHUB_VERIFICATION_REQUIRED');
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.baseHead);
  });
  it('rejects stale reviews, incomplete file lists and unaccepted delivery', async () => {
    const f = await fixture();
    await expect(f.delivery.verify(f.fix, { ...f.review, files: ['old.js'], command: 'npm test' }, 'operator')).rejects.toThrow('SCOPE_MISMATCH');
    await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    await expect(f.delivery.publish(f.fix, { ...f.review, acceptDelivery: false as true }, 'operator', 'fixture')).rejects.toThrow('ACCEPTANCE_REQUIRED');
    writeFileSync(join(f.root, 'new.py'), 'print("changed after review")\n');
    await expect(f.delivery.publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture')).rejects.toThrow('REVIEW_STALE');
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.baseHead);
  });
  it('publishes only the exact reviewed paths, truthful test evidence and an idempotent receipt', async () => {
    const f = await fixture(); await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    const result = await f.delivery.publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture');
    expect(result.status).toBe('pr_created');
    const stage = f.remote.mock.calls.find(([command, args]) => command === 'git' && args.includes('add'))!;
    expect(stage[1]).toEqual(['--literal-pathspecs', 'add', '--', 'new.py', 'old.js']);
    const pr = f.remote.mock.calls.find(([command]) => command === 'gh')!;
    expect(pr[1].join(' ')).toContain('Retained verifier execution');
    expect(pr[1].join(' ')).not.toContain('Adds or updates regression coverage.');
    await f.delivery.publish(getGitHubFixRun(f.fix.id)!, { ...f.review, acceptDelivery: true }, 'operator', 'fixture');
    expect(f.remote.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(1);
  });
  it('retains a committed/unknown push receipt instead of committing or publishing again', async () => {
    const f = await fixture(); await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    const run = new GitHubFixDelivery(async (command, args, cwd) => {
      if (command === 'git' && args.includes('push')) throw new Error('Synthetic lost push response');
      return f.remote(command, args, cwd);
    });
    await expect(run.publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture')).rejects.toThrow('lost push');
    const committed = await f.git('rev-parse', 'HEAD');
    expect(committed).not.toBe(f.baseHead);
    expect(getDb().get<any>('SELECT state FROM github_fix_deliveries WHERE run_id=?', f.fix.id).state).toBe('uncertain');
    await expect(run.publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture')).rejects.toThrow('VERIFICATION_REQUIRED');
    expect(await f.git('rev-parse', 'HEAD')).toBe(committed);
    const receipt = getDb().get<any>('SELECT operation_id,state FROM github_fix_deliveries WHERE run_id=?', f.fix.id);
    const recovering = new GitHubFixDelivery(async (command, args, cwd) => {
      if (command === 'git' && args[0] === 'ls-remote') return `${committed}\trefs/heads/${f.fix.workBranch}`;
      return f.remote(command, args, cwd);
    });
    const recovered = await recovering.reconcile(f.fix, { operationId: receipt.operation_id, expectedState: receipt.state, effectsStopped: true });
    expect(recovered.publicationState).toBe('pushed');
    expect(recovered.diffHash).toBe(f.review.diffHash);
    await recovering.publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture');
    expect(f.remote.mock.calls.filter(([command, args]) => command === 'git' && args.includes('commit'))).toHaveLength(1);
    expect(f.remote.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(1);
  });
  it('omits secret/symlink content and blocks a preview that is not complete', async () => {
    const f = await fixture();
    writeFileSync(join(f.root, '.env'), 'PRIVATE_SECRET_FOR_FIXTURE');
    symlinkSync('/etc/passwd', join(f.root, 'outside.py'));
    const diff = await f.delivery.diff(f.fix);
    expect(diff.blockers.length).toBeGreaterThan(0);
    expect(diff.patch).not.toContain('PRIVATE_SECRET_FOR_FIXTURE');
    expect(diff.patch).not.toContain('root:');
    await expect(f.delivery.verify(f.fix, { diffHash: diff.diffHash, files: diff.files.map(file => file.path), command: 'npm test' }, 'operator')).rejects.toThrow('REVIEW_BLOCKED');
  });
  it('does not auto-dispatch an operator verifier to a model after restart', async () => {
    const f = await fixture(); const result = await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    const verifierTask = getDb().get<any>('SELECT task_id FROM task_executions WHERE id=?', result.validation!.executionId).task_id;
    updateTask(verifierTask, { status: 'running' });
    const manager = { findAvailableAgent: vi.fn(), isAgentAvailable: vi.fn() } as any;
    const queue = new TaskQueue(manager);
    try {
      await queue.recoverRunningTasks();
      expect(manager.findAvailableAgent).not.toHaveBeenCalled();
      await expect(queue.dispatchExisting(verifierTask)).rejects.toThrow('OPERATOR_VERIFIER_ONLY');
    } finally { await queue.shutdown(); }
  });
  it('requires stopped-effect attestation and leaves failed verifier history unknown', async () => {
    const f = await fixture(true);
    const result = await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    expect(result.publicationState).toBe('uncertain');
    await expect(f.delivery.reconcile(f.fix, { operationId: result.reconciliationKey!, expectedState: 'uncertain',
      effectsStopped: false as true })).rejects.toThrow('ATTESTATION_REQUIRED');
    const reconciled = await f.delivery.reconcile(f.fix, { operationId: result.reconciliationKey!, expectedState: 'uncertain', effectsStopped: true });
    expect(reconciled.publicationState).toBe('review_required');
    expect(getDb().get<any>("SELECT outcome FROM agent_tool_invocations WHERE execution_id=?", result.validation!.executionId).outcome).toBe('unknown');
    expect(getDb().all("SELECT id FROM workspace_leases WHERE state<>'released'")).toHaveLength(0);
  });
  it('refuses to commit when repository write permission has not been granted', async () => {
    const f = await fixture(); await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    await expect(f.delivery.publish({ ...f.fix, viewerPermission: 'READ' }, { ...f.review, acceptDelivery: true }, 'operator', 'fixture'))
      .rejects.toThrow('WRITE_PERMISSION_REQUIRED');
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.baseHead);
  });
  it('retains publication identity across database reopen without repeating a remote write', async () => {
    const f = await fixture(false, true);
    await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    await f.delivery.publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture');
    closeDb();
    const result = await new GitHubFixDelivery(f.remote).publish(getGitHubFixRun(f.fix.id)!,
      { ...f.review, acceptDelivery: true }, 'operator', 'fixture');
    expect(result.status).toBe('pr_created');
    expect(f.remote.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(1);
  });
  it('never promotes a cancelled verification to success when a late receipt arrives', async () => {
    const f = await fixture();
    let entered!: () => void, settle!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { settle = resolve; });
    let signal: AbortSignal | undefined;
    vi.spyOn(completion, 'verifyCompletionCriteria').mockImplementation(async (_task, _execution, _output, value) => {
      signal = value; entered(); await pending;
      return { schemaVersion: 1, status: 'passed', contractSha256: 'fixture', checkedAt: '', criteria: [] };
    });
    const operation = f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    await started; f.delivery.cancelVerification(f.fix);
    expect(signal?.aborted).toBe(true); settle();
    const result = await operation;
    expect(result.validation?.status).not.toBe('passed');
    const task = getDb().get<any>('SELECT t.status FROM tasks t JOIN task_executions e ON e.task_id=t.id WHERE e.id=?', result.validation!.executionId);
    expect(task.status).toBe('cancelled');
  });
  it('rejects a changed push URL before committing reviewed source', async () => {
    const f = await fixture(); await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    await f.git('remote', 'set-url', '--push', 'origin', 'https://github.com/other/unreviewed.git');
    await expect(f.delivery.publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture')).rejects.toThrow('REMOTE_TARGET_CHANGED');
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.baseHead);
  });
  it('preserves the fork workflow only with explicit approval and a verified upstream parent', async () => {
    const f = await fixture(); await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    const delivery = new GitHubFixDelivery(async (command, args, cwd) => {
      if (command === 'gh' && args[0] === 'repo' && args[1] === 'view') return JSON.stringify({
        nameWithOwner: 'fixture/repo', isFork: true, parent: { nameWithOwner: 'example/repo' },
      });
      return f.remote(command, args, cwd);
    });
    const result = await delivery.publish({ ...f.fix, viewerPermission: 'READ' },
      { ...f.review, acceptDelivery: true, allowFork: true }, 'operator', 'fixture');
    expect(result.status).toBe('pr_created'); expect(result.forkRepository).toBe('fixture/repo');
    expect(await f.git('remote', 'get-url', 'fork')).toBe('https://github.com/fixture/repo.git');
    const push = f.remote.mock.calls.find(([command, args]) => command === 'git' && args.includes('push'))!;
    expect(push[1]).toContain('fork');
    expect(f.remote.mock.calls.find(([command]) => command === 'gh')![1]).toContain(`fixture:${f.fix.workBranch}`);
  });
  it('does not overwrite an unrelated checkout fork remote or commit without a matching parent', async () => {
    const f = await fixture(); await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    await f.git('remote', 'add', 'fork', 'https://github.com/other/repo.git');
    const delivery = new GitHubFixDelivery(async (command, args, cwd) => {
      if (command === 'gh' && args[0] === 'repo') return JSON.stringify({
        nameWithOwner: 'fixture/repo', isFork: true, parent: { nameWithOwner: 'example/repo' },
      });
      return f.remote(command, args, cwd);
    });
    await expect(delivery.publish({ ...f.fix, viewerPermission: 'READ' },
      { ...f.review, acceptDelivery: true, allowFork: true }, 'operator', 'fixture')).rejects.toThrow('FORK_REMOTE_MISMATCH');
    expect(await f.git('remote', 'get-url', 'fork')).toBe('https://github.com/other/repo.git');
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.baseHead);
  });
  it('checks root and nested teammate evidence instead of accepting only task status', async () => {
    const f = await fixture();
    const rootExecution = createExecution({ taskId: f.task.id, agentDefId: 'fixture', workspaceId: 'w' });
    updateExecution(rootExecution.id, { status: 'done', runState: { ...initialAgentRunState(), acceptance: 'rejected' } });
    await expect(f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator')).rejects.toThrow('TASK_EVIDENCE_BLOCKED');
    updateExecution(rootExecution.id, { status: 'done', runState: { ...initialAgentRunState(), acceptance: 'accepted' } });
    const child = createTask({ title: 'Child', input: '', description: '', mode: 'direct', workspaceId: 'w', parentTaskId: f.task.id });
    updateTask(child.id, { status: 'done' });
    const nested = createTask({ title: 'Nested', input: '', description: '', mode: 'direct', workspaceId: 'w', parentTaskId: child.id });
    const before = await f.delivery.diff(f.fix);
    await expect(f.delivery.verify(f.fix, { diffHash: before.diffHash, files: f.review.files, command: 'npm test' }, 'operator'))
      .rejects.toThrow('TASK_EVIDENCE_BLOCKED');
    updateTask(nested.id, { status: 'done', output: 'Nested task completed' });
    expect((await f.delivery.diff(f.fix)).diffHash).not.toBe(before.diffHash);
  });
  it('seals an interrupted commit after persisting its recoverable receipt', async () => {
    const f = await fixture(); await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    const delivery = new GitHubFixDelivery(async (command, args, cwd) => {
      const result = await f.remote(command, args, cwd);
      if (command === 'git' && args.includes('commit')) throw new Error('Commit response lost');
      return result;
    });
    await expect(delivery.publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture')).rejects.toThrow('Commit response lost');
    const row = getDb().get<any>('SELECT * FROM github_fix_deliveries WHERE run_id=?', f.fix.id);
    expect(row.state).toBe('uncertain');
    expect(JSON.parse(row.data_json).publication.uncertainStage).toBe('committing');
    expect(getDb().all("SELECT id FROM workspace_leases WHERE state='uncertain'")).toHaveLength(1);
    const recovered = await new GitHubFixDelivery(f.remote).reconcile(f.fix, {
      operationId: row.operation_id, expectedState: 'uncertain', effectsStopped: true,
    });
    expect(recovered.publicationState).toBe('committed');
    expect(recovered.diffHash).toBe(f.review.diffHash);
    expect(getDb().all("SELECT id FROM workspace_leases WHERE state<>'released'")).toHaveLength(0);
    await new GitHubFixDelivery(f.remote).publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture');
    expect(f.remote.mock.calls.filter(([command, args]) => command === 'git' && args.includes('commit'))).toHaveLength(1);
  });
  it('rejects a fork with the wrong upstream parent without changing the checkout', async () => {
    const f = await fixture(); await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    const delivery = new GitHubFixDelivery(async (command, args, cwd) => {
      if (command === 'gh' && args[0] === 'repo') return JSON.stringify({
        nameWithOwner: 'fixture/repo', isFork: true, parent: { nameWithOwner: 'other/repo' },
      });
      return f.remote(command, args, cwd);
    });
    await expect(delivery.publish({ ...f.fix, viewerPermission: 'READ' },
      { ...f.review, acceptDelivery: true, allowFork: true }, 'operator', 'fixture')).rejects.toThrow('FORK_PARENT_MISMATCH');
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.baseHead);
    expect(await f.git('remote')).toBe('origin');
  });
  it('reconciles a lost PR response without creating a duplicate PR', async () => {
    const f = await fixture(); await f.delivery.verify(f.fix, { ...f.review, command: 'npm test' }, 'operator');
    const delivery = new GitHubFixDelivery(async (command, args, cwd) => {
      if (command === 'gh') {
        await f.remote(command, args, cwd);
        throw new Error('PR response lost');
      }
      return f.remote(command, args, cwd);
    });
    await expect(delivery.publish(f.fix, { ...f.review, acceptDelivery: true }, 'operator', 'fixture')).rejects.toThrow('PR response lost');
    const row = getDb().get<any>('SELECT * FROM github_fix_deliveries WHERE run_id=?', f.fix.id);
    const data = JSON.parse(row.data_json);
    const recovering = new GitHubFixDelivery(async (command, args, cwd) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{
        url: 'https://github.com/example/repo/pull/123', headRefOid: data.publication.commitHash,
        headRepositoryOwner: { login: 'example' },
      }]);
      return f.remote(command, args, cwd);
    });
    const result = await recovering.reconcile(f.fix, { operationId: row.operation_id, expectedState: 'uncertain', effectsStopped: true });
    expect(result.publicationState).toBe('pr_created');
    await recovering.publish(getGitHubFixRun(f.fix.id)!, { ...f.review, acceptDelivery: true }, 'operator', 'fixture');
    expect(f.remote.mock.calls.filter(([command, args]) => command === 'gh' && args[1] === 'create')).toHaveLength(1);
  });
});
