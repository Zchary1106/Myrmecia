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
import { resolveAgentRuntimeLimits } from '../src/agents/runtime-limits.js';

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
    expect(selection.modelTier).toBe('balanced');
  });

  it('selects a model by explicit agent tier when no model is pinned', () => {
    const agent = createAgent({
      id: 'cheap-agent',
      name: 'Cheap Agent',
      role: 'custom-role',
      config: {
        modelPolicy: {
          tier: 'cheap',
          maxTokens: 1000,
          maxResponseTokens: 250,
          maxToolCalls: 5,
          maxWallClockMs: 1500,
        },
      },
    });

    const selection = selectModelForAgent(agent);
    const limits = resolveAgentRuntimeLimits(agent, selection);

    expect(selection.modelTier).toBe('cheap');
    expect(selection.source).toBe('agent.config.modelPolicy');
    expect(limits.maxExecutionTokens).toBe(1000);
    expect(limits.maxModelResponseTokens).toBe(250);
    expect(limits.maxToolCallsPerExecution).toBe(5);
    expect(limits.maxExecutionWallClockMs).toBe(1500);
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

  it('uses per-agent fallback model before role route when pinned model is disabled', () => {
    updateModel('openai/gpt-5.3-codex', { enabled: false });
    const agent = createAgent({
      id: 'fallback-agent',
      name: 'Fallback Agent',
      role: 'developer',
      model: 'openai/gpt-5.3-codex',
      config: {
        modelPolicy: {
          tier: 'balanced',
          fallbackModel: 'openai/claude-haiku-4.5',
        },
      },
    });

    const selection = selectModelForAgent(agent);

    expect(selection.modelId).toBe('openai/claude-haiku-4.5');
    expect(selection.source).toBe('agent.config.modelPolicy');
    expect(selection.fallbackModelId).toBe('openai/claude-haiku-4.5');
  });

  it('records health and usage stats', () => {
    const agent = createAgent({ id: 'usage-agent', name: 'Usage Agent', role: 'researcher' });
    const task = createTask({ title: 'Usage', description: 'Usage', mode: 'direct', input: 'run', assigneeId: agent.id, workspaceId: 'ws-model' });
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
      modelTier: 'balanced',
      routeSource: 'agent.model',
      pipelineId: 'pipe_1',
      stageIndex: 2,
      routeReason: 'test',
    });

    const usage = getDb().get('SELECT * FROM model_usage_stats WHERE execution_id = ?', execution.id) as any;
    expect(checked?.healthStatus).toBe('healthy');
    expect(getModel('openai/claude-sonnet-4.6')?.lastCheckedAt).toBeTruthy();
    expect(usage.output_tokens).toBe(22);
    expect(usage.model_tier).toBe('balanced');
    expect(usage.route_source).toBe('agent.model');
    expect(usage.workspace_id).toBe('ws-model');
    expect(usage.pipeline_id).toBe('pipe_1');
    expect(usage.stage_index).toBe(2);
  });
});
