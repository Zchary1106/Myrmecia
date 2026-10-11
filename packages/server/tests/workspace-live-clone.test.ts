import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { expect, it } from 'vitest';
import { createWorkspaceSourceRoutes } from '../src/routes/workspace-sources.js';
it.skipIf(process.env.MYRMECIA_LIVE_CLONE_ACCEPTANCE !== 'true')('clones an allowed public HTTPS source with actual scoped HTTP and Git transport', async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).tenantContext = { userId: 'live-clone-fixture', workspaceId: 'default', role: 'operator' }; next(); });
  app.use('/workspaces', createWorkspaceSourceRoutes());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/workspaces/remote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"url":"https://github.com/octocat/Hello-World.git"}',
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(201);
    expect(result.filesystemWorkspaceId).toBeTruthy();
    const head = execFileSync('git', ['-C', result.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(head).toMatch(/^[a-f0-9]{40}$/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 120_000);
