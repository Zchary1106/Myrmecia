import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution } from '../src/db/models/execution.js';
import { updateAgentRun } from '../src/agents/run-state.js';
import { withToolResourceLock, reconcileToolResourceLocks } from '../src/agents/tool-resource-lock.js';
beforeEach(() => { process.env.DB_PATH = ':memory:'; process.env.MYRMECIA_RUNTIME_V2 = 'true'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; delete process.env.MYRMECIA_RUNTIME_V2; vi.useRealTimers(); });
function fixture() {
  const task = createTask({ title: 'fixture', input: 'fixture', description: '', mode: 'direct', workdir: '/tmp/fixture' });
  const run = createExecution({ taskId: task.id, agentDefId: 'fixture' });
  updateAgentRun(run.id, 'deciding');
  updateAgentRun(run.id, 'acting');
  return { task, run };
}
describe('shared durable resource locks', () => {
  it('serializes conflicting reads from different executions using DB authority', async () => {
    vi.useFakeTimers();
    const a = fixture(), b = fixture();
    const events: string[] = [];
    const one = withToolResourceLock(a.task, a.run.id, 'file_read', { path: 'same' }, async () => {
      events.push('start-a'); await new Promise(resolve => setTimeout(resolve, 100)); events.push('end-a'); return { status: 'done' as const };
    });
    const two = withToolResourceLock(b.task, b.run.id, 'file_read', { path: 'same' }, async () => {
      events.push('start-b'); return { status: 'done' as const };
    });
    await vi.runAllTimersAsync();
    await Promise.all([one, two]);
    expect(events).toEqual(['start-a', 'end-a', 'start-b']);
  });
  it('does not clear an unknown write automatically and permits only explicit scoped reconciliation', async () => {
    const a = fixture();
    await withToolResourceLock(a.task, a.run.id, 'file_write', { path: 'same' }, async () => ({ status: 'failed' }));
    expect(getDb().get<any>('SELECT status FROM agent_tool_resource_locks').status).toBe('unknown');
    expect(reconcileToolResourceLocks('other', a.run.id)).toBe(0);
    expect(reconcileToolResourceLocks('default', a.run.id)).toBe(1);
  });
  it('cancels a queued call before it can dispatch or touch the resource', async () => {
    vi.useFakeTimers();
    const a = fixture(), b = fixture();
    await withToolResourceLock(a.task, a.run.id, 'file_write', { path: 'same' }, async () => ({ status: 'failed' }));
    const controller = new AbortController();
    const operation = vi.fn();
    const pending = withToolResourceLock(b.task, b.run.id, 'file_read', { path: 'same' }, operation, controller.signal);
    const check = expect(pending).rejects.toThrow('aborted');
    controller.abort(); await check;
    expect(operation).not.toHaveBeenCalled();
  });
});
