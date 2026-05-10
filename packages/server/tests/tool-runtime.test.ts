import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution } from '../src/db/models/execution.js';
import { syncBuiltinTools, updateToolPolicy, setToolPermission } from '../src/tools/tool-registry.js';
import { createToolExecution, completeToolExecution, listToolExecutions } from '../src/tools/tool-execution.js';
import { resolveAllowedToolsForAgent } from '../src/tools/tool-policy.js';

describe('tool runtime', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-tools-')), 'test.db');
    getDb();
    syncBuiltinTools();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('filters requested tools through registry and per-agent policy', () => {
    const agent = createAgent({
      id: 'tool-agent',
      name: 'Tool Agent',
      role: 'researcher',
      allowedTools: ['web.search', 'web.fetch', 'missing.tool'],
      config: { allowedTools: ['web.search', 'web.fetch', 'missing.tool'] },
    });
    updateToolPolicy('web.fetch', { enabled: false });
    setToolPermission({ toolId: 'web.search', agentId: agent.id, enabled: true });

    const policy = resolveAllowedToolsForAgent(agent);

    expect(policy.allowedTools).toEqual(['web.search']);
    expect(policy.decisions.find(decision => decision.toolId === 'web.fetch')?.reason).toBe('tool_disabled');
    expect(policy.decisions.find(decision => decision.toolId === 'missing.tool')?.reason).toBe('unknown_tool');
  });

  it('persists tool execution lifecycle', () => {
    const agent = createAgent({
      id: 'tool-agent',
      name: 'Tool Agent',
      role: 'researcher',
      allowedTools: ['web.search'],
    });
    const task = createTask({
      title: 'Tool task',
      description: 'Tool task',
      mode: 'direct',
      input: 'search',
      assigneeId: agent.id,
    });
    const execution = createExecution({ taskId: task.id, agentDefId: agent.id });

    const started = createToolExecution({
      id: 'tool-test-1',
      toolId: 'web.search',
      taskId: task.id,
      executionId: execution.id,
      agentId: agent.id,
      input: { query: 'agent factory' },
    });
    expect(started.status).toBe('running');
    expect(started.inputHash).toHaveLength(64);

    const completed = completeToolExecution(started.id, {
      status: 'done',
      output: [{ title: 'Agent Factory', url: 'https://example.com' }],
      durationMs: 42,
    });

    expect(completed?.status).toBe('done');
    expect(completed?.durationMs).toBe(42);
    expect(listToolExecutions({ executionId: execution.id })).toHaveLength(1);
  });
});
