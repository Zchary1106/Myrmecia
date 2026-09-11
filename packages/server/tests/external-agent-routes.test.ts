import express from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb } from '../src/db/database.js';
import { addWorkspaceMember, createOrganization, createUser, createWorkspace, tenantMiddleware } from '../src/auth/tenant.js';
import { createExternalAgentRoutes } from '../src/routes/external-agents.js';
import { createExternalAgentScheduleRoutes } from '../src/routes/external-agent-schedules.js';

async function withApp<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind test server.');
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function jsonFetch<T>(baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
  });
  return { status: response.status, body: await response.json() as T };
}

describe('external Agent routes', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-external-agent-route-')), 'test.db');
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('creates and schedules a workspace-scoped Agent only for an operator', async () => {
    const org = createOrganization('External Agents Org');
    const operator = createUser({ orgId: org.id, email: 'operator@example.test', name: 'Operator', role: 'operator' });
    const viewer = createUser({ orgId: org.id, email: 'viewer@example.test', name: 'Viewer', role: 'viewer' });
    const workspace = createWorkspace(org.id, 'Agents');
    addWorkspaceMember(operator.id, workspace.id, 'operator');
    addWorkspaceMember(viewer.id, workspace.id, 'viewer');
    const app = express();
    app.use(express.json());
    app.use(tenantMiddleware());
    app.use('/agents', createExternalAgentRoutes());
    app.use('/schedules', createExternalAgentScheduleRoutes());

    const operatorHeaders = { 'x-user-id': operator.id, 'x-workspace-id': workspace.id };
    await withApp(app, async baseUrl => {
      const forbidden = await jsonFetch<any>(baseUrl, '/agents', {
        method: 'POST',
        headers: { 'x-user-id': viewer.id, 'x-workspace-id': workspace.id },
        body: JSON.stringify({ name: 'Viewer Agent', adapter: { kind: 'local_cli', profile: 'codex', allowedWorkspaceRoots: ['/tmp'] } }),
      });
      expect(forbidden.status).toBe(403);

      const created = await jsonFetch<any>(baseUrl, '/agents', {
        method: 'POST',
        headers: operatorHeaders,
        body: JSON.stringify({ name: 'Codex Agent', adapter: { kind: 'local_cli', profile: 'codex', allowedWorkspaceRoots: ['/tmp'] } }),
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('active');

      const schedule = await jsonFetch<any>(baseUrl, '/schedules', {
        method: 'POST',
        headers: operatorHeaders,
        body: JSON.stringify({
          externalAgentId: created.body.id,
          triggerType: 'cron',
          cron: '0 9 * * 1-5',
          timezone: 'Asia/Shanghai',
          invocation: { objective: 'Check the repository', constraints: [] },
        }),
      });
      expect(schedule.status).toBe(201);
      expect(schedule.body.nextRunAt).toBeTruthy();
    });
  });

  it('preserves forbidden responses for every mutating external Agent operation', async () => {
    const org = createOrganization('External Agent Authorization Org');
    const operator = createUser({ orgId: org.id, email: 'operator-auth@example.test', name: 'Operator', role: 'operator' });
    const viewer = createUser({ orgId: org.id, email: 'viewer-auth@example.test', name: 'Viewer', role: 'viewer' });
    const workspace = createWorkspace(org.id, 'Authorization');
    addWorkspaceMember(operator.id, workspace.id, 'operator');
    addWorkspaceMember(viewer.id, workspace.id, 'viewer');

    const app = express();
    app.use(express.json());
    app.use(tenantMiddleware());
    app.use('/agents', createExternalAgentRoutes());

    const operatorHeaders = { 'x-user-id': operator.id, 'x-workspace-id': workspace.id };
    const viewerHeaders = { 'x-user-id': viewer.id, 'x-workspace-id': workspace.id };

    await withApp(app, async baseUrl => {
      const created = await jsonFetch<{ id: string }>(baseUrl, '/agents', {
        method: 'POST',
        headers: operatorHeaders,
        body: JSON.stringify({ name: 'Protected Agent', adapter: { kind: 'local_cli', profile: 'codex', allowedWorkspaceRoots: ['/tmp'] } }),
      });
      expect(created.status).toBe(201);

      const requests: Array<Promise<{ status: number; body: any }>> = [
        jsonFetch(baseUrl, `/agents/${created.body.id}`, {
          method: 'PATCH',
          headers: viewerHeaders,
          body: JSON.stringify({ name: 'Attempted update' }),
        }),
        jsonFetch(baseUrl, `/agents/${created.body.id}`, {
          method: 'DELETE',
          headers: viewerHeaders,
        }),
        jsonFetch(baseUrl, `/agents/${created.body.id}/health`, {
          method: 'POST',
          headers: viewerHeaders,
        }),
        jsonFetch(baseUrl, `/agents/${created.body.id}/runs`, {
          method: 'POST',
          headers: viewerHeaders,
          body: JSON.stringify({ invocation: { objective: 'Attempted run' } }),
        }),
      ];

      const responses = await Promise.all(requests);
      for (const response of responses) {
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('OPERATOR_FORBIDDEN');
      }
    });
  });

  it('returns actionable 4xx responses and never persists an invalid Agent update', async () => {
    const org = createOrganization('External Agent Input Validation Org');
    const operator = createUser({ orgId: org.id, email: 'operator-input@example.test', name: 'Operator', role: 'operator' });
    const workspace = createWorkspace(org.id, 'Input validation');
    addWorkspaceMember(operator.id, workspace.id, 'operator');

    const app = express();
    app.use(express.json());
    app.use(tenantMiddleware());
    app.use('/agents', createExternalAgentRoutes());
    app.use('/schedules', createExternalAgentScheduleRoutes());

    const headers = { 'x-user-id': operator.id, 'x-workspace-id': workspace.id };
    await withApp(app, async baseUrl => {
      const invalidCreate = await jsonFetch<any>(baseUrl, '/agents', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Missing root', adapter: { kind: 'local_cli', profile: 'codex' } }),
      });
      expect(invalidCreate.status).toBe(400);
      expect(invalidCreate.body.error.code).toBe('INVALID_INPUT');

      const created = await jsonFetch<any>(baseUrl, '/agents', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Validated Agent', adapter: { kind: 'local_cli', profile: 'codex', allowedWorkspaceRoots: ['/tmp'] } }),
      });
      expect(created.status).toBe(201);

      const invalidUpdate = await jsonFetch<any>(baseUrl, `/agents/${created.body.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ adapter: { kind: 'local_cli', profile: 'codex', allowedWorkspaceRoots: [] } }),
      });
      expect(invalidUpdate.status).toBe(400);
      expect(invalidUpdate.body.error.code).toBe('INVALID_INPUT');

      const unchanged = await jsonFetch<any>(baseUrl, `/agents/${created.body.id}`, { headers });
      expect(unchanged.body.adapter.allowedWorkspaceRoots).toEqual(['/tmp']);

      const invalidTaskEvent = await jsonFetch<any>(baseUrl, '/schedules', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          externalAgentId: created.body.id,
          triggerType: 'task_event',
          eventType: 'pipeline:done',
          invocation: { objective: 'Not supported yet', constraints: [] },
        }),
      });
      expect(invalidTaskEvent.status).toBe(400);
      expect(invalidTaskEvent.body.error.code).toBe('INVALID_INPUT');

      const invalidCron = await jsonFetch<any>(baseUrl, '/schedules', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          externalAgentId: created.body.id,
          triggerType: 'cron',
          cron: 'not a cron expression',
          invocation: { objective: 'Invalid schedule', constraints: [] },
        }),
      });
      expect(invalidCron.status).toBe(400);
      expect(invalidCron.body.error.code).toBe('INVALID_INPUT');
    });
  });
});
