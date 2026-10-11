import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from '../src/db/database.js';
import { createTask, getTask } from '../src/db/models/task.js';
const children: ChildProcess[] = [];
beforeEach(() => { closeDb(); process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-owner-process-')), 'authority.sqlite'); });
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const ended = new Promise<void>(resolve => child.once('exit', () => resolve()));
    if (child.connected) child.disconnect();
    else child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGTERM'), 1000);
    try { await ended; } finally { clearTimeout(timer); }
  }
  closeDb(); delete process.env.DB_PATH;
});
function receive(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Fixture worker timed out')); }, 5000);
    const message = (data: unknown) => { cleanup(); resolve(data); };
    const exit = () => { cleanup(); reject(new Error('Fixture worker exited')); };
    const cleanup = () => { clearTimeout(timer); child.removeListener('message', message); child.removeListener('exit', exit); };
    child.once('message', message); child.once('exit', exit);
  });
}
async function worker() {
  const child = fork(fileURLToPath(new URL('./fixtures/runtime-owner-worker.ts', import.meta.url)), {
    execArgv: ['--import', 'tsx'], silent: true, env: { ...process.env, MYRMECIA_RUNTIME_V2: 'true' },
  });
  children.push(child);
  expect(await receive(child)).toMatchObject({ ready: true });
  return child;
}
function send(child: ChildProcess, data: unknown) { const result = receive(child); child.send(data); return result; }
describe('real OS-process ownership authority', () => {
  it('permits one simultaneous claimant, rejects stale process writes and retains the winner after SQLite reopen', async () => {
    const task = createTask({ title: 'process fixture', description: '', input: 'fixture', mode: 'direct', workspaceId: 'w' });
    const [a, b] = await Promise.all([worker(), worker()]);
    const nowMs = Date.now();
    const [ra, rb] = await Promise.all([
      send(a, { action: 'claim', data: { taskId: task.id, workspaceId: 'w', owner: 'process-a', nowMs } }),
      send(b, { action: 'claim', data: { taskId: task.id, workspaceId: 'w', owner: 'process-b', nowMs } }),
    ]);
    expect([ra, rb].filter(result => result.ok)).toHaveLength(1);
    const stale = ra.ok ? a : b, next = ra.ok ? b : a;
    const renewed = await send(next, { action: 'claim', data: { taskId: task.id, workspaceId: 'w', owner: 'new-process', nowMs: nowMs + 60_001 } });
    expect(renewed.ok).toBe(true);
    expect(await send(stale, { action: 'commit', output: 'forbidden stale output' })).toMatchObject({ ok: false, code: expect.stringContaining('FENCE_LOST') });
    expect(await send(next, { action: 'commit', output: 'current durable output' })).toMatchObject({ ok: true });
    closeDb();
    expect(getTask(task.id)?.output).toBe('current durable output');
  }, 15_000);
  it('retains ownership and the cumulative task clock through a real worker SIGKILL before reclaiming an expired lease', async () => {
    const task = createTask({ title: 'killed worker fixture', description: '', input: 'fixture', mode: 'direct', workspaceId: 'w' });
    const first = await worker();
    const nowMs = Date.now();
    const claimed = await send(first, { action: 'claim', data: { taskId: task.id, workspaceId: 'w', owner: 'before-crash', nowMs } });
    const exit = new Promise<void>(resolve => first.once('exit', () => resolve()));
    first.kill('SIGKILL'); await exit;
    closeDb();
    const next = await worker();
    expect(await send(next, { action: 'claim', data: { taskId: task.id, workspaceId: 'w', owner: 'after-crash', nowMs: nowMs + 1 } }))
      .toMatchObject({ ok: false, code: expect.stringContaining('ALREADY_OWNED') });
    const resumed = await send(next, { action: 'claim', data: { taskId: task.id, workspaceId: 'w', owner: 'after-crash', nowMs: nowMs + 60_001 } });
    expect(resumed.lease.token).toBe(claimed.lease.token + 1);
    expect(getDb().get<any>('SELECT first_started_at_ms FROM agent_run_ownership WHERE task_id = ?', task.id).first_started_at_ms).toBe(nowMs);
  }, 15_000);
});
