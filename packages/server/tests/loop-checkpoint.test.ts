import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution, updateExecution } from '../src/db/models/execution.js';
import { initialAgentRunState } from '../src/agents/run-state.js';
import { loopFingerprint, readLoopCheckpoint, saveLoopCheckpoint, sealLoopCheckpoint, type AgentLoopCheckpoint } from '../src/agents/loop-checkpoint.js';
import { runWriteOnce } from '../src/tools/write-once.js';

beforeEach(() => { process.env.DB_PATH = ':memory:'; getDb(); });
afterEach(() => { closeDb(); delete process.env.DB_PATH; vi.restoreAllMocks(); });
const snapshot: AgentLoopCheckpoint = {
  schemaVersion: 1, messages: [{ role: 'user', content: 'Research safely' }],
  turn: 3, inputTokens: 1200, outputTokens: 400, toolCallCount: 2, toolRuntimeMs: 5000, elapsedMs: 20000, finalOutput: 'Partial evidence',
};
function fixture() {
  const task = createTask({ title: 'checkpoint', description: '', input: 'Research safely', mode: 'direct', workspaceId: 'default' });
  const old = createExecution({ taskId: task.id, agentDefId: 'fixture' });
  updateExecution(old.id, { status: 'failed', runState: { ...initialAgentRunState(), phase: 'interrupted', stopReason: 'interrupted' } });
  const current = createExecution({ taskId: task.id, agentDefId: 'fixture' });
  return { task, old, current };
}

describe('read-only stable-turn recovery', () => {
  it('retains turns, tokens and elapsed time, and refuses changed policies or tenant scopes', () => {
    const { task, old, current } = fixture();
    saveLoopCheckpoint(task, old.id, 'fingerprint', snapshot);
    expect(readLoopCheckpoint(task, 'fingerprint', current.id)?.snapshot).toEqual(snapshot);
    expect(readLoopCheckpoint(task, 'different-policy', current.id)).toBeUndefined();
    expect(readLoopCheckpoint({ ...task, workspaceId: 'other' }, 'fingerprint', current.id)).toBeUndefined();
    sealLoopCheckpoint(old.id);
    expect(readLoopCheckpoint(task, 'fingerprint', current.id)).toBeUndefined();
  });

  it('does not resume completed or non-interrupted failed runs', () => {
    const { task, old, current } = fixture();
    saveLoopCheckpoint(task, old.id, 'fingerprint', snapshot);
    updateExecution(old.id, { runState: { ...initialAgentRunState(), phase: 'failed', stopReason: 'max_turns' } });
    expect(readLoopCheckpoint(task, 'fingerprint', current.id)).toBeUndefined();
  });

  it('journals writes before dispatch and prevents retries, reordered-argument bypasses, and automatic recovery', async () => {
    const { task, old, current } = fixture();
    saveLoopCheckpoint(task, old.id, 'fingerprint', snapshot);
    const operation = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(runWriteOnce(task, current.id, 'unknown_write', { a: 1, b: 2 }, operation)).rejects.toThrow('timeout');
    expect(getDb().get<any>('SELECT outcome FROM agent_tool_invocations WHERE task_id = ?', task.id)?.outcome).toBe('unknown');
    await expect(runWriteOnce(task, current.id, 'unknown_write', { b: 2, a: 1 }, operation)).rejects.toThrow('TOOL_REPLAY_BLOCKED');
    expect(operation).toHaveBeenCalledOnce();
    expect(readLoopCheckpoint(task, 'fingerprint', current.id)).toBeUndefined();
  });

  it('uses stable, policy-sensitive fingerprints', () => {
    const base = { agentId: 'a', modelId: 'm', systemPrompt: 'p', input: 'i', tools: ['b', 'a'] };
    expect(loopFingerprint(base)).toBe(loopFingerprint({ ...base, tools: ['a', 'b'] }));
    expect(loopFingerprint(base)).not.toBe(loopFingerprint({ ...base, modelId: 'other' }));
  });
});
