import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createTaskRoutes } from '../src/routes/tasks.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import type { AgentManager } from '../src/agents/agent-manager.js';
import { createTask, getTask, updateTask } from '../src/db/models/task.js';
import { createAgent } from '../src/db/models/agent.js';
import { loadExecutionContext, persistExecutionContext } from '../src/agents/execution-context.js';
import { syncBuiltinModels } from '../src/models/model-registry.js';
import { continuationInput } from '../src/agents/task-continuation.js';
import type { Task } from '../src/types.js';
import { createExecution, updateExecution } from '../src/db/models/execution.js';
import { initialAgentRunState } from '../src/agents/run-state.js';
import { createExternalAgent, createExternalAgentRun, updateExternalAgentRun } from '../src/db/models/external-agent.js';
import { getExternalAgentRuntime } from '../src/agents/external-agent-runtime.js';

// Keep the real task queue/persistence, but never invoke a provider in this test.
vi.mock('../src/events/event-bus.js', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), off: vi.fn() } }));
beforeAll(() => {
  syncBuiltinModels();
  createAgent({ id: 'continuation-writer', name: 'Writer', role: 'writer' });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function previous(status: Task['status'] = 'done') {
  const task = createTask({
    title: 'Original question', description: 'Original goal', input: 'Original goal',
    mode: 'direct', assigneeId: 'continuation-writer',
  });
  updateTask(task.id, { status, output: 'Prior answer with uncertain sources', completedAt: '2026-09-13T10:00:00Z' });
  persistExecutionContext(getTask(task.id)!, {
    modelId: 'gpt-5.4', reasoningEffort: 'high', contextLength: 128000,
    provider: 'openai', workdir: process.cwd(), workspacePath: process.cwd(),
    constraints: ['Do not publish anything'], codeBaseline: { revision: 'baseline-revision' },
  });
  return getTask(task.id)!;
}

async function withApi(fn: (send: (id: string, content: string, role?: string) => Promise<Response>) => Promise<void>) {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
  const queue = new TaskQueue({ hasCapacity: () => false } as unknown as AgentManager);
  const app = express();
  app.use(express.json());
  app.use('/tasks', createTaskRoutes(queue));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  try {
    await fn((id, content, role = 'operator') => fetch(`http://127.0.0.1:${address.port}/tasks/${id}/continue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-operator-id': 'test', 'x-operator-role': role },
      body: JSON.stringify({ content }),
    }));
  } finally {
    await queue.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('conversation continuation', () => {
  it('keeps external follow-ups on the same Agent instead of silently rerouting to Master', async () => {
    const old = previous();
    const agent = createExternalAgent({ workspaceId: 'default', name: 'Continuation fixture', adapter: { kind: 'http', endpoint: 'https://fixture.invalid' } });
    const execution = createExecution({ taskId: old.id, agentDefId: `external:${agent.id}` });
    updateExecution(execution.id, { status: 'done' });
    const run = createExternalAgentRun({ externalAgentId: agent.id, workspaceId: 'default', taskId: old.id, status: 'succeeded',
      triggerType: 'manual', invocation: { objective: old.input, constraints: [] }, artifactIds: [] });
    updateExternalAgentRun(run.id, 'default', { executionId: execution.id });
    const dispatch = vi.spyOn(getExternalAgentRuntime(), 'run').mockResolvedValue(run);
    await withApi(async send => {
      const response = await send(old.id, 'Clarify the first recommendation');
      expect(response.status).toBe(201);
      const task = await response.json() as Task;
      expect(task.parentTaskId).toBe(old.id);
      expect(dispatch).toHaveBeenCalledWith(agent.id, 'default', expect.objectContaining({
        taskId: task.id, constraints: ['Do not publish anything'],
        objective: expect.stringContaining('NEW user message:\nClarify the first recommendation'),
      }), 'manual');
      expect(getTask(old.id)?.status).toBe('done');
    });
  });
  it('continues a waiting-for-user run without treating an unrelated review as completed', async () => {
    const waiting = previous('review');
    const execution = createExecution({ taskId: waiting.id, agentDefId: 'continuation-writer' });
    updateExecution(execution.id, { status: 'done', runState: {
      ...initialAgentRunState(), phase: 'waiting_for_user', stopReason: 'needs_input',
    } });
    const ordinaryReview = previous('review');
    await withApi(async send => {
      expect((await send(waiting.id, 'Here is the document')).status).toBe(201);
      expect((await send(ordinaryReview.id, 'Unrelated review')).status).toBe(409);
      expect(getTask(waiting.id)?.status).toBe('review');
    });
  });
  it.each(['done', 'failed', 'cancelled'] as const)('continues a %s task without changing its result or completion state', async status => {
    const old = previous(status);
    await withApi(async send => {
      const response = await send(old.id, 'Compare the first two options');
      expect(response.status).toBe(201);
      const next = await response.json() as Task;
      expect(next).toMatchObject({
        status: 'queued', mode: 'direct', parentTaskId: old.id, createdBy: 'user',
        description: 'Compare the first two options', assigneeId: old.assigneeId,
        modelId: 'gpt-5.4', reasoningEffort: 'high', contextLength: 128000, workdir: process.cwd(),
      });
      expect(next.input).toContain(old.output);
      expect(next.input).toContain('NEW user message:\nCompare the first two options');
      expect(loadExecutionContext(next)).toMatchObject({
        provider: 'openai', constraints: ['Do not publish anything'], codeBaseline: { revision: 'baseline-revision' },
      });
      expect(getTask(old.id)).toEqual(old);
      // Even if addressed to the old task, a second request cannot race queued work.
      expect((await send(old.id, 'Duplicate follow-up')).status).toBe(409);
    });
  });

  it('uses the latest user turn and keeps all rounds under one root', async () => {
    const old = previous();
    await withApi(async send => {
      const first = await (await send(old.id, 'First follow-up')).json() as Task;
      updateTask(first.id, { status: 'done', output: 'Second answer', completedAt: new Date().toISOString() });
      persistExecutionContext(getTask(first.id)!, { constraints: ['Keep new constraint'], provider: 'openai' });
      const second = await (await send(old.id, 'Second follow-up')).json() as Task;
      expect(second.parentTaskId).toBe(old.id);
      expect(second.input).toContain('Second answer');
      expect(second.input).not.toContain(first.input);
      expect(loadExecutionContext(second).constraints).toEqual(['Keep new constraint']);
    });
  });

  it('rejects active tasks, empty input, unauthorized roles and missing tasks', async () => {
    const old = previous();
    const active = previous('running');
    await withApi(async send => {
      expect((await send(active.id, 'Continue')).status).toBe(409);
      expect((await send(old.id, ' ')).status).toBe(400);
      expect((await send(old.id, 'Continue', 'viewer')).status).toBe(403);
      expect((await send('missing', 'Continue')).status).toBe(404);
    });
  });

  it('bounds repeated history without recursively embedding previous prompts', () => {
    const old = previous();
    const turns = Array.from({ length: 10 }, (_, i) => ({ ...old, id: `turn-${i}`, output: 'x'.repeat(10000) }));
    const input = continuationInput(old, turns, 'Continue', loadExecutionContext(old));
    expect(input).not.toContain('"taskId":"turn-0"');
    expect(input).toContain('"taskId":"turn-9"');
    expect(input).toContain('"resultTruncated":true');
    expect(input.length).toBeLessThan(40000);
  });
});
