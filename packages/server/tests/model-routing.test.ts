import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createExecution } from '../src/db/models/execution.js';
import { createTask } from '../src/db/models/task.js';
import {
  getModel,
  recordModelHealth,
  recordModelUsage,
  selectModelForAgent,
  syncBuiltinModels,
  updateModel,
  upsertModelRoute,
} from '../src/models/model-registry.js';

describe('model registry and routing', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-models-')), 'test.db');
    getDb();
    syncBuiltinModels();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('selects explicit enabled model before role route', () => {
    const agent = createAgent({
      id: 'model-agent',
      name: 'Model Agent',
      role: 'developer',
      model: 'openai/claude-sonnet-4.6',
    });

    const selection = selectModelForAgent(agent);

    expect(selection.modelId).toBe('openai/claude-sonnet-4.6');
    expect(selection.source).toBe('agent.model');
  });

  it('falls back to role route when requested model is disabled', () => {
    updateModel('openai/gpt-5.3-codex', { enabled: false });
    upsertModelRoute({
      routeKey: 'role:developer',
      defaultModelId: 'openai/gpt-5.2-codex',
      fallbackGroup: 'coding',
    });
    const agent = createAgent({
      id: 'coding-agent',
      name: 'Coding Agent',
      role: 'developer',
      model: 'openai/gpt-5.3-codex',
    });

    const selection = selectModelForAgent(agent);

    expect(selection.modelId).toBe('openai/gpt-5.2-codex');
    expect(selection.source).toBe('role.route');
    expect(selection.requestedModelId).toBe('openai/gpt-5.3-codex');
  });

  it('records health and usage stats', () => {
    const agent = createAgent({ id: 'usage-agent', name: 'Usage Agent', role: 'researcher' });
    const task = createTask({ title: 'Usage', description: 'Usage', mode: 'direct', input: 'run', assigneeId: agent.id });
    const execution = createExecution({ taskId: task.id, agentDefId: agent.id });

    const checked = recordModelHealth({ modelId: 'openai/claude-sonnet-4.6', status: 'healthy', latencyMs: 7 });
    recordModelUsage({
      modelId: 'openai/claude-sonnet-4.6',
      agentId: agent.id,
      taskId: task.id,
      executionId: execution.id,
      status: 'success',
      inputTokens: 11,
      outputTokens: 22,
      routeReason: 'test',
    });

    const usage = getDb().get('SELECT * FROM model_usage_stats WHERE execution_id = ?', execution.id) as any;
    expect(checked?.healthStatus).toBe('healthy');
    expect(getModel('openai/claude-sonnet-4.6')?.lastCheckedAt).toBeTruthy();
    expect(usage.output_tokens).toBe(22);
  });
});
