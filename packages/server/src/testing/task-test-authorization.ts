import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../db/database.js';
import { getTask, addTaskLog } from '../db/models/task.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { canonicalRoot, readWorkspaceBytes, rootIdentity, workspaceCommandEnvironment } from '../workspace/path-policy.js';
import { assertWorkspaceToolAllowed, assertCurrentWorkspaceOwner, withWorkspaceLease, markCurrentWorkspaceLeaseUncertain } from '../workspace/workspace-lease.js';
import { getWorkspaceBinding } from '../db/models/managed-workspace.js';
import { reserveBudget, markBudgetDispatched, settleUsage } from '../agents/budget-service.js';
import { assertShellCommandAllowed } from '../skills/tool-sandbox.js';
import { loadExecutionContext } from '../agents/execution-context.js';
import type { OperatorActor, Task } from '../types.js';
import type { TestExecutionEvidence } from './test-report.js';
import { dlpCheck } from '../security/dlp.js';
import { testExecutionStatus } from '@myrmecia/shared';

const execute = promisify(execFile);
const active = new Map<string, AbortController>();
const activeScopes = new Set<string>();
export interface TaskTestAuthorization {
  id: string; workspaceId: string; rootTaskId: string; command: 'npm test'; workdir: string;
  rootIdentity: string; packageSha256: string; actorId: string; expiresAt: number; revoked: boolean;
}
function sessionRoot(task: Task): Task {
  const workspaceId = task.workspaceId || 'default';
  const visited = new Set<string>();
  while (task.parentTaskId) {
    if (visited.has(task.id)) throw new Error('TEST_AUTH_INVALID_SESSION');
    visited.add(task.id);
    const parent = getTask(task.parentTaskId);
    if (!parent || (parent.workspaceId || 'default') !== workspaceId) throw new Error('TEST_AUTH_INVALID_SESSION');
    task = parent;
  }
  return task;
}
function scope(task: Task) {
  if (getWorkspaceBinding(task.id)?.accessMode === 'shared_readonly') throw new Error('TEST_AUTH_READONLY_WORKSPACE');
  const context = loadExecutionContext(task);
  const path = task.workdir || task.workspacePath || context.workdir || context.workspacePath;
  if (!path) throw new Error('TEST_AUTH_WORKSPACE_UNAVAILABLE');
  const workdir = canonicalRoot(path);
  const bytes = readWorkspaceBytes(workdir, 'package.json', 256_000);
  const pkg = JSON.parse(bytes.toString('utf8'));
  if (typeof pkg.scripts?.test !== 'string' || !pkg.scripts.test.trim()
    || pkg.scripts.pretest || pkg.scripts.posttest) throw new Error('TEST_AUTH_SCRIPT_UNAVAILABLE: explicit test without lifecycle hooks required');
  return { workdir, rootIdentity: rootIdentity(workdir), packageSha256: createHash('sha256').update(bytes).digest('hex') };
}
function fromRow(row: any): TaskTestAuthorization {
  return { id: row.id, workspaceId: row.workspace_id, rootTaskId: row.root_task_id,
    command: row.command, workdir: row.workdir, rootIdentity: row.root_identity,
    packageSha256: row.package_sha256, actorId: row.actor_id, expiresAt: row.expires_at, revoked: Boolean(row.revoked) };
}
export function grantTaskTestAuthorization(task: Task, actor: OperatorActor, command: string, now = Date.now()): TaskTestAuthorization {
  if (!['admin', 'operator'].includes(actor.role)) throw new Error('TEST_AUTH_ROLE_DENIED');
  if (command !== 'npm test') throw new Error('TEST_AUTH_COMMAND_DENIED: only exact npm test is supported');
  const root = sessionRoot(task), bound = scope(task);
  if (activeScopes.has(`${task.workspaceId || 'default'}:${root.id}`)) throw new Error('TEST_AUTH_BUSY');
  if (scope(root).workdir !== bound.workdir) throw new Error('TEST_AUTH_WORKSPACE_MISMATCH');
  const grant: TaskTestAuthorization = { id: `ta_${randomUUID()}`, workspaceId: task.workspaceId || 'default',
    rootTaskId: root.id, command, ...bound, actorId: actor.id || 'local', expiresAt: now + 30 * 60_000, revoked: false };
  getDb().transaction(() => {
    getDb().run(`UPDATE task_test_authorizations SET revoked=1 WHERE workspace_id=? AND root_task_id=?`,
      grant.workspaceId, root.id);
    getDb().run(`INSERT INTO task_test_authorizations
      (id,workspace_id,root_task_id,command,workdir,root_identity,package_sha256,actor_id,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, grant.id, grant.workspaceId, root.id, command, bound.workdir,
    bound.rootIdentity, bound.packageSha256, grant.actorId, grant.expiresAt);
    createOperatorAction({ action: 'task.test.authorize', actor, targetType: 'task', targetId: task.id, taskId: task.id,
      metadata: { authorizationId: grant.id, command, rootTaskId: root.id, ...bound, expiresAt: grant.expiresAt } });
  });
  return grant;
}
export function taskTestAuthorization(task: Task, now = Date.now()): TaskTestAuthorization | undefined {
  const root = sessionRoot(task);
  const row = getDb().get(`SELECT * FROM task_test_authorizations
    WHERE workspace_id=? AND root_task_id=? AND revoked=0 AND expires_at>? ORDER BY created_at DESC LIMIT 1`,
  task.workspaceId || 'default', root.id, now);
  if (!row) return undefined;
  const grant = fromRow(row), bound = scope(task);
  if (grant.workdir !== bound.workdir || grant.rootIdentity !== bound.rootIdentity
    || grant.packageSha256 !== bound.packageSha256 || scope(root).workdir !== bound.workdir) {
    throw new Error('TEST_AUTH_SCOPE_CHANGED: directory or package changed; fresh operator approval required');
  }
  return grant;
}
export function revokeTaskTestAuthorization(task: Task, actor: OperatorActor): void {
  if (!['admin', 'operator'].includes(actor.role)) throw new Error('TEST_AUTH_ROLE_DENIED');
  const root = sessionRoot(task), workspaceId = task.workspaceId || 'default';
  const rows = getDb().all<{ id: string }>('SELECT id FROM task_test_authorizations WHERE workspace_id=? AND root_task_id=? AND revoked=0',
    workspaceId, root.id);
  getDb().transaction(() => {
    getDb().run('UPDATE task_test_authorizations SET revoked=1 WHERE workspace_id=? AND root_task_id=?', workspaceId, root.id);
    createOperatorAction({ action: 'task.test.revoke', actor, targetType: 'task', targetId: task.id, taskId: task.id,
      metadata: { rootTaskId: root.id } });
  });
  for (const row of rows) active.get(row.id)?.abort();
}
export async function runAuthorizedTaskTest(task: Task): Promise<TestExecutionEvidence & { receiptId: string }> {
  // task:done listeners fire before the developer lease's finally block.
  // Yield once, then claim a separate verifier lease; never borrow or steal it.
  await new Promise<void>(resolve => setImmediate(resolve));
  return withWorkspaceLease(task, () => runOwnedTaskTest(task));
}
/** Same pinned authorization, but no second lease acquisition inside a live development execution. */
export async function runAuthorizedDevelopmentTest(task: Task, options: { signal: AbortSignal; deadline: number }): Promise<TestExecutionEvidence & { receiptId: string }> {
  const grant = taskTestAuthorization(task);
  if (!grant) throw new Error('TEST_AUTH_REQUIRED');
  assertCurrentWorkspaceOwner(task.id, grant.workdir);
  return runOwnedTaskTest(task, options);
}
async function runOwnedTaskTest(task: Task, options?: { signal: AbortSignal; deadline: number }): Promise<TestExecutionEvidence & { receiptId: string }> {
  const grant = taskTestAuthorization(task);
  if (!grant) throw new Error('TEST_AUTH_REQUIRED');
  const scopeKey = `${grant.workspaceId}:${grant.rootTaskId}`;
  if (activeScopes.has(scopeKey)) throw new Error('TEST_AUTH_BUSY');
  assertWorkspaceToolAllowed('shell_exec');
  assertShellCommandAllowed(grant.command);
  const receiptId = `tr_${randomUUID()}`, startedAt = new Date().toISOString();
  const budgetKey = `scoped-test:${receiptId}`;
  if (options?.signal.aborted || (options && Date.now() >= options.deadline)) throw new Error('TEST_RUNNER_CANCELLED_OR_DEADLINE');
  const timeoutMs = Math.max(1, Math.min(60_000, grant.expiresAt - Date.now(), options ? options.deadline - Date.now() : Infinity));
  const controller = new AbortController();
  const abort = () => controller.abort();
  options?.signal.addEventListener('abort', abort, { once: true });
  const cache = mkdtempSync(join(tmpdir(), 'myrmecia-scoped-test-'));
  // Do not pass provider/API credentials or npm user config to project tests.
  // This is host policy, not filesystem/process/network isolation.
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR, SystemRoot: process.env.SystemRoot,
    npm_config_userconfig: join(cache, 'user.npmrc'), npm_config_globalconfig: join(cache, 'global.npmrc'),
    npm_config_cache: cache, CI: 'true',
  };
  getDb().run(`INSERT INTO task_test_receipts
    (id,authorization_id,workspace_id,task_id,command,workdir,package_sha256,status,started_at)
    VALUES (?,?,?,?,?,?,?,'running',?)`, receiptId, grant.id, grant.workspaceId, task.id,
  grant.command, grant.workdir, grant.packageSha256, startedAt);
  active.set(grant.id, controller);
  activeScopes.add(scopeKey);
  let stdout = '', stderr = '', exitCode: number | null = null;
  try {
    reserveBudget({ workspaceId: grant.workspaceId, taskId: task.id, agentId: task.assigneeId || 'operator-verifier',
      key: budgetKey, kind: 'tool', tokens: 0, toolCalls: 1, runtimeMs: timeoutMs, costType: 'exact', costUSD: 0 });
    markBudgetDispatched(grant.workspaceId, budgetKey);
    try {
      const result = await execute('npm', ['test'], { cwd: grant.workdir, env: workspaceCommandEnvironment(grant.workdir, environment),
        signal: controller.signal, timeout: timeoutMs, maxBuffer: 256_000, encoding: 'utf8' });
      stdout = result.stdout; stderr = result.stderr; exitCode = 0;
    } catch (error: any) {
      stdout = error.stdout || ''; stderr = error.stderr || error.message;
      exitCode = Number.isInteger(error.code) ? error.code : null;
    }
    if (exitCode === null) markCurrentWorkspaceLeaseUncertain();
    if (exitCode !== null) settleUsage({ workspaceId: grant.workspaceId, key: budgetKey, eventKey: `${receiptId}:result`, tokens: 0,
      runtimeMs: Date.now() - Date.parse(startedAt), costType: 'exact', costUSD: 0 });
    if (controller.signal.aborted || !taskTestAuthorization(task)) throw new Error('TEST_AUTH_REVOKED_OR_EXPIRED');
    const checked = dlpCheck(`${stdout}\n${stderr}`, { taskId: task.id, workspaceId: task.workspaceId });
    if (checked.violations.some(item => item.action === 'block')) throw new Error('TEST_OUTPUT_DLP_BLOCKED');
    if (checked.redactedContent) { stdout = checked.redactedContent; stderr = ''; }
    const validationStatus = exitCode === null ? 'unknown'
      : testExecutionStatus({ command: grant.command, exitCode, stdout, stderr });
    const status = validationStatus === 'passed' ? 'passed'
      : validationStatus === 'failed' ? 'failed' : 'unavailable';
    const bounded = (value: string) => value.length <= 12000 ? value
      : `${value.slice(0, 6000)}\n…[middle truncated]\n${value.slice(-6000)}`;
    getDb().run(`UPDATE task_test_receipts SET status=?,exit_code=?,stdout=?,stderr=?,completed_at=? WHERE id=?`,
      status, exitCode, bounded(stdout), bounded(stderr), new Date().toISOString(), receiptId);
    addTaskLog(task.id, status === 'passed' ? 'info' : 'error', `Scoped verifier ${grant.command}: ${status}; receipt ${receiptId}`, 'quality-loop');
    if (exitCode === null) throw new Error(`TEST_RUNNER_UNAVAILABLE: ${stderr}`);
    return { command: grant.command, cwd: grant.workdir, exitCode, stdout: bounded(stdout),
      stderr: bounded(stderr), receiptId };
  } catch (error) {
    getDb().run(`UPDATE task_test_receipts SET status='unavailable',exit_code=NULL,stderr=?,completed_at=? WHERE id=?`,
      error instanceof Error ? error.message : 'Verifier unavailable', new Date().toISOString(), receiptId);
    throw error;
  } finally {
    options?.signal.removeEventListener('abort', abort);
    active.delete(grant.id); activeScopes.delete(scopeKey);
  }
}
