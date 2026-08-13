import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { loadTeams } from '../src/agents/team-registry.js';
import { createTeamRoutes } from '../src/routes/teams.js';
import { getGraphWorkflow } from '../src/agents/graph-workflow.js';

async function withApp<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind test server');
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function jsonFetch(baseUrl: string, path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'team-template-routes-')), 'test.db');
  getDb();
  const directory = mkdtempSync(join(tmpdir(), 'team-template-yaml-'));
  const path = join(directory, 'teams.yaml');
  writeFileSync(path, [
    'teams:',
    '  - id: feature',
    '    name: Feature Team',
    '    members: [developer, tester]',
  ].join('\n'));
  loadTeams(path);
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
});

describe('Team template routes', () => {
  it('creates, publishes, and instantiates a versioned team workflow', async () => {
    const app = express();
    app.use(express.json());
    app.use('/teams', createTeamRoutes({} as any));

    await withApp(app, async baseUrl => {
      const created = await jsonFetch(baseUrl, '/teams/feature/versions', {
        method: 'POST',
        body: JSON.stringify({
          changeNote: 'initial workflow',
          graph: {
            schemaVersion: '1.0',
            nodes: [{ id: 'build', agentRole: 'developer' }],
            edges: [],
          },
        }),
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ teamId: 'feature', version: 1, status: 'draft' });

      const published = await jsonFetch(baseUrl, `/teams/feature/versions/${created.body.id}/publish`, {
        method: 'POST',
      });
      expect(published.status).toBe(200);
      expect(published.body.status).toBe('published');

      const instantiated = await jsonFetch(baseUrl, '/teams/feature/instantiate', {
        method: 'POST',
        body: JSON.stringify({ input: 'build a profile page' }),
      });
      expect(instantiated.status).toBe(201);
      expect(instantiated.body.teamTemplateVersion.id).toBe(created.body.id);
      const workflow = getGraphWorkflow(instantiated.body.workflow.id);
      expect(workflow?.graph.nodes[0].id).toBe('build');
      expect(workflow?.input).toBe('build a profile page');
    });
  });
});
