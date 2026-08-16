/**
 * Team v2 — role slots CRUD, contract validation, and preflight route.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { syncBuiltinTools } from '../src/tools/tool-registry.js';
import { syncBuiltinSkills } from '../src/skills/skill-registry.js';
import { loadLegacyAgentAliases } from '../src/agents/legacy-agent-alias-resolver.js';
import { createTeam, getTeam, updateTeam, type Team } from '../src/agents/team-registry.js';
import { createTeamRoutes } from '../src/routes/teams.js';

const roles = [
  { slot: 'researcher', agentId: 'researcher', skills: ['competitive-research'], tools: ['web.search'] },
  { slot: 'creator', agentId: 'content-creator', skills: ['xiaohongshu-copywriting', 'hashtag-planning'] },
  { slot: 'reviewer', agentId: 'review', skills: ['social-compliance'] },
];

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'team-v2-crud-')), 'test.db');
  getDb();

  for (const id of ['master', 'researcher', 'content-creator', 'ui', 'review', 'ops', 'pm', 'qa']) {
    createAgent({ id, name: id, role: id, capabilities: [] });
  }
  syncBuiltinTools();
  loadLegacyAgentAliases();
  syncBuiltinSkills(join(process.cwd(), '../../agents'), [
    join(process.cwd(), '../../agents/skills'),
    join(process.cwd(), '../../skills'),
  ]);
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
});

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

describe('Team v2 registry CRUD', () => {
  it('creates and reads back a v2 team with role slots and policy', () => {
    const team = createTeam({
      id: 'content-squad',
      name: 'Content Squad',
      members: ['review'],
      roles,
      policy: { requireHumanApprovalBefore: ['publish'] },
      domainIds: ['tech-product'],
    });

    const loaded = getTeam('content-squad') as Team;
    expect(loaded.contractVersion).toBe(2);
    expect(loaded.roles).toHaveLength(3);
    expect(loaded.roles?.[1].skills).toEqual(['xiaohongshu-copywriting', 'hashtag-planning']);
    expect(loaded.policy?.requireHumanApprovalBefore).toEqual(['publish']);
    expect(loaded.domainIds).toEqual(['tech-product']);
  });

  it('updates role slots and keeps v2 contract', () => {
    const team = createTeam({ id: 'content-squad', name: 'Content Squad', members: ['review'], roles });
    const updated = updateTeam('content-squad', {
      roles: [...roles, { slot: 'designer', agentId: 'ui', skills: ['xiaohongshu-card-design'] }],
    });
    expect(updated.roles).toHaveLength(4);
    expect(updated.roles?.find(role => role.slot === 'designer')?.agentId).toBe('ui');
    expect(updated.contractVersion).toBe(2);
  });
});

describe('Team v2 routes', () => {
  it('creates a v2 team and runs preflight', async () => {
    const app = express();
    app.use(express.json());
    app.use('/teams', createTeamRoutes({} as any));

    await withApp(app, async baseUrl => {
      const created = await fetch(`${baseUrl}/teams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'content-squad',
          name: 'Content Squad',
          members: ['review'],
          roles,
          policy: { requireHumanApprovalBefore: ['publish'] },
        }),
      });
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(body.roles).toHaveLength(3);

      const preflight = await fetch(`${baseUrl}/teams/content-squad/preflight`);
      const preflightBody = await preflight.json();
      expect(preflight.status).toBe(200);
      expect(preflightBody.pass).toBe(true);
    });
  });

  it('rejects a v2 team with duplicate role slots', async () => {
    const app = express();
    app.use(express.json());
    app.use('/teams', createTeamRoutes({} as any));

    await withApp(app, async baseUrl => {
      const created = await fetch(`${baseUrl}/teams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Broken Squad',
          members: ['review'],
          roles: [
            { slot: 'creator', agentId: 'content-creator' },
            { slot: 'creator', agentId: 'ui' },
          ],
        }),
      });
      expect(created.status).toBe(400);
    });
  });
});
