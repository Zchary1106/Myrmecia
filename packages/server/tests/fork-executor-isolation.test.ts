import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createExecution } from '../src/db/models/execution.js';
import { createTask } from '../src/db/models/task.js';
import { ForkExecutor } from '../src/agents/fork-executor.js';

describe('fork executor isolation', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-fork-')), 'test.db');
    process.env.AGENT_MAX_SUBAGENTS_PER_TASK = '1';
    getDb();
    createAgent({ id: 'developer', name: 'Developer', role: 'developer' });
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
    delete process.env.AGENT_MAX_SUBAGENTS_PER_TASK;
  });

  it('blocks child fan-out beyond the configured limit', async () => {
    const parent = createTask({
      title: 'parent',
      description: 'parent',
      mode: 'direct',
      input: 'parent',
      assigneeId: 'developer',
    });
    const execution = createExecution({ taskId: parent.id, agentDefId: 'developer' });
    createTask({
      title: 'existing child',
      description: 'child',
      mode: 'direct',
      input: 'child',
      assigneeId: 'developer',
      parentTaskId: parent.id,
    });

    await expect(new ForkExecutor().fork(execution.id, 'another child')).rejects.toThrow(/Sub-agent limit exceeded/);
  });
});
