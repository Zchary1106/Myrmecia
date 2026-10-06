import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import routes from '../src/routes/executions.js';
import { closeDb } from '../src/db/database.js';
import { createTask, updateTask } from '../src/db/models/task.js';
import { createExecution, updateExecution } from '../src/db/models/execution.js';
import { initialAgentRunState } from '../src/agents/run-state.js';

beforeEach(() => { process.env.DB_PATH = ':memory:'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; });

async function withApi(fn: (url: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).tenantContext = { workspaceId: req.header('x-workspace') || 'default', userId: 'fixture', role: 'admin' };
    next();
  });
  app.use('/executions', routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  try { await fn(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

function fixture(legacy = false, taskConfig: Partial<Parameters<typeof createTask>[0]> = {}) {
  const task = createTask({ title: 'Review output', description: '', input: 'fixture', mode: 'direct', workspaceId: 'default', ...taskConfig });
  updateTask(task.id, { status: 'done' });
  const execution = createExecution({ taskId: task.id, agentDefId: 'fixture' });
  return updateExecution(execution.id, {
    status: 'done',
    ...(legacy ? {} : { runState: {
      ...initialAgentRunState(), phase: 'completed', stopReason: 'completed',
      validation: { scope: 'output', status: 'passed', checks: [{ name: 'non_empty_output', passed: true }] },
    } }),
  })!;
}

describe('human output acceptance', () => {
  it.each(['failed', 'cancelled', 'review', 'running'] as const)('rejects acceptance of a completed run whose task is %s', async status => {
    const execution = fixture();
    updateTask(execution.taskId, { status });
    await withApi(async url => {
      const response = await fetch(`${url}/executions/${execution.id}/acceptance`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'accepted' }),
      });
      expect(response.status).toBe(409);
    });
  });

  it('rejects internal QA output and a completed child of a failed root', async () => {
    const parent = createTask({ title: 'Root', input: 'work', description: '', mode: 'direct' });
    updateTask(parent.id, { status: 'failed' });
    const execution = fixture(false, { parentTaskId: parent.id, title: 'Test: Root' });
    const implementation = fixture(false, { parentTaskId: parent.id, title: 'Implementation child' });
    await withApi(async url => {
      const submit = (id = execution.id) => fetch(`${url}/executions/${id}/acceptance`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'accepted' }),
      });
      expect((await submit()).status).toBe(409);
      updateTask(parent.id, { status: 'done' });
      expect((await submit()).status).toBe(409);
      updateTask(parent.id, { status: 'failed' });
      expect((await submit(implementation.id)).status).toBe(409);
    });
  });
  it('persists explicit acceptance idempotently and rejects conflicting decisions', async () => {
    const execution = fixture();
    await withApi(async url => {
      const submit = (decision: string, workspace = 'default') => fetch(`${url}/executions/${execution.id}/acceptance`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace': workspace },
        body: JSON.stringify({ decision }),
      });
      expect((await submit('accepted', 'other-workspace')).status).toBe(404);
      const accepted = await submit('accepted');
      expect(accepted.status).toBe(200);
      expect((await accepted.json() as any).runState.acceptance).toBe('accepted');
      expect((await submit('accepted')).status).toBe(200);
      expect((await submit('rejected')).status).toBe(409);
    });
  });

  it('cannot accept unknown legacy, running, or incomplete output', async () => {
    const legacy = fixture(true), incomplete = fixture(), running = fixture();
    updateExecution(incomplete.id, { runState: { ...incomplete.runState!, phase: 'failed', stopReason: 'max_turns' } });
    updateExecution(running.id, { status: 'running' });
    await withApi(async url => {
      for (const id of [legacy.id, incomplete.id, running.id]) {
        expect((await fetch(`${url}/executions/${id}/acceptance`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'accepted' }),
        })).status).toBe(409);
      }
      expect((await fetch(`${url}/executions/${legacy.id}/messages?afterId=-1`)).status).toBe(400);
      expect((await fetch(`${url}/executions/${legacy.id}/messages?limit=100000`)).status).toBe(400);
    });
  });
});
