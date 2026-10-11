import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../src/db/database.js';
import { createTask, updateTask } from '../src/db/models/task.js';
import { assertRunLease, claimRun, commitRunEvent, releaseRunLease, renewRunLease } from '../src/db/models/run-ownership.js';
import { withOwnedRun } from '../src/agents/run-coordinator.js';
beforeEach(() => { process.env.DB_PATH = ':memory:'; process.env.MYRMECIA_RUNTIME_V2 = 'true'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; delete process.env.MYRMECIA_RUNTIME_V2; vi.useRealTimers(); });
const task = () => createTask({ title: 'fixture', input: 'fixture', description: '', mode: 'direct', workspaceId: 'w' });
describe('durable single-owner runtime fencing', () => {
  it('allows only one claimant and increments the token after lease expiry', () => {
    const t = task();
    const a = claimRun({ taskId: t.id, workspaceId: 'w', owner: 'a', nowMs: 1000 });
    expect(() => claimRun({ taskId: t.id, workspaceId: 'w', owner: 'b', nowMs: 1001 })).toThrow('ALREADY_OWNED');
    const b = claimRun({ taskId: t.id, workspaceId: 'w', owner: 'b', nowMs: 61_001 });
    expect(b.token).toBe(a.token + 1);
    expect(() => assertRunLease(a, 61_002)).toThrow('FENCE_LOST');
    expect(() => renewRunLease(a, 61_002)).toThrow('FENCE_LOST');
  });
  it('rejects stale commits and prevents an old release from releasing the new owner', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const t = task();
    const a = claimRun({ taskId: t.id, workspaceId: 'w', owner: 'a', leaseMs: 10 });
    vi.setSystemTime(1011);
    const b = claimRun({ taskId: t.id, workspaceId: 'w', owner: 'b' });
    releaseRunLease(a);
    expect(() => commitRunEvent(a, () => updateTask(t.id, { output: 'late' }))).toThrow('FENCE_LOST');
    expect(() => assertRunLease(b)).not.toThrow();
    commitRunEvent(b, () => updateTask(t.id, { output: 'current' }));
  });
  it('fences production state writes using the original async runtime scope, including its catch path', async () => {
    const t = task();
    await expect(withOwnedRun(t, async () => {
      getDb().run('UPDATE agent_run_ownership SET fence_token = fence_token + 1 WHERE task_id = ?', t.id);
      updateTask(t.id, { status: 'done', output: 'late output' });
    })).rejects.toThrow('FENCE_LOST');
    expect(getDb().get<any>('SELECT output FROM tasks WHERE id = ?', t.id).output).toBeNull();
  });
  it('rejects cross-workspace claiming without creating an ownership row', () => {
    const t = task();
    expect(() => claimRun({ taskId: t.id, workspaceId: 'other', owner: 'a' })).toThrow('SCOPE_DENIED');
    expect(getDb().all('SELECT * FROM agent_run_ownership')).toEqual([]);
  });
});
