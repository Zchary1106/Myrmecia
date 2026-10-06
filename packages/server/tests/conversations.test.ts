import { describe, expect, it } from 'vitest';
import express from 'express';
import { createTask, getTask, updateTask } from '../src/db/models/task.js';
import { createPipeline, getPipeline, updatePipeline } from '../src/db/models/pipeline.js';
import { conversationForTask, listConversationStates } from '../src/db/models/conversation.js';
import { createConversationRoutes } from '../src/routes/conversations.js';
import { closeDb, getDb } from '../src/db/database.js';
import { createExecution, updateExecution } from '../src/db/models/execution.js';

function task(workspaceId = 'default', parentTaskId?: string, pipelineId?: string) {
  const created = createTask({ title: 'Conversation fixture', description: '', input: 'fixture', mode: 'direct', workspaceId, parentTaskId, pipelineId });
  return updateTask(created.id, { status: 'done', output: 'Fixture result' })!;
}
async function withApi(fn: (url: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const workspaceId = req.header('x-test-workspace');
    if (workspaceId) (req as any).tenantContext = { workspaceId, userId: 'fixture', role: 'admin' };
    next();
  });
  app.use('/conversations', createConversationRoutes());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  try { await fn(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
async function manage(url: string, taskIds: string[], action = 'archive', options: { confirm?: boolean; role?: string; workspace?: string; stopWorkflow?: boolean } = {}) {
  const response = await fetch(`${url}/conversations/manage`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-operator-id': 'fixture',
      'x-operator-role': options.role || 'admin', ...(options.workspace ? { 'x-test-workspace': options.workspace } : {}) },
    body: JSON.stringify({ taskIds, action, confirm: options.confirm, stopWorkflow: options.stopWorkflow }),
  });
  return { status: response.status, body: await response.json() as any };
}

