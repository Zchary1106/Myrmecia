import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTaskRoutes } from '../src/routes/tasks.js';
import { createPipelineRoutes } from '../src/routes/pipelines.js';
import { createSystemRoutes } from '../src/routes/system.js';
import { createAgentRoutes } from '../src/routes/agents.js';
import { createToolRoutes } from '../src/routes/tools.js';
import { createModelRoutes } from '../src/routes/models.js';
import { createSkillRoutes } from '../src/routes/skills.js';
import { createTemplateRoutes } from '../src/routes/templates.js';
import { createApiAuthMiddleware } from '../src/auth/token-auth.js';
import { createTask, updateTask } from '../src/db/models/task.js';
import { createInboxEntry } from '../src/db/models/inbox.js';
import { createAgent } from '../src/db/models/agent.js';
import { getDb } from '../src/db/database.js';
import { syncBuiltinTools } from '../src/tools/tool-registry.js';
import { syncBuiltinModels } from '../src/models/model-registry.js';
import type { TaskQueue } from '../src/queue/task-queue.js';
import type { PipelineEngine } from '../src/pipelines/pipeline-engine.js';

beforeAll(() => {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-routes-')), 'test.db');
});

afterEach(() => {
  const db = getDb();
  db.exec(`
    DELETE FROM operator_actions;
    DELETE FROM operator_preferences;
    DELETE FROM model_usage_stats;
    DELETE FROM model_health_checks;
    DELETE FROM model_routes;
    DELETE FROM model_registry;
    DELETE FROM tool_permissions;
    DELETE FROM tool_executions;
    DELETE FROM skill_assignments;
    DELETE FROM trace_spans;
    DELETE FROM run_traces;
    DELETE FROM execution_messages;
    DELETE FROM task_executions;
    DELETE FROM skill_versions;
    DELETE FROM skills;
    DELETE FROM inbox_entries;
    DELETE FROM quality_loop_attempts;
    DELETE FROM platform_events;
    DELETE FROM task_logs;
    DELETE FROM tasks;
    DELETE FROM pipeline_templates;
    DELETE FROM agents;
    UPDATE tools SET enabled = 1, approval_required = 0;
  `);
  vi.restoreAllMocks();
  delete process.env.API_AUTH_TOKEN;
});

async function withApp<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind test server');
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

async function jsonFetch<T>(baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
  });
  return { status: res.status, body: await res.json() as T };
}

