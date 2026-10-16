import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { closeDb, getDb } from '../src/db/database.js';
import { createTask, getTask, updateTask } from '../src/db/models/task.js';
import { grantTaskTestAuthorization, taskTestAuthorization, revokeTaskTestAuthorization, runAuthorizedTaskTest, runAuthorizedDevelopmentTest } from '../src/testing/task-test-authorization.js';
import { withWorkspaceLease } from '../src/workspace/workspace-lease.js';
import { createTaskRoutes } from '../src/routes/tasks.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import type { AgentManager } from '../src/agents/agent-manager.js';
import type { OperatorActor } from '../src/types.js';

const actor: OperatorActor = { id: 'scoped-operator', role: 'operator', source: 'local' };
let root: string;
function fixture(script = 'node --test check.test.mjs', workspaceId = 'default') {
  root = mkdtempSync(join(tmpdir(), 'myrmecia-scoped-qa-test-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { test: script } }));
  writeFileSync(join(root, 'check.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict';
test('fixture and credential boundary',()=>assert.equal(process.env.AGENT_FACTORY_API_KEY,undefined));`);
  return createTask({ title: 'Scoped feature', description: 'fixture', input: 'fixture', mode: 'direct',
    workspaceId, workdir: root, workspacePath: root });
}
beforeEach(() => { closeDb(); vi.stubEnv('DB_PATH', ':memory:'); vi.stubEnv('REDIS_URL', ''); vi.stubEnv('REDIS_HOST', ''); });
afterEach(() => { closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('operator-authorized fixed task tests', () => {
  it('denies model-like role or arbitrary command without storing a grant', () => {
    const task = fixture();
    expect(() => grantTaskTestAuthorization(task, { ...actor, role: 'viewer' }, 'npm test')).toThrow('ROLE_DENIED');
    for (const command of ['npm test; echo ok', 'npm run deploy', 'npm test -- --watch', ' npm test']) {
      expect(() => grantTaskTestAuthorization(task, actor, command)).toThrow('COMMAND_DENIED');
    }
    expect(getDb().all('SELECT * FROM task_test_authorizations')).toHaveLength(0);
  });
  it('inherits only within the same session/workspace/directory and package fingerprint', () => {
    const task = fixture();
    const grant = grantTaskTestAuthorization(task, actor, 'npm test');
    const child = createTask({ title: 'Follow-up', description: 'fixture', input: 'fixture', mode: 'direct',
      workspaceId: 'default', parentTaskId: task.id, workdir: root, workspacePath: root });
    expect(taskTestAuthorization(child)?.id).toBe(grant.id);
    const other = createTask({ title: 'Other', description: 'fixture', input: 'fixture', mode: 'direct',
      workdir: root, workspacePath: root });
    expect(taskTestAuthorization(other)).toBeUndefined();
    const foreign = createTask({ title: 'Other tenant', description: 'fixture', input: 'fixture', mode: 'direct',
      workspaceId: 'other', parentTaskId: task.id, workdir: root, workspacePath: root });
    expect(() => taskTestAuthorization(foreign)).toThrow('INVALID_SESSION');
    const path = mkdtempSync(join(tmpdir(), 'myrmecia-scoped-qa-other-'));
    writeFileSync(join(path, 'package.json'), '{"scripts":{"test":"node --test"}}');
    updateTask(child.id, { workdir: path, workspacePath: path });
    expect(() => taskTestAuthorization(getTask(child.id)!)).toThrow('SCOPE_CHANGED');
    writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"echo changed"}}');
    expect(() => taskTestAuthorization(task)).toThrow('SCOPE_CHANGED');
  });
  it('expires and revokes without rewriting history or granting generic tools', () => {
    const task = fixture();
    grantTaskTestAuthorization(task, actor, 'npm test', Date.now() - 31 * 60_000);
    expect(taskTestAuthorization(task)).toBeUndefined();
    grantTaskTestAuthorization(task, actor, 'npm test');
    revokeTaskTestAuthorization(task, actor);
    expect(taskTestAuthorization(task)).toBeUndefined();
    expect(getDb().all('SELECT * FROM task_test_authorizations')).toHaveLength(2);
    expect(getDb().all('SELECT * FROM tool_permissions')).toHaveLength(0);
  });
  it('runs real tests without provider credentials and stores a real receipt', async () => {
    vi.stubEnv('AGENT_FACTORY_API_KEY', 'fixture-credential');
    const task = fixture();
    grantTaskTestAuthorization(task, actor, 'npm test');
    const result = await runAuthorizedTaskTest(task);
    expect(result).toMatchObject({ command: 'npm test', cwd: realpathSync(root), exitCode: 0 });
    expect(result.stdout).toContain('fixture and credential boundary');
    expect(getDb().get('SELECT status,exit_code FROM task_test_receipts WHERE id=?', result.receiptId))
      .toEqual({ status: 'passed', exit_code: 0 });
  });
  it('does not mark a zero-test exit 0 as successful verification', async () => {
    const task = fixture('node --test empty/*.test.mjs');
    grantTaskTestAuthorization(task, actor, 'npm test');
    const result = await runAuthorizedTaskTest(task);
    expect(result.exitCode).toBe(0); // Preserve the real process exit.
    expect(result.stdout).toMatch(/tests 0/);
    expect(getDb().get('SELECT status,exit_code FROM task_test_receipts WHERE id=?', result.receiptId))
      .toEqual({ status: 'unavailable', exit_code: 0 });
  });
  it('reuses only the exact active writer lease for in-execution tests', async () => {
    const task = fixture();
    grantTaskTestAuthorization(task, actor, 'npm test');
    const options = { signal: new AbortController().signal, deadline: Date.now() + 10_000 };
    await expect(runAuthorizedDevelopmentTest(task, options)).rejects.toThrow('LEASE_REQUIRED');
    await withWorkspaceLease(task, async () => {
      const other = createTask({ title: 'Wrong owner', input: 'fixture', description: '', mode: 'direct', workdir: root, workspacePath: root });
      // Even an otherwise-valid task must not borrow this owner's lease.
      getDb().run('UPDATE task_test_authorizations SET root_task_id=?', other.id);
      await expect(runAuthorizedDevelopmentTest(other, options)).rejects.toThrow('LEASE_REQUIRED');
      getDb().run('UPDATE task_test_authorizations SET root_task_id=?', task.id);
      const result = await runAuthorizedDevelopmentTest(task, options);
      expect(result.exitCode).toBe(0);
      expect(getDb().all("SELECT * FROM workspace_leases WHERE state='active'")).toHaveLength(1);
    });
    expect(getDb().all("SELECT * FROM workspace_leases WHERE state<>'released'")).toHaveLength(0);
  });
  it('does not start an in-execution test after cancellation or its shared deadline', async () => {
    const task = fixture();
    grantTaskTestAuthorization(task, actor, 'npm test');
    await withWorkspaceLease(task, async () => {
      const cancelled = new AbortController(); cancelled.abort();
      await expect(runAuthorizedDevelopmentTest(task, { signal: cancelled.signal, deadline: Date.now() + 1000 })).rejects.toThrow('CANCELLED_OR_DEADLINE');
      await expect(runAuthorizedDevelopmentTest(task, { signal: new AbortController().signal, deadline: Date.now() - 1 })).rejects.toThrow('CANCELLED_OR_DEADLINE');
    });
    expect(getDb().all('SELECT * FROM task_test_receipts')).toHaveLength(0);
  });
  it('cancels an active verifier conservatively and never records a pass', async () => {
    const task = fixture('node -e "setTimeout(()=>console.log(\'1 passed\'),250)"');
    grantTaskTestAuthorization(task, actor, 'npm test');
    const controller = new AbortController();
    await withWorkspaceLease(task, async () => {
      const running = runAuthorizedDevelopmentTest(task, { signal: controller.signal, deadline: Date.now() + 2000 });
      // runOwnedTaskTest synchronously inserts its receipt before yielding to execFile.
      expect(getDb().all("SELECT * FROM task_test_receipts WHERE status='running'")).toHaveLength(1);
      controller.abort();
      await expect(running).rejects.toThrow('TEST_AUTH_REVOKED_OR_EXPIRED');
    });
    expect(getDb().all("SELECT * FROM task_test_receipts WHERE status='passed'")).toHaveLength(0);
    expect(getDb().all("SELECT * FROM task_test_receipts WHERE status='unavailable'")).toHaveLength(1);
    expect(getDb().all("SELECT * FROM workspace_leases WHERE state='uncertain'")).toHaveLength(1);
  });
  it('records failure rather than converting a nonzero exit into successful QA', async () => {
    const task = fixture('node -e "process.exit(3)"');
    grantTaskTestAuthorization(task, actor, 'npm test');
    const result = await runAuthorizedTaskTest(task);
    expect(result.exitCode).toBe(3);
    expect(getDb().get('SELECT status,exit_code FROM task_test_receipts WHERE id=?', result.receiptId))
      .toEqual({ status: 'failed', exit_code: 3 });
  });
  it('requires tenant access, an operator and explicit confirmation on the API', async () => {
    const task = fixture();
    const queue = new TaskQueue({ hasCapacity: () => false } as unknown as AgentManager);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).authContext = { userId: 'scoped-user', scopes: ['tasks:write'], workspaceId: req.header('x-test-workspace') || 'default' };
      next();
    });
    app.use('/tasks', createTaskRoutes(queue));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const send = (body: object, role = 'operator', workspace = 'default') => fetch(`http://127.0.0.1:${port}/tasks/${task.id}/test-authorization`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-operator-role': role, 'x-test-workspace': workspace },
      body: JSON.stringify(body),
    });
    try {
      expect((await send({ command: 'npm test' })).status).toBe(409);
      expect((await send({ command: 'npm test', confirm: true }, 'viewer')).status).toBe(403);
      expect((await send({ command: 'npm test', confirm: true }, 'operator', 'other')).status).toBe(404);
      expect((await send({ command: 'npm run deploy', confirm: true })).status).toBe(400);
      expect((await send({ command: 'npm test', confirm: true })).status).toBe(201);
    } finally { await queue.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
