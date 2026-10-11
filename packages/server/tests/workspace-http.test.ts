import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceSourceRoutes } from '../src/routes/workspace-sources.js';
import { createManagedWorkspaceRoutes } from '../src/routes/managed-workspaces.js';
import { getDb, closeDb } from '../src/db/database.js';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
async function server() {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).tenantContext = { userId: req.header('x-fixture-actor') || 'actor-a',
      workspaceId: req.header('x-fixture-workspace') || 'default', role: req.header('x-fixture-role') || 'operator' }; next();
  });
  app.use('/workspaces', createWorkspaceSourceRoutes()); app.use('/managed', createManagedWorkspaceRoutes());
  const instance = app.listen(0, '127.0.0.1'); servers.push(instance); await once(instance, 'listening');
  const address = instance.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}
describe('workspace HTTP authority', () => {
  it('persists scoped imports and receipts across DB reopen; excludes credentials and keeps cancelled bytes', async () => {
    const base = await server();
    const session = await (await fetch(`${base}/workspaces/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"fixture"}' })).json();
    const upload = (path: string, actor = 'actor-a') => fetch(`${base}/workspaces/local/${session.id}/file`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'x-workspace-file-path': path, 'x-fixture-actor': actor }, body: 'fixture bytes',
    });
    expect((await upload('report.md', 'actor-b')).status).toBe(404);
    expect((await upload('../escape')).status).toBe(400);
    expect((await upload('report.md')).status).toBe(204);
    expect((await upload('.env')).status).toBe(204);
    closeDb(); getDb();
    const complete = await fetch(`${base}/workspaces/local/${session.id}/complete`, { method: 'POST' });
    expect(complete.status).toBe(201);
    const receipt = await complete.json();
    expect(receipt.excluded).toEqual(['.env']); expect(existsSync(`${receipt.path}/.env`)).toBe(false);
    expect(await (await fetch(`${base}/workspaces/local/${session.id}/complete`, { method: 'POST' })).json()).toEqual(receipt);
    expect((await fetch(`${base}/workspaces/local/${session.id}`, { method: 'DELETE' })).status).toBe(409);
    const cancelled = await (await fetch(`${base}/workspaces/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    const stored = getDb().get<any>('SELECT root FROM workspace_import_sessions WHERE id=?', cancelled.id);
    expect((await fetch(`${base}/workspaces/local/${cancelled.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(stored.root)).toBe(true);
    expect((await fetch(`${base}/managed`, { headers: { 'x-fixture-actor': 'actor-b' } })).status).toBe(200);
    expect(await (await fetch(`${base}/managed`, { headers: { 'x-fixture-actor': 'actor-b' } })).json()).toEqual([]);
  });
  it('rejects viewer/proxy spoofing, cross-workspace requests and user-source purge', async () => {
    const base = await server();
    const denied = await fetch(`${base}/workspaces/local`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-fixture-role': 'viewer', 'x-operator-role': 'admin', 'x-operator-id': 'fake-admin' }, body: '{}' });
    expect(denied.status).toBe(403);
    const session = await (await fetch(`${base}/workspaces/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    expect((await fetch(`${base}/workspaces/local/${session.id}/complete`, { method: 'POST', headers: { 'x-fixture-workspace': 'other' } })).status).toBe(404);
    await fetch(`${base}/workspaces/local/${session.id}/file`, { method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'x-workspace-file-path': 'a.txt' }, body: 'x' });
    const receipt = await (await fetch(`${base}/workspaces/local/${session.id}/complete`, { method: 'POST' })).json();
    const preview = await (await fetch(`${base}/managed/${receipt.filesystemWorkspaceId}/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"operation":"purge"}' })).json();
    expect(preview.blockers.join(' ')).toContain('Only explicitly owned');
    const forged = await fetch(`${base}/managed/${receipt.filesystemWorkspaceId}/operations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        operation: 'purge', expectedRevision: preview.workspace.revision, previewId: preview.previewId,
        manifestHash: preview.manifestHash, expiresAt: new Date(Date.now() + 2000).toISOString(), confirm: true,
      }) });
    expect(forged.status).toBe(409); expect(existsSync(receipt.path)).toBe(true);
  });
});
