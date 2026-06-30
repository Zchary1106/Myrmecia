import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGraphWorkflow, type GraphWorkflowEngine } from '../src/agents/graph-workflow.js';
import { createGraphWorkflowRoutes } from '../src/routes/graph-workflows.js';
import { createTeamRoutes } from '../src/routes/teams.js';
import { createSystemRoutes } from '../src/routes/system.js';
import { createTeam } from '../src/agents/team-registry.js';
import { addWorkspaceMember, createOrganization, createUser, createWorkspace, tenantMiddleware } from '../src/auth/tenant.js';
import { closeDb, getDb } from '../src/db/database.js';
import { createInboxEntry } from '../src/db/models/inbox.js';
import { createNotification } from '../src/db/models/notification.js';

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

function createTenant() {
  const org = createOrganization('Tenant Org');
  const user = createUser({ orgId: org.id, email: `tenant-${Date.now()}@example.test`, name: 'Tenant User', role: 'operator' });
  const workspaceA = createWorkspace(org.id, 'Workspace A');
  const workspaceB = createWorkspace(org.id, 'Workspace B');
  addWorkspaceMember(user.id, workspaceA.id, 'operator');
  addWorkspaceMember(user.id, workspaceB.id, 'operator');
  return {
    user,
    workspaceA,
    workspaceB,
    headersA: { 'x-user-id': user.id, 'x-workspace-id': workspaceA.id },
    headersB: { 'x-user-id': user.id, 'x-workspace-id': workspaceB.id },
  };
}

describe('tenant boundary enforcement', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-tenant-boundaries-')), 'test.db');
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
    vi.restoreAllMocks();
  });

  it('scopes graph workflow list and detail routes to the active workspace', async () => {
    const { workspaceA, workspaceB, headersA } = createTenant();
    const visible = createGraphWorkflow({ name: 'Visible graph', workspaceId: workspaceA.id });
    const hidden = createGraphWorkflow({ name: 'Hidden graph', workspaceId: workspaceB.id });
    const app = express();
    app.use(express.json());
    app.use(tenantMiddleware());
    app.use('/graphs', createGraphWorkflowRoutes({} as GraphWorkflowEngine));

    await withApp(app, async (baseUrl) => {
      const list = await jsonFetch<any[]>(baseUrl, '/graphs', { headers: headersA });
      expect(list.status).toBe(200);
      expect(list.body.map(graph => graph.id)).toEqual([visible.id]);

      const hiddenResult = await jsonFetch<any>(baseUrl, `/graphs/${hidden.id}`, { headers: headersA });
      expect(hiddenResult.status).toBe(404);
    });
  });

  it('scopes notifications and inbox entries to the active workspace', async () => {
    const { workspaceA, workspaceB, headersA } = createTenant();
    const visibleNotification = createNotification({
      type: 'needs_input',
      title: 'Visible notification',
      message: 'Visible',
      workspaceId: workspaceA.id,
    });
    const hiddenNotification = createNotification({
      type: 'needs_input',
      title: 'Hidden notification',
      message: 'Hidden',
      workspaceId: workspaceB.id,
    });
    const visibleInbox = createInboxEntry({
      type: 'approval',
      title: 'Visible inbox',
      message: 'Visible',
      workspaceId: workspaceA.id,
    });
    const hiddenInbox = createInboxEntry({
      type: 'approval',
      title: 'Hidden inbox',
      message: 'Hidden',
      workspaceId: workspaceB.id,
    });
    const app = express();
    app.use(express.json());
    app.use(tenantMiddleware());
    app.use('/', createSystemRoutes());

    await withApp(app, async (baseUrl) => {
      const notifications = await jsonFetch<any[]>(baseUrl, '/notifications', { headers: headersA });
      expect(notifications.status).toBe(200);
      expect(notifications.body.map(notification => notification.id)).toEqual([visibleNotification.id]);

      await jsonFetch<any>(baseUrl, '/notifications/read-all', { method: 'POST', headers: headersA });
      const hiddenStored = getDb().get('SELECT read FROM notifications WHERE id = ?', hiddenNotification.id) as any;
      expect(hiddenStored.read).toBe(0);

      const inbox = await jsonFetch<any[]>(baseUrl, '/inbox', { headers: headersA });
      expect(inbox.status).toBe(200);
      expect(inbox.body.map(entry => entry.id)).toEqual([visibleInbox.id]);

      const hiddenEntry = await jsonFetch<any>(baseUrl, `/inbox/${hiddenInbox.id}`, { headers: headersA });
      expect(hiddenEntry.status).toBe(404);
    });
  });

  it('scopes team run routes and ignores body-provided dispatch workspace ids', async () => {
    const { workspaceA, workspaceB, headersA } = createTenant();
    createTeam({ id: 'feature', name: 'Feature', members: ['dev'] }, workspaceA.id);
    const coordinator = {
      listRuns: vi.fn((_teamId?: string, workspaceId?: string) => [{ id: 'run-visible', workspaceId }]),
      getRun: vi.fn((runId: string) => ({
        id: runId,
        teamId: 'feature',
        goal: 'goal',
        status: 'running',
        workspaceId: runId === 'run-hidden' ? workspaceB.id : workspaceA.id,
        createdAt: new Date().toISOString(),
      })),
      board: vi.fn(() => []),
      dispatch: vi.fn(async (_teamId: string, _goal: string, workspaceId: string) => ({
        run: { id: 'run-dispatch', teamId: 'feature', goal: 'goal', status: 'running', workspaceId, createdAt: new Date().toISOString() },
        team: { id: 'feature', name: 'Feature', emoji: 'F', lead: 'master', members: ['dev'], triggers: [], blurb: '' },
        board: [],
      })),
    };
    const app = express();
    app.use(express.json());
    app.use(tenantMiddleware());
    app.use('/teams', createTeamRoutes(coordinator as any));

    await withApp(app, async (baseUrl) => {
      const runs = await jsonFetch<any>(baseUrl, '/teams/runs', { headers: headersA });
      expect(runs.status).toBe(200);
      expect(coordinator.listRuns).toHaveBeenCalledWith(undefined, workspaceA.id);

      const hiddenRun = await jsonFetch<any>(baseUrl, '/teams/runs/run-hidden', { headers: headersA });
      expect(hiddenRun.status).toBe(404);

      const dispatched = await jsonFetch<any>(baseUrl, '/teams/feature/dispatch', {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ goal: 'Build', workspaceId: workspaceB.id }),
      });
      expect(dispatched.status).toBe(201);
      expect(coordinator.dispatch).toHaveBeenCalledWith('feature', 'Build', workspaceA.id);
    });
  });
});
