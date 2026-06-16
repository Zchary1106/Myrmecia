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
  listModels,
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
      model: 'claude-opus-4.8',
    });

    const selection = selectModelForAgent(agent);

    expect(selection.modelId).toBe('claude-opus-4.8');
    expect(selection.source).toBe('agent.model');
    expect(selection.modelTier).toBe('strong');
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
    updateModel('gpt-5.3-codex', { enabled: false });
    upsertModelRoute({
      routeKey: 'role:developer',
      defaultModelId: 'gpt-5.4',
      fallbackGroup: 'balanced',
    });
    const agent = createAgent({
      id: 'coding-agent',
      name: 'Coding Agent',
      role: 'developer',
      model: 'gpt-5.3-codex',
    });

    const selection = selectModelForAgent(agent);

    expect(selection.modelId).toBe('gpt-5.4');
    expect(selection.source).toBe('role.route');
    expect(selection.requestedModelId).toBe('gpt-5.3-codex');
  });

  it('uses per-agent fallback model before role route when pinned model is disabled', () => {
    updateModel('gpt-5.3-codex', { enabled: false });
    const agent = createAgent({
      id: 'fallback-agent',
      name: 'Fallback Agent',
      role: 'developer',
      model: 'gpt-5.3-codex',
      config: {
        modelPolicy: {
          tier: 'balanced',
          fallbackModel: 'gpt-5.4-mini',
        },
      },
    });

    const selection = selectModelForAgent(agent);

    expect(selection.modelId).toBe('gpt-5.4-mini');
    expect(selection.source).toBe('agent.config.modelPolicy');
    expect(selection.fallbackModelId).toBe('gpt-5.4-mini');
  });

  it('routes coding tasks to codex even when the agent default is cheap', () => {
    const agent = createAgent({
      id: 'task-coding-agent',
      name: 'Task Coding Agent',
      role: 'tester',
      model: 'gpt-5.4-mini',
    });

    const selection = selectModelForAgent(agent, {
      title: 'Fix failing TypeScript tests',
      description: 'Implement the missing API route and update the Vitest regression.',
      input: 'fix code in packages/server/src/routes/tasks.ts',
      mode: 'direct',
    });

    expect(selection.modelId).toBe('gpt-5.4');
    expect(selection.source).toBe('task.route');
    expect(selection.taskProfile).toBe('coding');
  });

  it('falls back within a task route before using an agent pinned model', () => {
    updateModel('gpt-5.4', { enabled: false });
    const agent = createAgent({
      id: 'task-route-fallback-agent',
      name: 'Task Route Fallback Agent',
      role: 'tester',
      model: 'gpt-5.4-mini',
    });

    const selection = selectModelForAgent(agent, {
      title: 'Fix API route',
      description: 'Implement TypeScript changes for a failing endpoint.',
      input: 'fix code',
      mode: 'direct',
    });

    expect(selection.modelId).toBe('gemini-3.1-pro-preview');
    expect(selection.source).toBe('task.route');
    expect(selection.fallbackModelId).toBe('gemini-3.1-pro-preview');
    expect(selection.reason).toContain('route default unavailable');
  });

  it('does not route ordinary auth implementation tasks to the strongest model', () => {
    const agent = createAgent({
      id: 'auth-fix-agent',
      name: 'Auth Fix Agent',
      role: 'developer',
      model: 'gpt-5.4-mini',
    });

    const selection = selectModelForAgent(agent, {
      title: 'Fix auth login bug',
      description: 'Implement a TypeScript fix for the login callback.',
      input: 'auth route bug fix',
      mode: 'direct',
    });

    expect(selection.modelId).toBe('gpt-5.4');
    expect(selection.taskProfile).toBe('coding');
  });

  it('routes explicit security reviews to the strongest model', () => {
    const agent = createAgent({
      id: 'security-task-agent',
      name: 'Security Task Agent',
      role: 'tester',
      model: 'gpt-5.4-mini',
    });

    const selection = selectModelForAgent(agent, {
      title: 'Security review for tenant isolation',
      description: 'Review sandbox escape and DLP leak risks.',
      input: 'security audit',
      mode: 'direct',
    });

    expect(selection.modelId).toBe('claude-opus-4.7');
    expect(selection.taskProfile).toBe('high-risk');
  });

  it('routes long-context tasks to the 1M context model', () => {
    const agent = createAgent({
      id: 'long-context-agent',
      name: 'Long Context Agent',
      role: 'documentation',
      model: 'claude-haiku-4.5',
    });

    const selection = selectModelForAgent(agent, {
      title: 'Analyze entire repo',
      description: 'Need long context over the whole repository.',
      input: 'entire repo '.repeat(1000),
      mode: 'direct',
    });

    expect(selection.modelId).toBe('gpt-5.4');
    expect(selection.source).toBe('task.route');
    expect(selection.taskProfile).toBe('long-context');
  });

  it('reroutes by actual prompt size after prompt construction', () => {
    const agent = createAgent({
      id: 'prompt-size-agent',
      name: 'Prompt Size Agent',
      role: 'documentation',
      model: 'claude-haiku-4.5',
    });

    const selection = selectModelForAgent(
      agent,
      { title: 'Summarize docs', description: 'Small visible task', input: 'summary', mode: 'direct' },
      { promptText: 'x'.repeat(700_000) },
    );

    expect(selection.modelId).toBe('gpt-5.4');
    expect(selection.taskProfile).toBe('long-context');
  });

  it('escalates repeated failed cheap tasks', () => {
    const agent = createAgent({
      id: 'retry-agent',
      name: 'Retry Agent',
      role: 'documentation',
      model: 'claude-haiku-4.5',
    });

    const firstRetry = selectModelForAgent(agent, {
      title: 'release notes summary',
      description: 'summarize release notes',
      input: 'summary',
      mode: 'direct',
      retryCount: 1,
    });
    const secondRetry = selectModelForAgent(agent, {
      title: 'release notes summary',
      description: 'summarize release notes',
      input: 'summary',
      mode: 'direct',
      retryCount: 2,
    });

    expect(firstRetry.modelId).toBe('gpt-5.4');
    expect(firstRetry.taskProfile).toBe('retry-escalation-balanced');
    expect(secondRetry.modelId).toBe('claude-opus-4.7');
    expect(secondRetry.taskProfile).toBe('retry-escalation-strong');
  });

  it('does not disable user-defined models when syncing builtin models', () => {
    getDb().run(`
      INSERT INTO model_registry (
        id, provider, display_name, description, capability_tags, cost_profile, fallback_group, enabled
      )
      VALUES (?, ?, ?, ?, '[]', '{}', ?, 1)
    `, 'custom-user-model', 'copilot-api', 'Custom User Model', 'Operator-managed model', 'balanced');

    syncBuiltinModels();

    expect(getModel('custom-user-model')?.enabled).toBe(true);
    expect(listModels({ enabled: true }).some(model => model.id === 'custom-user-model')).toBe(true);
  });

  it('records health and usage stats', () => {
    const agent = createAgent({ id: 'usage-agent', name: 'Usage Agent', role: 'researcher' });
    const task = createTask({ title: 'Usage', description: 'Usage', mode: 'direct', input: 'run', assigneeId: agent.id, workspaceId: 'ws-model' });
    const execution = createExecution({ taskId: task.id, agentDefId: agent.id });

    const checked = recordModelHealth({ modelId: 'gpt-5.4-mini', status: 'healthy', latencyMs: 7 });
    recordModelUsage({
      modelId: 'gpt-5.4-mini',
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
    expect(getModel('gpt-5.4-mini')?.lastCheckedAt).toBeTruthy();
    expect(usage.output_tokens).toBe(22);
    expect(usage.cost_usd).toBeGreaterThan(0);
    expect(usage.model_tier).toBe('balanced');
    expect(usage.route_source).toBe('agent.model');
    expect(usage.workspace_id).toBe('ws-model');
    expect(usage.pipeline_id).toBe('pipe_1');
    expect(usage.stage_index).toBe(2);
  });
});
