/**
 * Domain Pack productization — copy, versioning, retrieval preview, safe delete.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import {
  bumpDomainVersion,
  copyDomain,
  createDomain,
  deleteDomain,
  DomainInUseError,
  findDomainReferences,
  getDomain,
} from '../src/agents/domain-registry.js';
import { createTeam } from '../src/agents/team-registry.js';
import { createDomainRoutes } from '../src/routes/domains.js';

const domainInput = {
  name: 'Tech Product Domain',
  persona: '你是科技产品领域专家。',
  guidelines: ['先检索', '标引用'],
  terminology: { RAG: '检索增强生成' },
  agentIds: ['review'],
};

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'domain-product-')), 'test.db');
  getDb();
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

describe('Domain pack versioning and copy', () => {
  it('creates a domain at version 1, copies it, and bumps versions', () => {
    const domain = createDomain(domainInput);
    expect(domain.version).toBe(1);

    const copy = copyDomain(domain.id);
    expect(copy.id).not.toBe(domain.id);
    expect(copy.name).toContain('副本');
    expect(copy.persona).toBe(domain.persona);
    expect(copy.agentIds).toEqual(domain.agentIds);
    expect(copy.version).toBe(1);

    const bumped = bumpDomainVersion(domain.id, 'persona 修订');
    expect(bumped.version).toBe(2);
    expect(bumped.versionNote).toBe('persona 修订');
    expect(getDomain(domain.id)?.version).toBe(2);
  });
});

describe('Domain safe delete', () => {
  it('blocks deletion while a team references the domain', () => {
    const domain = createDomain(domainInput);
    createTeam({
      id: 'ref-team',
      name: 'Referencing Team',
      members: ['review'],
      roles: [{ slot: 'reviewer', agentId: 'review', domainIds: [domain.id] }],
    });

    const references = findDomainReferences(domain.id);
    expect(references.map(ref => ref.type)).toContain('team');

    expect(() => deleteDomain(domain.id)).toThrow(DomainInUseError);
    try {
      deleteDomain(domain.id);
    } catch (err) {
      expect((err as DomainInUseError).references[0].type).toBe('team');
    }
  });

  it('deletes an unreferenced custom domain', () => {
    const domain = createDomain(domainInput);
    const result = deleteDomain(domain.id);
    expect(result).toEqual({ reverted: false });
    expect(getDomain(domain.id)).toBeUndefined();
  });
});

describe('Domain routes', () => {
  it('serves a retrieval preview for a domain without bound knowledge', async () => {
    const domain = createDomain(domainInput);
    const app = express();
    app.use(express.json());
    app.use('/domains', createDomainRoutes());

    await withApp(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/domains/${domain.id}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '什么是 RAG' }),
      });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.retrievalEnabled).toBe(false);
    });
  });
});
