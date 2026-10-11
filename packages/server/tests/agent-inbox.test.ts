import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution } from '../src/db/models/execution.js';
import { agentSessionForTask, appendSessionEvent, listSessionEvents } from '../src/db/models/agent-session-event.js';
import { enqueueInbox, claimInbox, applyInbox, ackInbox, rejectInbox, finalizeInboxForExecution, listInboxEntries, getInboxEntry } from '../src/db/models/agent-inbox.js';
import { messageBus } from '../src/agents/message-bus.js';

beforeEach(() => { process.env.DB_PATH = ':memory:'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; });
function fixture() {
  const task = createTask({ title: 'root', description: '', input: 'hello', mode: 'direct', workspaceId: 'w' });
  const run = createExecution({ taskId: task.id, agentDefId: 'fixture', workspaceId: 'w' });
  const sessionId = agentSessionForTask(task);
  const scope = { workspaceId: 'w', sessionId, targetExecutionId: run.id };
  const enqueue = (key: string, mode: 'steer' | 'follow_up' = 'steer') => enqueueInbox({
    ...scope, mode, content: `instruction ${key}`, idempotencyKey: key,
  });
  return { task, run, scope, enqueue };
}
describe('durable Agent inbox transitions', () => {
  it('does not leave a late steering message pending forever when the final request already completed', () => {
    const f = fixture();
    const late = f.enqueue('too-late');
    const queued = f.enqueue('next-task', 'follow_up');
    finalizeInboxForExecution('w', f.run.id);
    expect(getInboxEntry(late.id, 'w')).toMatchObject({ status: 'rejected', reason: expect.stringContaining('当前执行已结束') });
    expect(getInboxEntry(queued.id, 'w')?.status).toBe('pending');
  });
  it('deduplicates accepted submissions and rejects altered retry payloads', () => {
    const f = fixture();
    const entry = f.enqueue('a');
    expect(f.enqueue('a').id).toBe(entry.id);
    expect(() => enqueueInbox({ ...f.scope, mode: 'follow_up', content: 'instruction a', idempotencyKey: 'a' })).toThrow('IDEMPOTENCY_CONFLICT');
    expect(listInboxEntries('w', f.scope.sessionId)).toHaveLength(1);
  });
  it('separates current steering from queued follow-up and prevents simultaneous claimants', () => {
    const f = fixture();
    f.enqueue('a'); f.enqueue('b', 'follow_up');
    expect(claimInbox({ ...f.scope, mode: 'steer', owner: 'worker1', nowMs: 1000 })).toHaveLength(1);
    expect(claimInbox({ ...f.scope, mode: 'steer', owner: 'worker2', nowMs: 1001 })).toEqual([]);
    expect(claimInbox({ ...f.scope, mode: 'follow_up', owner: 'worker2', nowMs: 1001 })).toHaveLength(1);
  });
  it('reclaims expired work and fences its old claimant', () => {
    const f = fixture();
    const entry = f.enqueue('a');
    claimInbox({ ...f.scope, mode: 'steer', owner: 'old', nowMs: 1000, leaseMs: 100 });
    claimInbox({ ...f.scope, mode: 'steer', owner: 'new', nowMs: 1101 });
    expect(() => applyInbox({ workspaceId: 'w', id: entry.id, owner: 'old', requestId: 'q', nowMs: 1102 })).toThrow('CLAIM_LOST');
    expect(applyInbox({ workspaceId: 'w', id: entry.id, owner: 'new', requestId: 'q', nowMs: 1102 }).status).toBe('applied');
  });
  it('records application once, does not acknowledge mere claiming, and binds acknowledgement to an observed request', () => {
    const f = fixture();
    const entry = f.enqueue('a');
    claimInbox({ ...f.scope, mode: 'steer', owner: 'worker', nowMs: 1000 });
    expect(getInboxEntry(entry.id, 'w')?.status).toBe('claimed');
    const applied = applyInbox({ workspaceId: 'w', id: entry.id, owner: 'worker', requestId: 'q', nowMs: 1001 });
    expect(applyInbox({ workspaceId: 'w', id: entry.id, owner: 'worker', requestId: 'q', nowMs: 1002 }).appliedEventId).toBe(applied.appliedEventId);
    expect(listSessionEvents({ workspaceId: 'w', sessionId: f.scope.sessionId })).toHaveLength(2);
    expect(() => ackInbox({ workspaceId: 'w', id: entry.id, requestId: 'wrong' })).toThrow('ACK_REQUEST_MISMATCH');
    expect(() => ackInbox({ workspaceId: 'w', id: entry.id, requestId: 'q' })).toThrow('DELIVERY_UNOBSERVED');
    appendSessionEvent({
      workspaceId: 'w', sessionId: f.scope.sessionId, runId: f.run.id, requestId: 'q', eventKey: 'provider-receipt',
      payload: { schemaVersion: 1, workspaceId: 'w', conversationId: f.scope.sessionId, runId: f.run.id, requestId: 'q',
        sequence: 1, type: 'assistant.delta', text: 'Observed fixture response' },
    });
    expect(ackInbox({ workspaceId: 'w', id: entry.id, requestId: 'q' }).status).toBe('acknowledged');
    expect(ackInbox({ workspaceId: 'w', id: entry.id, requestId: 'q' }).status).toBe('acknowledged');
    expect(listSessionEvents({ workspaceId: 'w', sessionId: f.scope.sessionId })).toHaveLength(4);
  });
  it('preserves a terminal rejection and refuses a late acknowledgement', () => {
    const f = fixture();
    const entry = f.enqueue('a');
    claimInbox({ ...f.scope, mode: 'steer', owner: 'worker', nowMs: 1000 });
    applyInbox({ workspaceId: 'w', id: entry.id, owner: 'worker', requestId: 'q', nowMs: 1001 });
    rejectInbox('w', entry.id, 'Run cancelled');
    expect(() => ackInbox({ workspaceId: 'w', id: entry.id, requestId: 'q' })).toThrow('NOT_APPLIED');
    expect(getInboxEntry(entry.id, 'w')).toMatchObject({ status: 'rejected', reason: 'Run cancelled' });
  });
  it('does not consume a legacy mailbox message until application commits', () => {
    const f = fixture();
    const message = messageBus.send(null, f.run.id, 'text', 'instruction');
    const entry = enqueueInbox({ ...f.scope, mode: 'steer', content: 'instruction', idempotencyKey: 'a', sourceMessageId: message.id });
    claimInbox({ ...f.scope, mode: 'steer', owner: 'worker', nowMs: 1000 });
    expect(messageBus.pendingCount(f.run.id)).toBe(1);
    applyInbox({ workspaceId: 'w', id: entry.id, owner: 'worker', requestId: 'q', nowMs: 1001 });
    expect(messageBus.pendingCount(f.run.id)).toBe(0);
  });
  it('rejects cross-workspace and forged source references without modifying history', () => {
    const f = fixture();
    expect(() => enqueueInbox({ ...f.scope, workspaceId: 'other', mode: 'steer', content: 'instruction', idempotencyKey: 'a' })).toThrow('SCOPE_DENIED');
    const otherTask = createTask({ title: 'other', description: '', input: '', mode: 'direct', workspaceId: 'w' });
    const otherRun = createExecution({ taskId: otherTask.id, agentDefId: 'fixture', workspaceId: 'w' });
    const message = messageBus.send(null, otherRun.id, 'text', 'other instruction');
    expect(() => enqueueInbox({ ...f.scope, mode: 'steer', content: 'instruction', idempotencyKey: 'a', sourceMessageId: message.id })).toThrow('MESSAGE_SCOPE_DENIED');
    expect(listInboxEntries('w', f.scope.sessionId)).toEqual([]);
  });
});
