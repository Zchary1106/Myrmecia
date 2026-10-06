import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, listAppliedMigrations } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution, getExecution, updateExecution } from '../src/db/models/execution.js';
import { AgentRunStopped, classifyAgentStop, initialAgentRunState, transitionAgentRun, updateAgentRun, validateAgentOutput } from '../src/agents/run-state.js';

beforeEach(() => { process.env.DB_PATH = ':memory:'; getDb(); });
afterEach(() => { closeDb(); delete process.env.DB_PATH; });

describe('Agent run contract', () => {
  it('separates basic output validation from user acceptance', () => {
    expect(initialAgentRunState().acceptance).toBe('pending');
    expect(validateAgentOutput('')).toMatchObject({ status: 'failed', scope: 'output' });
    expect(validateAgentOutput('answer')).toMatchObject({ status: 'passed', scope: 'output' });
  });

  it('does not resurrect terminal runs or move counters backwards', () => {
    const deciding = transitionAgentRun(initialAgentRunState(), 'deciding', { turn: 2 });
    expect(() => transitionAgentRun(deciding, 'acting', { turn: 1 })).toThrow('backwards');
    const cancelled = transitionAgentRun(deciding, 'cancelled', { stopReason: 'cancelled' });
    expect(() => transitionAgentRun(cancelled, 'completed')).toThrow('settled');
  });

  it('keeps legacy executions unknown and persists new states across reads', () => {
    const task = createTask({ title: 'run', description: 'test', mode: 'direct', input: 'hello' });
    const execution = createExecution({ taskId: task.id, agentDefId: 'test-agent' });
    expect(execution.runState).toBeUndefined();
    updateAgentRun(execution.id, 'deciding', { turn: 1 });
    expect(getExecution(execution.id)?.runState).toMatchObject({ phase: 'deciding', turn: 1, acceptance: 'pending' });
    updateAgentRun(execution.id, 'cancelled', { stopReason: 'cancelled' });
    updateAgentRun(execution.id, 'completed', { stopReason: 'completed' });
    expect(getExecution(execution.id)?.runState?.phase).toBe('cancelled');
    expect(listAppliedMigrations().some(m => m.id === '202610060001_agent_run_state')).toBe(true);
  });

  it('retains cancellation even when a late adapter returns output', () => {
    expect(classifyAgentStop(new Error('failed'), true)).toBe('cancelled');
    expect(classifyAgentStop(new AgentRunStopped('max_turns', 'limit', 'partial'))).toBe('max_turns');
    expect(classifyAgentStop(new Error('EXECUTION_WALL_TIMEOUT'))).toBe('deadline');
    expect(classifyAgentStop(new Error('TIMED_OUT: runtime process was aborted'))).toBe('deadline');
    expect(classifyAgentStop(new Error('STALLED: runtime idle'))).toBe('deadline');
  });

  it('does not invent a state when the persisted version is unknown', () => {
    const task = createTask({ title: 'run', description: 'test', mode: 'direct', input: 'hello' });
    const execution = createExecution({ taskId: task.id, agentDefId: 'test-agent' });
    getDb().run('UPDATE task_executions SET run_state = ? WHERE id = ?', '{"schemaVersion":99}', execution.id);
    expect(getExecution(execution.id)?.runState).toBeUndefined();
    updateExecution(execution.id, { status: 'failed' });
  });
});
