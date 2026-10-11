import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db/database.js';
import { createTask, getTask, updateTask } from '../src/db/models/task.js';
import { createExecution, updateExecution } from '../src/db/models/execution.js';
import { enqueueInbox, getInboxEntry, listInboxEntries } from '../src/db/models/agent-inbox.js';
import { SessionHarness } from '../src/agents/session-harness.js';
import { materializeQueuedFollowUp } from '../src/agents/queued-follow-up.js';
import type { RuntimeRequest } from '@myrmecia/shared';
import { createAgent } from '../src/db/models/agent.js';
beforeEach(() => { process.env.DB_PATH = ':memory:'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; });
const request: RuntimeRequest = { modelId: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'Original goal' }] }] };
function fixture() {
  createAgent({ id: 'fixture', name: 'Fixture', role: 'dev' });
  const task = createTask({ title: 'Original goal', input: 'Original goal', description: 'Original goal', mode: 'direct', assigneeId: 'fixture' });
  const run = createExecution({ taskId: task.id, agentDefId: 'fixture' });
  const harness = new SessionHarness(task, run.id);
  const entry = (key: string, mode: 'steer' | 'follow_up' = 'steer') => enqueueInbox({
    workspaceId: 'default', sessionId: harness.sessionId, targetExecutionId: run.id, mode,
    idempotencyKey: key, content: `Instruction ${key}`,
  });
  return { task, run, harness, entry };
}
describe('production session Harness request authority', () => {
  it('applies steering together with its persisted request and observes delivery rather than claiming it at dispatch', () => {
    const f = fixture(); const entry = f.entry('a');
    const actual = f.harness.prepare(request, value => value);
    expect(JSON.stringify(actual.messages)).toContain('Instruction a');
    expect(getInboxEntry(entry.id, 'default')?.status).toBe('applied');
    actual.messages.length = 0;
    expect(JSON.stringify(f.harness.messages())).toContain('Instruction a');
    f.harness.record({ schemaVersion: 1, workspaceId: 'default', conversationId: f.harness.sessionId,
      runId: f.run.id, requestId: f.harness.requestId, sequence: 1, type: 'assistant.completed',
      content: [{ type: 'text', text: 'Answer' }] });
    expect(getInboxEntry(entry.id, 'default')?.status).toBe('acknowledged');
  });
  it('rolls back claim and application when context preparation fails before dispatch', () => {
    const f = fixture(); const entry = f.entry('a');
    expect(() => f.harness.prepare(request, () => { throw new Error('CONTEXT_BUDGET_EXCEEDED'); })).toThrow('CONTEXT_BUDGET');
    expect(getInboxEntry(entry.id, 'default')?.status).toBe('pending');
    expect(f.harness.events()).toEqual([expect.objectContaining({ type: 'inbox.submitted' })]);
  });
  it('marks a request with no receipt uncertain and never automatically reclaims its applied instruction', () => {
    const f = fixture(); const entry = f.entry('a');
    f.harness.prepare(request, value => value);
    f.harness.record({ schemaVersion: 1, workspaceId: 'default', conversationId: f.harness.sessionId,
      runId: f.run.id, requestId: f.harness.requestId, sequence: 1, type: 'request.stopped', reason: 'failed' });
    expect(getInboxEntry(entry.id, 'default')).toMatchObject({ status: 'applied', reason: expect.stringContaining('uncertain') });
    const next = new SessionHarness(f.task, f.run.id);
    expect(JSON.stringify(next.prepare(request, value => value).messages)).not.toContain('Instruction a');
  });
  it('projects assistant/tool results without executing tools or trusting a mutated compatibility buffer', () => {
    const f = fixture();
    f.harness.prepare(request, value => value);
    f.harness.recordAssistant({ role: 'assistant', content: 'Reading', tool_calls: [{ id: 'r', function: { name: 'read', arguments: '{}' } }] });
    f.harness.appendTool({ role: 'tool', tool_call_id: 'r', content: 'Evidence' });
    expect(f.harness.legacyMessages().at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'r', content: 'Evidence' });
    expect(f.harness.messages()).toEqual(f.harness.messages());
  });
  it('keeps queued follow-up out of the current request and atomically creates one same-session continuation after completion', () => {
    const f = fixture(); const entry = f.entry('next', 'follow_up');
    expect(JSON.stringify(f.harness.prepare(request, value => value))).not.toContain('Instruction next');
    expect(materializeQueuedFollowUp(f.run.id)).toBeUndefined();
    updateTask(f.task.id, { status: 'done', output: 'Prior answer' });
    updateExecution(f.run.id, { status: 'done', runState: { schemaVersion: 1, phase: 'completed', turn: 1,
      toolCallCount: 0, acceptance: 'pending', stopReason: 'completed', updatedAt: new Date().toISOString() } });
    const next = materializeQueuedFollowUp(f.run.id)!;
    expect(next.parentTaskId).toBe(f.task.id);
    expect(next.assigneeId).toBe('fixture');
    expect(next.input).toContain('Instruction next');
    expect(next.input).toContain('Obtain fresh approval');
    expect(getInboxEntry(entry.id, 'default')?.assignedTaskId).toBe(next.id);
    expect(materializeQueuedFollowUp(f.run.id)).toBeUndefined();
    expect(getTask(next.id)).toBeTruthy();
    expect(listInboxEntries('default', f.harness.sessionId)).toHaveLength(1);
    const nextRun = createExecution({ taskId: next.id, agentDefId: 'fixture' });
    const nextHarness = new SessionHarness(next, nextRun.id);
    nextHarness.prepare({ ...request, messages: [{ role: 'user', content: [{ type: 'text', text: next.input }] }] }, value => value);
    expect(getInboxEntry(entry.id, 'default')?.status).toBe('applied');
    nextHarness.record({ schemaVersion: 1, workspaceId: 'default', conversationId: nextHarness.sessionId,
      runId: nextRun.id, requestId: nextHarness.requestId, sequence: 1, type: 'assistant.completed',
      content: [{ type: 'text', text: 'Queued follow-up answer' }] });
    expect(getInboxEntry(entry.id, 'default')?.status).toBe('acknowledged');
  });
  it('rejects queued instructions after cancellation instead of restarting a cancelled run', () => {
    const f = fixture(); const entry = f.entry('next', 'follow_up');
    updateTask(f.task.id, { status: 'cancelled' });
    expect(materializeQueuedFollowUp(f.run.id)).toBeUndefined();
    expect(getInboxEntry(entry.id, 'default')?.status).toBe('rejected');
  });
});