describe('control routes', () => {
  it('cancels a task through the task control API', async () => {
    const task = createTask({
      title: 'Cancelable',
      description: 'Cancelable',
      input: 'run',
      mode: 'direct',
    });
    const cancelTask = vi.fn(async (taskId: string) => updateTask(taskId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    })!);
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes({ cancelTask } as unknown as TaskQueue));

    await withApp(app, async (baseUrl) => {
      const { status, body } = await jsonFetch<any>(baseUrl, `/tasks/${task.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      });
      expect(status).toBe(200);
      expect(body.status).toBe('cancelled');
      expect(cancelTask).toHaveBeenCalledWith(task.id);
    });
  });

  it('requires confirmation before cancelling a task', async () => {
    const task = createTask({
      title: 'Needs confirmation',
      description: 'Needs confirmation',
      input: 'run',
      mode: 'direct',
    });
    const cancelTask = vi.fn();
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes({ cancelTask } as unknown as TaskQueue));

    await withApp(app, async (baseUrl) => {
      const { status, body } = await jsonFetch<any>(baseUrl, `/tasks/${task.id}/cancel`, { method: 'POST' });
      expect(status).toBe(409);
      expect(body.error.code).toBe('CONFIRMATION_REQUIRED');
      expect(cancelTask).not.toHaveBeenCalled();
    });
  });

  it('retries a failed task through the task control API', async () => {
    const task = createTask({
      title: 'Retryable',
      description: 'Retryable',
      input: 'run',
      mode: 'direct',
    });
    updateTask(task.id, { status: 'failed', retryCount: 1, error: 'boom', completedAt: new Date().toISOString() });
    const retryTask = vi.fn(async (taskId: string) => updateTask(taskId, {
      status: 'pending',
      retryCount: 2,
      error: null,
      completedAt: null,
    })!);
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes({ retryTask } as unknown as TaskQueue));

    await withApp(app, async (baseUrl) => {
      const { status, body } = await jsonFetch<any>(baseUrl, `/tasks/${task.id}/retry`, { method: 'POST' });
      expect(status).toBe(200);
      expect(body.status).toBe('pending');
      expect(body.retryCount).toBe(2);
      expect(retryTask).toHaveBeenCalledWith(task.id);
    });
  });

  it('returns a not-found response before invoking task controls', async () => {
    const cancelTask = vi.fn();
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes({ cancelTask } as unknown as TaskQueue));

    await withApp(app, async (baseUrl) => {
      const { status, body } = await jsonFetch<any>(baseUrl, '/tasks/missing/cancel', { method: 'POST' });
      expect(status).toBe(404);
      expect(body.error.code).toBe('TASK_NOT_FOUND');
      expect(cancelTask).not.toHaveBeenCalled();
    });
  });

  it('exposes quality-loop attempt history for a task', async () => {
    const task = createTask({
      title: 'Quality task',
      description: 'Quality task',
      input: 'run',
      mode: 'pipeline',
    });
    getDb().prepare(`
      INSERT INTO quality_loop_attempts (id, task_id, iteration, status, review_output)
      VALUES (?, ?, ?, ?, ?)
    `).run('ql-route-1', task.id, 1, 'approved', 'APPROVED');
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes({} as unknown as TaskQueue));

    await withApp(app, async (baseUrl) => {
      const { status, body } = await jsonFetch<any[]>(baseUrl, `/tasks/${task.id}/quality-attempts`);
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].status).toBe('approved');
      expect(body[0].reviewOutput).toBe('APPROVED');
    });
  });

  it('dispatches pipeline approve, skip, and cancel controls', async () => {
    const engine = {
      approveGate: vi.fn(async () => undefined),
      skipStage: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };
    const app = express();
    app.use(express.json());
    app.use('/pipelines', createPipelineRoutes(engine as unknown as PipelineEngine));

    await withApp(app, async (baseUrl) => {
      await expect(jsonFetch(baseUrl, '/pipelines/pipe1/approve', { method: 'POST' }))
        .resolves.toMatchObject({ status: 200, body: { success: true } });
      await expect(jsonFetch(baseUrl, '/pipelines/pipe1/skip', { method: 'POST' }))
        .resolves.toMatchObject({ status: 200, body: { success: true } });
      await expect(jsonFetch(baseUrl, '/pipelines/pipe1/cancel', {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      }))
        .resolves.toMatchObject({ status: 200, body: { success: true } });

      expect(engine.approveGate).toHaveBeenCalledWith('pipe1');
      expect(engine.skipStage).toHaveBeenCalledWith('pipe1');
      expect(engine.cancel).toHaveBeenCalledWith('pipe1');
    });
  });

  it('validates task and pipeline inputs consistently', async () => {
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes({} as unknown as TaskQueue));
    app.use('/pipelines', createPipelineRoutes({} as unknown as PipelineEngine));

    await withApp(app, async (baseUrl) => {
      const taskResult = await jsonFetch<any>(baseUrl, '/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: '', mode: 'unknown' }),
      });
      expect(taskResult.status).toBe(400);
      expect(taskResult.body.error.code).toBe('VALIDATION_FAILED');

      const pipelineResult = await jsonFetch<any>(baseUrl, '/pipelines?status=unknown');
      expect(pipelineResult.status).toBe(400);
      expect(pipelineResult.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  it('validates, guards, and audits template builder controls', async () => {
    createAgent({ id: 'builder-dev', name: 'Builder Dev', role: 'developer' });
    const app = express();
    app.use(express.json());
    app.use('/templates', createTemplateRoutes());

    await withApp(app, async (baseUrl) => {
      const invalid = await jsonFetch<any>(baseUrl, '/templates/validate', {
        method: 'POST',
        body: JSON.stringify({ name: 'Invalid', stages: [{ name: '', role: 'missing-role', promptTemplate: '' }] }),
      });
      expect(invalid.status).toBe(200);
      expect(invalid.body.valid).toBe(false);

      const validation = await jsonFetch<any>(baseUrl, '/templates/validate', {
        method: 'POST',
        body: JSON.stringify({ name: 'Validate', stages: [{ name: 'Build', role: 'missing-role', promptTemplate: 'Use {input}' }] }),
      });
      expect(validation.status).toBe(200);
      expect(validation.body.valid).toBe(false);
      expect(validation.body.errors[0].message).toContain('No available Agent');

      const denied = await jsonFetch<any>(baseUrl, '/templates', {
        method: 'POST',
        body: JSON.stringify({ name: 'Denied', stages: [{ name: 'Build', role: 'developer', promptTemplate: 'Use {input}' }] }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(denied.status).toBe(403);

      const created = await jsonFetch<any>(baseUrl, '/templates', {
        method: 'POST',
        body: JSON.stringify({ name: 'Builder', stages: [{ name: 'Build', role: 'developer', promptTemplate: 'Use {input}' }] }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(created.status).toBe(201);

      const updated = await jsonFetch<any>(baseUrl, `/templates/${created.body.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: 'Updated in builder' }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(updated.status).toBe(200);
      expect(updated.body.description).toBe('Updated in builder');

      const actions = getDb().prepare(`
        SELECT action, target_type FROM operator_actions ORDER BY id ASC
      `).all() as any[];
      expect(actions.map(action => action.action)).toEqual(['template.create', 'template.update']);
      expect(actions.every(action => action.target_type === 'template')).toBe(true);
    });
  });

  it('denies viewer launch requests before creating tasks or pipelines', async () => {
    const enqueue = vi.fn();
    const engine = { create: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes({ enqueue } as unknown as TaskQueue));
    app.use('/pipelines', createPipelineRoutes(engine as unknown as PipelineEngine));

    await withApp(app, async (baseUrl) => {
      const taskResult = await jsonFetch<any>(baseUrl, '/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: 'Read only launch', mode: 'direct', input: 'run' }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(taskResult.status).toBe(403);
      expect(taskResult.body.error.code).toBe('OPERATOR_FORBIDDEN');
      expect(enqueue).not.toHaveBeenCalled();

      const pipelineResult = await jsonFetch<any>(baseUrl, '/pipelines', {
        method: 'POST',
        body: JSON.stringify({ name: 'Read only pipeline', templateId: 'tmpl1', input: 'run' }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(pipelineResult.status).toBe(403);
      expect(pipelineResult.body.error.code).toBe('OPERATOR_FORBIDDEN');
      expect(engine.create).not.toHaveBeenCalled();
    });
  });

  it('allows operators to launch tasks and pipelines', async () => {
    const task = createTask({
      title: 'Launched task',
      description: 'Launched task',
      input: 'run',
      mode: 'direct',
    });
    const enqueue = vi.fn(async () => task);
    const pipeline = {
      id: 'pipe1',
      name: 'Launched pipeline',
      status: 'running',
      stages: [],
      currentStageIndex: 0,
      gateMode: 'auto',
      input: 'run',
      createdAt: new Date().toISOString(),
    };
    const engine = { create: vi.fn(async () => pipeline) };
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes({ enqueue } as unknown as TaskQueue));
    app.use('/pipelines', createPipelineRoutes(engine as unknown as PipelineEngine));

    await withApp(app, async (baseUrl) => {
      const taskResult = await jsonFetch<any>(baseUrl, '/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: 'Launch task', mode: 'direct', input: 'run', assigneeId: 'agent_dev' }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(taskResult.status).toBe(201);
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Launch task',
        mode: 'direct',
        assigneeId: 'agent_dev',
      }));

      const pipelineResult = await jsonFetch<any>(baseUrl, '/pipelines', {
        method: 'POST',
        body: JSON.stringify({ name: 'Launch pipeline', templateId: 'tmpl1', input: 'run', gateMode: 'manual' }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(pipelineResult.status).toBe(201);
      expect(engine.create).toHaveBeenCalledWith({
        name: 'Launch pipeline',
        templateId: 'tmpl1',
        input: 'run',
        gateMode: 'manual',
      });
    });
  });

  it('guards and audits agent create, update, and execute controls', async () => {
    const queuedTask = createTask({
      title: 'Queued by agent',
      description: 'Queued by agent',
      mode: 'direct',
      input: 'run',
    });
    const enqueue = vi.fn(async () => queuedTask);
    const app = express();
    app.use(express.json());
    app.use('/agents', createAgentRoutes({ enqueue } as unknown as TaskQueue));

    await withApp(app, async (baseUrl) => {
      const deniedCreate = await jsonFetch<any>(baseUrl, '/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Denied', role: 'custom' }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(deniedCreate.status).toBe(403);
      expect(deniedCreate.body.error.code).toBe('OPERATOR_FORBIDDEN');

      const created = await jsonFetch<any>(baseUrl, '/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Research Agent', role: 'researcher', allowedTools: ['web.search'] }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe('Research Agent');

      const deniedUpdate = await jsonFetch<any>(baseUrl, `/agents/${created.body.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: 'blocked' }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(deniedUpdate.status).toBe(403);

      const updated = await jsonFetch<any>(baseUrl, `/agents/${created.body.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: 'Can research current information' }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(updated.status).toBe(200);
      expect(updated.body.description).toBe('Can research current information');

      const deniedExecute = await jsonFetch<any>(baseUrl, `/agents/${created.body.id}/execute`, {
        method: 'POST',
        body: JSON.stringify({ prompt: 'run' }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(deniedExecute.status).toBe(403);
      expect(enqueue).not.toHaveBeenCalled();

      const executed = await jsonFetch<any>(baseUrl, `/agents/${created.body.id}/execute`, {
        method: 'POST',
        body: JSON.stringify({ prompt: 'run research', priority: 'high' }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(executed.status).toBe(200);
      expect(executed.body.taskId).toBe(queuedTask.id);

      const actions = getDb().prepare(`
        SELECT action, target_type, target_id, task_id FROM operator_actions ORDER BY id ASC
      `).all() as any[];
      expect(actions.map(action => action.action)).toEqual(['agent.create', 'agent.update', 'agent.execute']);
      expect(actions.every(action => action.target_type === 'agent')).toBe(true);
      expect(actions[2].task_id).toBe(queuedTask.id);
    });
  });

  it('guards and audits tool policy controls', async () => {
    syncBuiltinTools();
    const agent = createAgent({ id: 'tool-route-agent', name: 'Tool Route Agent', role: 'researcher' });
    const app = express();
    app.use(express.json());
    app.use('/tools', createToolRoutes());

    await withApp(app, async (baseUrl) => {
      const denied = await jsonFetch<any>(baseUrl, '/tools/web.search', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(denied.status).toBe(403);

      const updated = await jsonFetch<any>(baseUrl, '/tools/web.search', {
        method: 'PATCH',
        body: JSON.stringify({ approvalRequired: true }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(updated.status).toBe(200);
      expect(updated.body.approvalRequired).toBe(true);

      const permission = await jsonFetch<any>(baseUrl, `/tools/web.search/permissions/${agent.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: true, approvalRequired: false }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(permission.status).toBe(200);
      expect(permission.body.agentId).toBe(agent.id);

      const actions = getDb().prepare(`
        SELECT action, target_type, target_id, metadata FROM operator_actions ORDER BY id ASC
      `).all() as any[];
      expect(actions.map(action => action.action)).toEqual(['tool.update', 'tool.permission.update']);
      expect(actions.every(action => action.target_type === 'tool')).toBe(true);
      expect(JSON.parse(actions[1].metadata).agentId).toBe(agent.id);
    });
  });

  it('guards and audits model registry controls', async () => {
    syncBuiltinModels();
    const app = express();
    app.use(express.json());
    app.use('/models', createModelRoutes());

    await withApp(app, async (baseUrl) => {
      const listed = await jsonFetch<any[]>(baseUrl, '/models?enabled=true');
      expect(listed.status).toBe(200);
      expect(listed.body.some(model => model.id === 'openai/claude-sonnet-4.6')).toBe(true);

      const sonnetId = encodeURIComponent('openai/claude-sonnet-4.6');
      const denied = await jsonFetch<any>(baseUrl, `/models/${sonnetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(denied.status).toBe(403);

      const updated = await jsonFetch<any>(baseUrl, `/models/${sonnetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(updated.status).toBe(200);
      expect(updated.body.enabled).toBe(false);

      const route = await jsonFetch<any>(baseUrl, '/models/routes', {
        method: 'PATCH',
        body: JSON.stringify({ routeKey: 'role:developer', defaultModelId: 'openai/gpt-5.2-codex', fallbackGroup: 'coding' }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(route.status).toBe(200);
      expect(route.body.defaultModelId).toBe('openai/gpt-5.2-codex');

      const actions = getDb().prepare(`
        SELECT action, target_type, target_id FROM operator_actions ORDER BY id ASC
      `).all() as any[];
      expect(actions.map(action => action.action)).toEqual(['model.update', 'model.route.update']);
      expect(actions.every(action => action.target_type === 'model')).toBe(true);
    });
  });

  it('guards and audits skill versioning controls', async () => {
    const agent = createAgent({ id: 'skill-route-agent', name: 'Skill Route Agent', role: 'writer' });
    const app = express();
    app.use(express.json());
    app.use('/skills', createSkillRoutes());

    await withApp(app, async (baseUrl) => {
      const deniedCreate = await jsonFetch<any>(baseUrl, '/skills', {
        method: 'POST',
        body: JSON.stringify({ id: 'writer', name: 'Writer' }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(deniedCreate.status).toBe(403);

      const created = await jsonFetch<any>(baseUrl, '/skills', {
        method: 'POST',
        body: JSON.stringify({ id: 'writer', name: 'Writer' }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(created.status).toBe(201);

      const version = await jsonFetch<any>(baseUrl, '/skills/writer/versions', {
        method: 'POST',
        body: JSON.stringify({ content: '# Writer\n\nDraft', changelog: 'initial', status: 'draft' }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(version.status).toBe(201);
      expect(version.body.status).toBe('draft');

      const published = await jsonFetch<any>(baseUrl, `/skills/versions/${version.body.id}/publish`, {
        method: 'POST',
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(published.status).toBe(200);
      expect(published.body.status).toBe('published');

      const assigned = await jsonFetch<any>(baseUrl, `/skills/assignments/${agent.id}`, {
        method: 'PUT',
        body: JSON.stringify({ skillVersionId: published.body.id }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(assigned.status).toBe(200);
      expect(assigned.body.skillVersionId).toBe(published.body.id);

      const actions = getDb().prepare(`
        SELECT action, target_type, target_id FROM operator_actions ORDER BY id ASC
      `).all() as any[];
      expect(actions.map(action => action.action)).toEqual([
        'skill.create',
        'skill.version.create',
        'skill.version.publish',
        'skill.assignment.update',
      ]);
      expect(actions.every(action => action.target_type === 'skill')).toBe(true);
    });
  });

  it('validates inbox creation and response inputs', async () => {
    const app = express();
    app.use(express.json());
    app.use('/', createSystemRoutes());

    await withApp(app, async (baseUrl) => {
      const createResult = await jsonFetch<any>(baseUrl, '/inbox', {
        method: 'POST',
        body: JSON.stringify({ type: 'unknown', title: '', message: '' }),
      });
      expect(createResult.status).toBe(400);
      expect(createResult.body.error.code).toBe('VALIDATION_FAILED');

      const eventsResult = await jsonFetch<any>(baseUrl, '/events?severity=critical');
      expect(eventsResult.status).toBe(400);
      expect(eventsResult.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  it('returns durable events and observability summaries', async () => {
    const task = createTask({
      title: 'Failed task',
      description: 'Failed task',
      input: 'run',
      mode: 'direct',
    });
    updateTask(task.id, { status: 'failed', retryCount: 2, error: 'boom' });
    getDb().prepare(`
      INSERT INTO platform_events (event_type, severity, task_id, payload)
      VALUES (?, ?, ?, ?)
    `).run('task:failed', 'error', task.id, '{"error":"boom"}');

    const app = express();
    app.use(express.json());
    app.use('/', createSystemRoutes());

    await withApp(app, async (baseUrl) => {
      const events = await jsonFetch<any[]>(baseUrl, '/events?severity=error');
      expect(events.status).toBe(200);
      expect(events.body).toHaveLength(1);
      expect(events.body[0].taskId).toBe(task.id);

      const summary = await jsonFetch<any>(baseUrl, '/observability');
      expect(summary.status).toBe(200);
      expect(summary.body.totals.failedTasks).toBe(1);
      expect(summary.body.totals.retriedTasks).toBe(1);
      expect(summary.body.failureHotspots[0].taskId).toBe(task.id);
    });
  });

  it('returns sanitized runtime diagnostics', async () => {
    const app = express();
    app.use(express.json());
    app.use('/', createSystemRoutes());

    await withApp(app, async (baseUrl) => {
      const result = await jsonFetch<any>(baseUrl, '/diagnostics');
      expect(result.status).toBe(200);
      expect(result.body.auth).toMatchObject({ enabled: false, mode: 'local' });
      expect(result.body.operator.actor).toMatchObject({ id: 'local-admin', role: 'admin', source: 'local' });
      expect(result.body.operator.permissions).toMatchObject({ canControlRuntime: true, canDeleteTasks: true });
      expect(result.body.queue.backend).toMatch(/memory|redis/);
      expect(result.body.database.pathHint).toBeTruthy();
      expect(result.body.database).not.toHaveProperty('path');
      expect(result.body.database.migrations.length).toBeGreaterThan(0);
      expect(result.body.runtime.nodeVersion).toMatch(/^v/);
    });
  });

  it('returns current proxy operator diagnostics', async () => {
    const app = express();
    app.use(express.json());
    app.use('/', createSystemRoutes());

    await withApp(app, async (baseUrl) => {
      const result = await jsonFetch<any>(baseUrl, '/diagnostics', {
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(result.status).toBe(200);
      expect(result.body.operator.actor).toMatchObject({ id: 'viewer1', role: 'viewer', source: 'proxy' });
      expect(result.body.operator.permissions).toMatchObject({ canControlRuntime: false, canDeleteTasks: false });
    });
  });

  it('records and lists operator actions', async () => {
    const task = createTask({
      title: 'Audited cancel',
      description: 'Audited cancel',
      input: 'run',
      mode: 'direct',
    });
    const cancelTask = vi.fn(async (taskId: string) => updateTask(taskId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    })!);
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes({ cancelTask } as unknown as TaskQueue));
    app.use('/', createSystemRoutes());

    await withApp(app, async (baseUrl) => {
      const cancelResult = await jsonFetch<any>(baseUrl, `/tasks/${task.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
        headers: { 'Content-Type': 'application/json', 'x-operator-id': 'alice', 'x-operator-role': 'operator' },
      });
      expect(cancelResult.status).toBe(200);

      const result = await jsonFetch<any[]>(baseUrl, `/operator-actions?taskId=${task.id}`);
      expect(result.status).toBe(200);
      expect(result.body).toHaveLength(1);
      expect(result.body[0].action).toBe('task.cancel');
      expect(result.body[0].actor).toMatchObject({ id: 'alice', role: 'operator', source: 'proxy' });
      expect(result.body[0].metadata.previousStatus).toBe('pending');
    });
  });

  it('stores operator preferences scoped to the current actor', async () => {
    const app = express();
    app.use(express.json());
    app.use('/', createSystemRoutes());

    await withApp(app, async (baseUrl) => {
      const save = await jsonFetch<any>(baseUrl, '/operator-preferences/savedViews/work-queue', {
        method: 'PUT',
        body: JSON.stringify({ value: [{ id: 'view1', name: 'Mine', filters: { status: 'failed' } }] }),
        headers: { 'x-operator-id': 'alice', 'x-operator-role': 'operator' },
      });
      expect(save.status).toBe(200);
      expect(save.body.actor).toMatchObject({ id: 'alice', role: 'operator', source: 'proxy' });
      expect(save.body.value[0].name).toBe('Mine');

      const own = await jsonFetch<any>(baseUrl, '/operator-preferences/savedViews/work-queue', {
        headers: { 'x-operator-id': 'alice', 'x-operator-role': 'operator' },
      });
      expect(own.status).toBe(200);
      expect(own.body.value[0].filters.status).toBe('failed');

      const other = await jsonFetch<any>(baseUrl, '/operator-preferences/savedViews/work-queue', {
        headers: { 'x-operator-id': 'bob', 'x-operator-role': 'operator' },
      });
      expect(other.status).toBe(404);
      expect(other.body.error.code).toBe('PREFERENCE_NOT_FOUND');

      const listed = await jsonFetch<any[]>(baseUrl, '/operator-preferences?namespace=savedViews', {
        headers: { 'x-operator-id': 'alice', 'x-operator-role': 'operator' },
      });
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
    });
  });

  it('exports sanitized workspace snapshots and previews import shape', async () => {
    process.env.API_AUTH_TOKEN = 'very-secret-token';
    const task = createTask({
      title: 'Snapshot task',
      description: 'Snapshot task',
      input: 'run',
      mode: 'direct',
    });
    const app = express();
    app.use(express.json());
    app.use('/', createSystemRoutes());

    await withApp(app, async (baseUrl) => {
      const preference = await jsonFetch<any>(baseUrl, '/operator-preferences/savedViews/work-queue', {
        method: 'PUT',
        body: JSON.stringify({
          value: {
            name: 'Sensitive view',
            apiToken: 'very-secret-token',
            nested: { password: 'do-not-export', label: 'safe' },
          },
        }),
        headers: { 'x-operator-id': 'alice', 'x-operator-role': 'operator' },
      });
      expect(preference.status).toBe(200);

      const snapshot = await jsonFetch<any>(baseUrl, '/workspace-snapshot', {
        headers: { 'x-operator-id': 'alice', 'x-operator-role': 'operator' },
      });
      expect(snapshot.status).toBe(200);
      expect(snapshot.body.generatedBy).toMatchObject({ id: 'alice', role: 'operator', source: 'proxy' });
      expect(snapshot.body.redaction).toMatchObject({ secrets: 'excluded', diagnostics: 'sanitized' });
      expect(snapshot.body.data.tasks.some((item: any) => item.id === task.id)).toBe(true);
      expect(snapshot.body.data.preferences[0].value.apiToken).toBe('[REDACTED]');
      expect(snapshot.body.data.preferences[0].value.nested.password).toBe('[REDACTED]');
      expect(JSON.stringify(snapshot.body)).not.toContain('very-secret-token');
      expect(snapshot.body).not.toHaveProperty('diagnostics');

      const preview = await jsonFetch<any>(baseUrl, '/workspace-snapshot/preview', {
        method: 'POST',
        body: JSON.stringify(snapshot.body),
      });
      expect(preview.status).toBe(200);
      expect(preview.body.valid).toBe(true);
      expect(preview.body.counts.tasks).toBeGreaterThanOrEqual(1);
      expect(preview.body.counts.preferences).toBe(1);
    });
  });

  it('generates restore plans with conflicts without mutating state', async () => {
    const existing = createTask({
      title: 'Existing task',
      description: 'Existing task',
      input: 'run',
      mode: 'direct',
    });
    const app = express();
    app.use(express.json());
    app.use('/', createSystemRoutes());

    await withApp(app, async (baseUrl) => {
      const before = getDb().prepare('SELECT COUNT(*) AS count FROM tasks').get() as any;
      const snapshot = {
        version: 1,
        generatedAt: new Date().toISOString(),
        generatedBy: { id: 'source', role: 'operator', source: 'proxy' },
        data: {
          tasks: [
            { ...existing },
            {
              id: 'task_import_new',
              title: 'New imported task',
              description: 'New imported task',
              mode: 'direct',
              status: 'pending',
              priority: 'normal',
              createdBy: 'user',
              input: 'run',
              retryCount: 0,
              maxRetries: 2,
              dependsOn: [],
              createdAt: new Date().toISOString(),
            },
            {
              id: 'task_import_conflict',
              title: 'Missing dep',
              description: 'Missing dep',
              mode: 'direct',
              status: 'pending',
              priority: 'normal',
              createdBy: 'user',
              input: 'run',
              retryCount: 0,
              maxRetries: 2,
              dependsOn: ['task_missing_dependency'],
              createdAt: new Date().toISOString(),
            },
          ],
          pipelines: [],
          inboxEntries: [],
          notifications: [],
          platformEvents: [],
          preferences: [],
        },
      };

      const plan = await jsonFetch<any>(baseUrl, '/workspace-snapshot/restore-plan', {
        method: 'POST',
        body: JSON.stringify(snapshot),
      });
      expect(plan.status).toBe(200);
      expect(plan.body.summary).toMatchObject({ create: 1, skip: 1, conflict: 1 });
      expect(plan.body.valid).toBe(false);
      expect(plan.body.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'skip', resourceType: 'task', resourceId: existing.id }),
        expect.objectContaining({ type: 'create', resourceType: 'task', resourceId: 'task_import_new' }),
        expect.objectContaining({
          type: 'conflict',
          resourceType: 'task',
          resourceId: 'task_import_conflict',
          dependencies: ['task:task_missing_dependency'],
        }),
      ]));

      const after = getDb().prepare('SELECT COUNT(*) AS count FROM tasks').get() as any;
      expect(after.count).toBe(before.count);
      expect(getDb().prepare('SELECT id FROM tasks WHERE id = ?').get('task_import_new')).toBeUndefined();
    });
  });

  it('restores only confirmed current-operator preferences and audits the action', async () => {
    const existing = createTask({
      title: 'Do not restore task',
      description: 'Do not restore task',
      input: 'run',
      mode: 'direct',
    });
    const app = express();
    app.use(express.json());
    app.use('/', createSystemRoutes());

    await withApp(app, async (baseUrl) => {
      const snapshot = {
        version: 1,
        generatedAt: new Date().toISOString(),
        generatedBy: { id: 'source', role: 'operator', source: 'proxy' },
        data: {
          tasks: [
            {
              id: 'task_should_not_restore',
              title: 'Should not restore',
              description: 'Should not restore',
              mode: 'direct',
              status: 'pending',
              priority: 'normal',
              createdBy: 'user',
              input: 'run',
              retryCount: 0,
              maxRetries: 2,
              dependsOn: [],
              createdAt: new Date().toISOString(),
            },
          ],
          pipelines: [],
          inboxEntries: [],
          notifications: [],
          platformEvents: [],
          preferences: [
            {
              namespace: 'savedViews',
              key: 'work-queue',
              value: [{ id: 'view1', name: 'Imported', filters: { status: 'failed' } }],
            },
            {
              namespace: 'secrets',
              key: 'token',
              value: { apiToken: '[REDACTED]' },
            },
          ],
        },
      };

      const missingConfirmation = await jsonFetch<any>(baseUrl, '/workspace-snapshot/restore-preferences', {
        method: 'POST',
        body: JSON.stringify({ snapshot }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(missingConfirmation.status).toBe(409);
      expect(missingConfirmation.body.error.code).toBe('CONFIRMATION_REQUIRED');

      const restored = await jsonFetch<any>(baseUrl, '/workspace-snapshot/restore-preferences', {
        method: 'POST',
        body: JSON.stringify({ snapshot, confirm: true }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(restored.status).toBe(200);
      expect(restored.body.actor).toMatchObject({ id: 'viewer1', role: 'viewer', source: 'proxy' });
      expect(restored.body.restored).toBe(1);
      expect(restored.body.skipped).toBe(1);
      expect(restored.body.failed).toBe(0);
      expect(restored.body.auditActionId).toBeGreaterThan(0);

      const storedPreference = getDb().prepare(`
        SELECT value FROM operator_preferences
        WHERE actor_id = ? AND actor_role = ? AND actor_source = ? AND namespace = ? AND key = ?
      `).get('viewer1', 'viewer', 'proxy', 'savedViews', 'work-queue') as any;
      expect(JSON.parse(storedPreference.value)[0].name).toBe('Imported');

      const skippedSecret = getDb().prepare(`
        SELECT value FROM operator_preferences
        WHERE actor_id = ? AND actor_role = ? AND actor_source = ? AND namespace = ? AND key = ?
      `).get('viewer1', 'viewer', 'proxy', 'secrets', 'token');
      expect(skippedSecret).toBeUndefined();

      expect(getDb().prepare('SELECT id FROM tasks WHERE id = ?').get(existing.id)).toBeTruthy();
      expect(getDb().prepare('SELECT id FROM tasks WHERE id = ?').get('task_should_not_restore')).toBeUndefined();

      const audit = await jsonFetch<any[]>(baseUrl, '/operator-actions?action=workspace.restore.preferences', {
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(audit.status).toBe(200);
      expect(audit.body[0].actor).toMatchObject({ id: 'viewer1', role: 'viewer', source: 'proxy' });
      expect(audit.body[0].metadata).toMatchObject({ restored: 1, skipped: 1, failed: 0 });
    });
  });

  it('denies viewer task controls before invoking the queue', async () => {
    const task = createTask({
      title: 'Viewer denied',
      description: 'Viewer denied',
      input: 'run',
      mode: 'direct',
    });
    const cancelTask = vi.fn();
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes({ cancelTask } as unknown as TaskQueue));

    await withApp(app, async (baseUrl) => {
      const result = await jsonFetch<any>(baseUrl, `/tasks/${task.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('OPERATOR_FORBIDDEN');
      expect(result.body.error.details.actor).toMatchObject({ id: 'viewer1', role: 'viewer', source: 'proxy' });
      expect(cancelTask).not.toHaveBeenCalled();
      const actions = getDb().prepare('SELECT COUNT(*) AS count FROM operator_actions').get() as any;
      expect(actions.count).toBe(0);
    });
  });

  it('allows operators to run task controls but keeps delete admin-only', async () => {
    const task = createTask({
      title: 'Operator scoped',
      description: 'Operator scoped',
      input: 'run',
      mode: 'direct',
    });
    updateTask(task.id, { status: 'failed', completedAt: new Date().toISOString() });
    const retryTask = vi.fn(async (taskId: string) => updateTask(taskId, {
      status: 'pending',
      retryCount: 1,
      completedAt: null,
    })!);
    const app = express();
    app.use(express.json());
    app.use('/tasks', createTaskRoutes({ retryTask } as unknown as TaskQueue));

    await withApp(app, async (baseUrl) => {
      const retry = await jsonFetch<any>(baseUrl, `/tasks/${task.id}/retry`, {
        method: 'POST',
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(retry.status).toBe(200);
      expect(retryTask).toHaveBeenCalledWith(task.id);

      const deleted = await jsonFetch<any>(baseUrl, `/tasks/${task.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
        headers: { 'x-operator-id': 'ops1', 'x-operator-role': 'operator' },
      });
      expect(deleted.status).toBe(403);
      expect(deleted.body.error.code).toBe('OPERATOR_FORBIDDEN');
      expect(getDb().prepare('SELECT id FROM tasks WHERE id = ?').get(task.id)).toBeTruthy();
    });
  });

  it('denies viewer pipeline controls', async () => {
    const engine = {
      approveGate: vi.fn(async () => undefined),
      skipStage: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };
    const app = express();
    app.use(express.json());
    app.use('/pipelines', createPipelineRoutes(engine as unknown as PipelineEngine));

    await withApp(app, async (baseUrl) => {
      const result = await jsonFetch<any>(baseUrl, '/pipelines/pipe1/approve', {
        method: 'POST',
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('OPERATOR_FORBIDDEN');
      expect(engine.approveGate).not.toHaveBeenCalled();
    });
  });

  it('denies viewer inbox responses', async () => {
    const entry = createInboxEntry({
      type: 'approval',
      title: 'Approve deploy',
      message: 'Should this deploy proceed?',
      options: ['yes', 'no'],
    });
    const app = express();
    app.use(express.json());
    app.use('/', createSystemRoutes());

    await withApp(app, async (baseUrl) => {
      const result = await jsonFetch<any>(baseUrl, `/inbox/${entry.id}/respond`, {
        method: 'POST',
        body: JSON.stringify({ status: 'approved' }),
        headers: { 'x-operator-id': 'viewer1', 'x-operator-role': 'viewer' },
      });
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('OPERATOR_FORBIDDEN');
      const stored = getDb().prepare('SELECT status FROM inbox_entries WHERE id = ?').get(entry.id) as any;
      expect(stored.status).toBe('pending');
    });
  });

  it('protects API routes when API_AUTH_TOKEN is configured', async () => {
    process.env.API_AUTH_TOKEN = 'secret-token';
    const app = express();
    app.use(express.json());
    app.use('/api', createApiAuthMiddleware({ publicPaths: ['/health'] }));
    app.use('/api', createSystemRoutes());
    app.use('/api/tasks', createTaskRoutes({} as unknown as TaskQueue));

    await withApp(app, async (baseUrl) => {
      const health = await jsonFetch<any>(baseUrl, '/api/health');
      expect(health.status).toBe(200);

      const missing = await jsonFetch<any>(baseUrl, '/api/tasks');
      expect(missing.status).toBe(401);
      expect(missing.body.error.code).toBe('AUTH_REQUIRED');

      const invalid = await jsonFetch<any>(baseUrl, '/api/tasks', {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(invalid.status).toBe(401);
      expect(invalid.body.error.code).toBe('AUTH_INVALID');

      const valid = await jsonFetch<any[]>(baseUrl, '/api/tasks', {
        headers: { Authorization: 'Bearer secret-token' },
      });
      expect(valid.status).toBe(200);
      expect(valid.body).toEqual([]);
    });
  });
});
