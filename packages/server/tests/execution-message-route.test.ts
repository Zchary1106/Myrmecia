import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import routes from '../src/routes/executions.js';
import { closeDb } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution, updateExecution } from '../src/db/models/execution.js';
import { messageBus } from '../src/agents/message-bus.js';
import { listInboxEntries } from '../src/db/models/agent-inbox.js';
import { agentSessionForTask } from '../src/db/models/agent-session-event.js';
import { getTask } from '../src/db/models/task.js';
import { getExecution } from '../src/db/models/execution.js';

beforeEach(() => { process.env.DB_PATH = ':memory:'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; delete process.env.MYRMECIA_RUNTIME_V2; });
async function withApi(fn: (url: string, runId: string) => Promise<void>) {
  const task = createTask({ title: 'root', description: '', input: 'hello', mode: 'direct' });
  const run = createExecution({ taskId: task.id, agentDefId: 'fixture' });
  updateExecution(run.id, { status: 'running' });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).tenantContext = { workspaceId: 'default', userId: 'fixture', role: req.header('x-role') || 'admin' };
    next();
  });
  app.use('/executions', routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try { await fn(`http://127.0.0.1:${port}`, run.id); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
describe('human in-flight message route compatibility', () => {
  it('deduplicates a retried V2 submission and keeps follow-up out of the current mailbox drain', async () => {
    process.env.MYRMECIA_RUNTIME_V2 = 'true';
    await withApi(async (url, runId) => {
      const submit = (content: string) => fetch(`${url}/executions/${runId}/message`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, mode: 'follow_up', idempotencyKey: 'composer:a' }) });
      const first = await (await submit('Next instruction')).json() as any;
      const second = await (await submit('Next instruction')).json() as any;
      expect(first.inbox.id).toBe(second.inbox.id);
      expect((await submit('Different instruction')).status).toBe(409);
      expect(messageBus.drain(runId, { excludeDurableInbox: true })).toEqual([]);
      const task = getTask(getExecution(runId)!.taskId)!;
      expect(listInboxEntries('default', agentSessionForTask(task))).toHaveLength(1);
      const journal = await (await fetch(`${url}/executions/${runId}/session`)).json() as any;
      expect(journal.inbox[0].mode).toBe('follow_up');
      expect(journal.items.filter((item: any) => item.role === 'user')).toHaveLength(1);
      expect(journal.cursor).toBe(1);
    });
  });
  it('maps the actual composer user_follow_up type to the valid mailbox text contract', async () => {
    await withApi(async (url, runId) => {
      const response = await fetch(`${url}/executions/${runId}/message`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Keep the public API unchanged.', messageType: 'user_follow_up' }) });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.messageType).toBe('text');
      expect(body.conversationMessage.type).toBe('user_follow_up');
      expect(messageBus.drain(runId)).toEqual([expect.objectContaining({ messageType: 'text', content: 'Keep the public API unchanged.' })]);
    });
  });
  it('rejects invalid/privileged message types and viewers without writing a mailbox row', async () => {
    await withApi(async (url, runId) => {
      const post = (body: unknown, role = 'admin') => fetch(`${url}/executions/${runId}/message`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-role': role }, body: JSON.stringify(body),
      });
      expect((await post({ content: 'fake approval', messageType: 'approval_response' })).status).toBe(400);
      expect((await post({ content: 'instruction' }, 'viewer')).status).toBe(403);
      expect((await post({ content: 'x'.repeat(20_001) })).status).toBe(400);
      expect(messageBus.pendingCount(runId)).toBe(0);
    });
  });
});