describe('Conversation history management', () => {
  it('archives a whole ancestry, persists it, and restores without modifying tasks or evidence', async () => {
    const root = task(), child = task('default', root.id), followup = task('default', child.id);
    await withApi(async url => {
      const result = await manage(url, [child.id, followup.id]);
      expect(result.status).toBe(200);
      expect(result.body.affectedConversationIds).toEqual([`task:${root.id}`]);
      expect(listConversationStates().find(item => item.id === `task:${root.id}`)?.status).toBe('archived');
      closeDb();
      expect(listConversationStates().find(item => item.id === `task:${root.id}`)?.status).toBe('archived');
      expect(getTask(root.id)?.output).toBe('Fixture result');
      const states = await (await fetch(`${url}/conversations`)).json() as any[];
      expect(states.find(item => item.id === `task:${root.id}`)?.status).toBe('archived');
      expect(states.find(item => item.id === `task:${root.id}`)?.taskIds).toEqual(expect.arrayContaining([root.id, child.id, followup.id]));
      expect((await manage(url, [followup.id], 'restore')).status).toBe(200);
      expect(listConversationStates().find(item => item.id === `task:${root.id}`)).toBeUndefined();
    });
  });

  it('requires confirmation and admin permissions for delete, retaining audit/task rows', async () => {
    const root = task(), child = task('default', root.id);
    await withApi(async url => {
      expect((await manage(url, [root.id], 'delete')).status).toBe(409);
      expect((await manage(url, [root.id], 'delete', { confirm: true, role: 'operator' })).status).toBe(403);
      expect((await manage(url, [root.id], 'delete', { confirm: true })).status).toBe(200);
      expect(getTask(root.id)).toBeDefined();
      expect(getTask(child.id)).toBeDefined();
      expect(getDb().get('SELECT * FROM operator_actions WHERE target_id = ? AND action = ?', root.id, 'conversation.delete')).toBeDefined();
      expect(listConversationStates().find(item => item.id === `task:${root.id}`)?.status).toBe('deleted');
      expect((await manage(url, [root.id], 'restore')).status).toBe(409);
    });
  });

  it.each(['pending', 'queued', 'assigned', 'running', 'waiting_for_tool', 'review'] as const)('rejects %s descendants and leaves the entire batch unchanged', async status => {
    const done = task(), root = task(), child = task('default', root.id);
    updateTask(child.id, { status });
    await withApi(async url => {
      const result = await manage(url, [done.id, root.id], 'delete', { confirm: true });
      expect(result.status).toBe(409);
      expect(result.body.error.code).toBe('CONVERSATION_ACTIVE');
      expect(listConversationStates().find(item => item.id === `task:${done.id}`)).toBeUndefined();
      expect(listConversationStates().find(item => item.id === `task:${root.id}`)).toBeUndefined();
    });
  });

  it('archives paused pipelines without stopping them and includes all stages', async () => {
    const pipeline = createPipeline({ name: 'History fixture', stages: [], input: '' });
    const first = task('default', undefined, pipeline.id), second = task('default', undefined, pipeline.id);
    updatePipeline(pipeline.id, { status: 'paused' });
    await withApi(async url => {
      const archived = await manage(url, [first.id]);
      expect(archived.status).toBe(200);
      expect(archived.body.states.find((item: any) => item.id === `pipeline:${pipeline.id}`).taskIds).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(getPipeline(pipeline.id)?.status).toBe('paused');
      expect((await manage(url, [first.id], 'delete', { confirm: true })).body.error.code).toBe('CONVERSATION_STOP_REQUIRED');
      updatePipeline(pipeline.id, { status: 'done' });
      const result = await manage(url, [first.id, second.id]);
      expect(result.status).toBe(200);
      expect(result.body.affectedConversationIds).toEqual([`pipeline:${pipeline.id}`]);
    });
  });

  it('rejects a live execution even if its task already looks completed', async () => {
    const root = task();
    const execution = createExecution({ taskId: root.id, agentDefId: 'fixture-agent' });
    await withApi(async url => {
      expect((await manage(url, [root.id], 'archive')).status).toBe(200);
      expect((await manage(url, [root.id], 'delete', { confirm: true, stopWorkflow: true })).status).toBe(409);
      updateExecution(execution.id, { status: 'done' });
      expect((await manage(url, [root.id], 'archive')).status).toBe(200);
    });
  });

  it.each(['paused', 'awaiting_retry', 'blocked'] as const)('ends a quiescent %s workflow only on explicit delete confirmation, retaining tasks and outputs', async status => {
    const pipeline = createPipeline({
      name: `History ${status}`, input: '', stages: [
        { index: 0, name: 'Research', agentRole: 'researcher', status: 'done', output: 'Keep this evidence' },
        { index: 1, name: 'Publish', agentRole: 'researcher', status: 'pending' },
      ],
    });
    const root = task('default', undefined, pipeline.id);
    updatePipeline(pipeline.id, { status });
    await withApi(async url => {
      expect((await manage(url, [root.id], 'archive')).status).toBe(200);
      expect(getPipeline(pipeline.id)?.status).toBe(status);
      expect((await manage(url, [root.id], 'delete', { stopWorkflow: true })).status).toBe(409);
      expect((await manage(url, [root.id], 'delete', { confirm: true, stopWorkflow: true, role: 'operator' })).status).toBe(403);
      expect((await manage(url, [root.id], 'delete', { confirm: true })).body.error.code).toBe('CONVERSATION_STOP_REQUIRED');
      expect(getPipeline(pipeline.id)?.status).toBe(status);
      const result = await manage(url, [root.id], 'delete', { confirm: true, stopWorkflow: true });
      expect(result.status).toBe(200);
      expect(result.body.stoppedPipelineIds).toEqual([pipeline.id]);
      expect(getPipeline(pipeline.id)?.status).toBe('failed');
      expect(getPipeline(pipeline.id)?.stages.map(stage => stage.status)).toEqual(['done', 'skipped']);
      expect(getPipeline(pipeline.id)?.stages[0].output).toBe('Keep this evidence');
      expect(getTask(root.id)?.output).toBe('Fixture result');
      expect(getDb().get("SELECT * FROM operator_actions WHERE target_id = ? AND action = 'pipeline.cancel'", pipeline.id)).toBeDefined();
    });
  });

  it.each(['pending', 'queued', 'assigned', 'running', 'waiting_for_tool', 'review'] as const)('archives %s descendants without cancelling or changing execution', async status => {
    const root = task(), child = task('default', root.id);
    updateTask(child.id, { status });
    const execution = createExecution({ taskId: child.id, agentDefId: 'fixture-agent' });
    await withApi(async url => {
      expect((await manage(url, [root.id], 'archive')).status).toBe(200);
      expect(getTask(child.id)?.status).toBe(status);
      expect(getDb().get('SELECT status FROM task_executions WHERE id = ?', execution.id)?.status).toBe(execution.status);
      expect((await manage(url, [root.id], 'restore')).status).toBe(200);
      expect(getTask(child.id)?.status).toBe(status);
    });
  });

  it('does not stop any workflow if another target in the batch has live work', async () => {
    const pipeline = createPipeline({ name: 'Quiescent batch fixture', stages: [], input: '' });
    const root = task('default', undefined, pipeline.id), active = task();
    updatePipeline(pipeline.id, { status: 'awaiting_retry' });
    updateTask(active.id, { status: 'running' });
    await withApi(async url => {
      const result = await manage(url, [root.id, active.id], 'delete', { confirm: true, stopWorkflow: true });
      expect(result.status).toBe(409);
      expect(getPipeline(pipeline.id)?.status).toBe('awaiting_retry');
      expect(listConversationStates().some(item => item.id === `pipeline:${pipeline.id}`)).toBe(false);
      expect(getDb().get("SELECT id FROM operator_actions WHERE target_id = ? AND action = 'pipeline.cancel'", pipeline.id)).toBeUndefined();
    });
  });

  it('fails closed on running stages even when the workflow is paused and task rows are terminal', async () => {
    const pipeline = createPipeline({ name: 'Live stage fixture', input: '', stages: [{ index: 0, name: 'Research', agentRole: 'researcher', status: 'running' }] });
    const root = task('default', undefined, pipeline.id);
    updatePipeline(pipeline.id, { status: 'paused' });
    await withApi(async url => {
      expect((await manage(url, [root.id], 'delete', { confirm: true, stopWorkflow: true })).body.error.code).toBe('CONVERSATION_ACTIVE');
      expect(getPipeline(pipeline.id)?.status).toBe('paused');
      expect((await manage(url, [root.id], 'archive')).status).toBe(200);
    });
  });

  it('never stops a running workflow even if all task rows currently look completed', async () => {
    const pipeline = createPipeline({ name: 'Running workflow fixture', input: '', stages: [] });
    const root = task('default', undefined, pipeline.id);
    await withApi(async url => {
      expect((await manage(url, [root.id], 'archive')).status).toBe(200);
      expect((await manage(url, [root.id], 'delete', { confirm: true, stopWorkflow: true })).body.error.code).toBe('CONVERSATION_ACTIVE');
      expect(getPipeline(pipeline.id)?.status).toBe('running');
    });
  });

  it('cannot stop a workflow in another workspace through an inconsistent task link', async () => {
    const pipeline = createPipeline({ name: 'Foreign workflow fixture', input: '', stages: [], workspaceId: 'history-foreign' });
    updatePipeline(pipeline.id, { status: 'paused' });
    const root = task('history-local', undefined, pipeline.id);
    await withApi(async url => {
      expect((await manage(url, [root.id], 'delete', { workspace: 'history-local', confirm: true, stopWorkflow: true })).body.error.code).toBe('CONVERSATION_WORKFLOW_UNAVAILABLE');
      expect(getPipeline(pipeline.id)?.status).toBe('paused');
    });
  });

  it('isolates lifecycle states and validates every target against the active workspace', async () => {
    const a = task('history-a'), b = task('history-b');
    await withApi(async url => {
      expect((await manage(url, [a.id, b.id], 'archive', { workspace: 'history-a' })).status).toBe(404);
      expect(listConversationStates('history-a')).toEqual([]);
      expect((await manage(url, [b.id], 'archive', { workspace: 'history-b' })).status).toBe(200);
      const states = await (await fetch(`${url}/conversations`, { headers: { 'x-test-workspace': 'history-a' } })).json();
      expect(states).toEqual([]);
      expect((await manage(url, [a.id], 'archive', { role: 'viewer' })).status).toBe(403);
    });
  });

  it('bounds batches, rejects bad requests and detects cycles without hanging', async () => {
    const a = task(), b = task('default', a.id);
    getDb().run('UPDATE tasks SET parent_task_id = ? WHERE id = ?', b.id, a.id);
    expect(() => conversationForTask(getTask(a.id)!, new Map([[a.id, getTask(a.id)!], [b.id, b]]))).toThrow('cyclic');
    // Remove only the malformed test link so it cannot affect other fixtures.
    getDb().run('UPDATE tasks SET parent_task_id = NULL WHERE id = ?', a.id);
    await withApi(async url => {
      expect((await manage(url, [])).status).toBe(400);
      expect((await manage(url, Array.from({ length: 101 }, () => a.id))).status).toBe(400);
      expect((await manage(url, ['missing'])).status).toBe(404);
    });
  });
});
