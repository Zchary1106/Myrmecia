import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, listAppliedMigrations } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution } from '../src/db/models/execution.js';
import { agentSessionForTask, appendSessionEvent, listSessionEvents, sessionEventCursor } from '../src/db/models/agent-session-event.js';
import { deriveModelMessages, deriveConversationView } from '../src/agents/session-projector.js';
import type { AgentSessionPayload } from '@myrmecia/shared';

beforeEach(() => { process.env.DB_PATH = ':memory:'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; });
function fixture() {
  const task = createTask({ title: 'root', description: '', input: 'hello', mode: 'direct', workspaceId: 'w' });
  const run = createExecution({ taskId: task.id, agentDefId: 'fixture', workspaceId: 'w' });
  return { task, run, sessionId: agentSessionForTask(task),
    append: (eventKey: string, payload: AgentSessionPayload, requestId?: string) =>
      appendSessionEvent({ workspaceId: 'w', sessionId: agentSessionForTask(task), runId: run.id, requestId, eventKey, payload }) };
}
describe('canonical append-only session history', () => {
  it('adds migrations without deleting legacy tasks or replacing old history', () => {
    const f = fixture();
    expect(listAppliedMigrations().some(item => item.id === '202610070001_agent_session_events')).toBe(true);
    expect(listAppliedMigrations().some(item => item.id === '202610070002_agent_durable_inbox')).toBe(true);
    expect(listSessionEvents({ workspaceId: 'w', sessionId: f.sessionId })).toEqual([]);
    expect(deriveModelMessages([])).toEqual([]);
  });
  it('atomically allocates ordered events and deduplicates matching writes without sequence gaps', () => {
    const f = fixture();
    const data = { type: 'user.submitted' as const, taskId: f.task.id, content: 'hello' };
    const first = f.append('user-1', data);
    expect(f.append('user-1', data)).toEqual(first);
    const second = f.append('user-2', { ...data, content: 'next' });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(sessionEventCursor('w', f.sessionId)).toBe(2);
    expect(listSessionEvents({ workspaceId: 'w', sessionId: f.sessionId, afterSequence: 1 })).toEqual([second]);
  });
  it('rejects conflicting idempotency, workspace, session and native event identity', () => {
    const f = fixture();
    const data = { type: 'user.submitted' as const, taskId: f.task.id, content: 'hello' };
    f.append('same', data);
    expect(() => f.append('same', { ...data, content: 'different' })).toThrow('IDEMPOTENCY_CONFLICT');
    expect(() => appendSessionEvent({ workspaceId: 'foreign', sessionId: f.sessionId, runId: f.run.id, eventKey: 'bad', payload: data })).toThrow('SCOPE_DENIED');
    expect(listSessionEvents({ workspaceId: 'foreign', sessionId: f.sessionId })).toEqual([]);
    expect(() => f.append('identity', { schemaVersion: 1, workspaceId: 'other', conversationId: f.sessionId, runId: f.run.id,
      requestId: 'q', sequence: 1, type: 'assistant.delta', text: 'wrong' }, 'q')).toThrow('IDENTITY_MISMATCH');
    expect(sessionEventCursor('w', f.sessionId)).toBe(1);
  });
  it('refuses sensitive or oversized payloads without persisting them', () => {
    const f = fixture();
    expect(() => f.append('sensitive', { type: 'user.submitted', taskId: f.task.id, content: `sk-${'a'.repeat(40)}` })).toThrow('UNPERSISTABLE');
    expect(() => f.append('huge', { type: 'user.submitted', taskId: f.task.id, content: 'x'.repeat(2_000_001) })).toThrow('TOO_LARGE');
    expect(sessionEventCursor('w', f.sessionId)).toBe(0);
  });
  it('resolves multi-level conversation lineage and rejects cross-workspace parentage', () => {
    const f = fixture();
    const child = createTask({ title: 'child', description: '', input: 'next', mode: 'direct', parentTaskId: f.task.id, workspaceId: 'w' });
    const grandchild = createTask({ title: 'grandchild', description: '', input: 'next', mode: 'direct', parentTaskId: child.id, workspaceId: 'w' });
    expect(agentSessionForTask(grandchild)).toBe(f.sessionId);
    const foreign = createTask({ title: 'foreign', description: '', input: 'next', mode: 'direct', parentTaskId: f.task.id, workspaceId: 'other' });
    expect(() => agentSessionForTask(foreign)).toThrow('WORKSPACE_MISMATCH');
  });
  it('purely reconstructs one request without contaminating it with subsequent request results', () => {
    const f = fixture();
    const context = (text: string): AgentSessionPayload => ({ type: 'context.recorded', projectionVersion: 1, kind: 'host_request',
      modelId: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text }] }], toolsFingerprint: 'tools', configFingerprint: 'config' });
    f.append('ctx-1', context('first'), 'q1');
    f.append('reply-1', { type: 'model.message', role: 'assistant', content: [{ type: 'text', text: 'answer1' }] }, 'q1');
    f.append('ctx-2', context('second'), 'q2');
    f.append('reply-2', { type: 'model.message', role: 'assistant', content: [{ type: 'text', text: 'answer2' }] }, 'q2');
    const events = listSessionEvents({ workspaceId: 'w', sessionId: f.sessionId });
    expect(JSON.stringify(deriveModelMessages(events, 'q1'))).toContain('answer1');
    expect(JSON.stringify(deriveModelMessages(events, 'q1'))).not.toContain('answer2');
    expect(JSON.stringify(deriveModelMessages(events))).toContain('answer2');
    expect(deriveModelMessages([...events].reverse())).toEqual(deriveModelMessages(events));
    expect(deriveModelMessages([...events, events[0]])).toEqual(deriveModelMessages(events));
  });
  it('projects streaming UI updates in place without exposing system or request scaffolding', () => {
    const f = fixture();
    f.append('user', { type: 'user.submitted', taskId: f.task.id, content: 'hello' });
    f.append('ctx', { type: 'context.recorded', projectionVersion: 1, kind: 'provider_envelope', modelId: 'fixture',
      messages: [{ role: 'system', content: [{ type: 'text', text: 'INTERNAL_PROMPT' }] }], toolsFingerprint: 't', configFingerprint: 'c' }, 'q');
    const identity = { schemaVersion: 1 as const, workspaceId: 'w', conversationId: f.sessionId, runId: f.run.id, requestId: 'q' };
    f.append('d1', { ...identity, sequence: 1, type: 'assistant.delta', text: 'Hello' }, 'q');
    f.append('d2', { ...identity, sequence: 2, type: 'assistant.delta', text: ' partial' }, 'q');
    f.append('done', { ...identity, sequence: 3, type: 'assistant.completed', content: [{ type: 'text', text: 'Hello final' }] }, 'q');
    const view = deriveConversationView(listSessionEvents({ workspaceId: 'w', sessionId: f.sessionId }));
    expect(view.filter(item => item.role === 'assistant')).toHaveLength(1);
    expect(view.at(-1)).toMatchObject({ content: 'Hello final', state: 'completed' });
    expect(JSON.stringify(view)).not.toContain('INTERNAL_PROMPT');
  });
});
