/**
 * P2 tests — MemoryService facade + /api/v1/memory routes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { resetEmbeddingService } from '../src/memory/embedding.js';
import { getMemoryStore, resetMemoryStore } from '../src/memory/memory-store.js';
import { resetTrajectoryStore } from '../src/memory/trajectory-store.js';
import { getMemoryService, resetMemoryService } from '../src/memory/memory-service.js';
import { createMemoryRoutes } from '../src/routes/memory.js';
import { ingestDocument } from '../src/knowledge/rag.js';

function freshEnv() {
  process.env.EMBEDDING_BACKEND = 'pseudo';
  delete process.env.OPENAI_API_KEY;
  resetEmbeddingService();
  resetMemoryStore();
  resetTrajectoryStore();
  resetMemoryService();
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-mem-p2-')), 'test.db');
  getDb();
}

async function withApp<T>(workspaceId: string | undefined, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).tenantContext = workspaceId ? { workspaceId } : undefined;
    next();
  });
  app.use('/memory', createMemoryRoutes());
  const server: Server = app.listen(0);
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.close();
  }
}

async function jf<T>(baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

describe('MemoryService', () => {
  beforeEach(() => { freshEnv(); });
  afterEach(() => { closeDb(); delete process.env.DB_PATH; delete process.env.EMBEDDING_BACKEND; });

  it('captures episodes and builds a context block', async () => {
    const svc = getMemoryService();
    await svc.captureEpisode({
      input: 'add a stripe billing integration to the checkout flow',
      output: 'Implemented Stripe checkout with webhooks and idempotency keys.',
      agentId: 'dev',
      mode: 'pipeline',
      workspaceId: 'ws-1',
      success: true,
      quality: 0.9,
    });

    const block = await svc.buildContextBlock({
      query: 'stripe billing checkout integration',
      scope: { workspace: 'ws-1' },
      types: ['episodic'],
    });
    expect(block).toContain('Relevant Memory');
    expect(block.toLowerCase()).toContain('stripe');
  });

  it('remember stores a semantic fact retrievable by recall', async () => {
    const svc = getMemoryService();
    await svc.remember('The project uses pnpm workspaces and Node 20.', {
      scope: { workspace: 'ws-1' },
      importance: 0.8,
    });
    const results = await svc.recall({
      query: 'The project uses pnpm workspaces and Node 20.',
      scope: { workspace: 'ws-1' },
      topK: 3,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].item.type).toBe('semantic');
  });

  it('bridges ingested knowledge documents into unified memory', async () => {
    await getMemoryStore().initialize();
    await ingestDocument('ws-kb', 'Runbook', 'The payments service uses Stripe and stores ledgers in Postgres.', {});

    const db = getDb();
    const rows = db.all("SELECT * FROM memory_items WHERE source_type='document' AND scope_workspace='ws-kb'") as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const results = await getMemoryService().recall({
      query: 'payments service Stripe Postgres ledgers',
      scope: { workspace: 'ws-kb' },
      types: ['semantic'],
      topK: 3,
    });
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('/api/v1/memory routes', () => {
  beforeEach(() => { freshEnv(); });
  afterEach(() => { closeDb(); delete process.env.DB_PATH; delete process.env.EMBEDDING_BACKEND; });

  it('adds, lists, recalls and forgets a memory', async () => {
    await withApp('ws-1', async (baseUrl) => {
      const add = await jf<any>(baseUrl, '/memory', {
        method: 'POST',
        body: JSON.stringify({ content: 'Deploys run on Kubernetes via ArgoCD.', importance: 0.7 }),
      });
      expect(add.status).toBe(201);
      expect(add.body.id).toBeTruthy();
      expect(add.body.embedding).toBeUndefined(); // stripped

      const list = await jf<any[]>(baseUrl, '/memory');
      expect(list.body.length).toBe(1);

      const recall = await jf<any[]>(baseUrl, '/memory/recall', {
        method: 'POST',
        body: JSON.stringify({ query: 'Deploys run on Kubernetes via ArgoCD.' }),
      });
      expect(recall.body.length).toBeGreaterThan(0);

      const del = await jf<any>(baseUrl, `/memory/${add.body.id}`, { method: 'DELETE' });
      expect(del.status).toBe(200);

      const after = await jf<any[]>(baseUrl, '/memory');
      expect(after.body.length).toBe(0);
    });
  });

  it('reports stats and isolates by workspace', async () => {
    const svc = getMemoryService();
    await svc.remember('ws-a secret', { scope: { workspace: 'ws-a' } });
    await svc.remember('global note', {}); // unscoped

    await withApp('ws-b', async (baseUrl) => {
      const list = await jf<any[]>(baseUrl, '/memory');
      // ws-b should see the global note but not ws-a's scoped memory
      const contents = list.body.map((m: any) => m.content);
      expect(contents).toContain('global note');
      expect(contents).not.toContain('ws-a secret');
    });

    await withApp(undefined, async (baseUrl) => {
      const stats = await jf<any>(baseUrl, '/memory/stats');
      expect(stats.body.total).toBeGreaterThanOrEqual(2);
      expect(stats.body.counts.semantic).toBeGreaterThanOrEqual(2);
    });
  });
});
