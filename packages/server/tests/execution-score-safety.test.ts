import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../src/db/database.js';
import { createAgent, getAgent } from '../src/db/models/agent.js';
import * as agentModels from '../src/db/models/agent.js';
import { createTask, updateTask } from '../src/db/models/task.js';
import { createExecution, updateExecution } from '../src/db/models/execution.js';
import { listExecutionScores } from '../src/db/models/execution-score.js';
import { ExecutionScorer } from '../src/evaluation/execution-scorer.js';

beforeEach(() => { process.env.DB_PATH = ':memory:'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; vi.restoreAllMocks(); });
describe('operational scores are not quality evidence', () => {
  it('records a heuristic without pretending to judge correctness or changing routing', async () => {
    const agent = createAgent({ id: 'scoring-fixture', name: 'Fixture', role: 'dev' });
    const before = getAgent(agent.id);
    const writes = vi.spyOn(agentModels, 'updateAgent');
    const task = createTask({ title: 'Evaluate', description: '', input: 'short request', mode: 'direct', assigneeId: agent.id });
    const execution = createExecution({ taskId: task.id, agentDefId: agent.id });
    updateExecution(execution.id, { status: 'done', completedAt: new Date().toISOString() });
    updateTask(task.id, { status: 'done', output: 'error is a word in a discussion, not proof of an incorrect answer' });
    await new ExecutionScorer().score(task.id);
    const score = listExecutionScores({ taskId: task.id })[0];
    expect(score.llmScore).toBeNull();
    expect(score.dimensions).toHaveProperty('operational');
    expect(score.dimensions).not.toHaveProperty('correctness');
    expect(writes).not.toHaveBeenCalled();
    expect(getAgent(agent.id)).toEqual(before);
  });
});
