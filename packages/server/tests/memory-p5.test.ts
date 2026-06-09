/**
 * P5 tests — bi-temporal entity graph: extraction, relations, temporal validity.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { resetEmbeddingService } from '../src/memory/embedding.js';
import { resetMemoryStore } from '../src/memory/memory-store.js';
import { resetTrajectoryStore } from '../src/memory/trajectory-store.js';
import { extractEntities, getGraphMemory, resetGraphMemory } from '../src/memory/graph.js';

function freshEnv() {
  process.env.EMBEDDING_BACKEND = 'pseudo';
  delete process.env.OPENAI_API_KEY;
  resetEmbeddingService();
  resetMemoryStore();
  resetTrajectoryStore();
  resetGraphMemory();
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-mem-p5-')), 'test.db');
  getDb();
}

describe('extractEntities', () => {
  it('extracts tech terms and backticked names, skips stopwords', () => {
    const ents = extractEntities('The service uses PostgreSQL and `BullMQ` for the queue. We deploy via ArgoCD.');
    expect(ents).toContain('PostgreSQL');
    expect(ents).toContain('BullMQ');
    expect(ents).toContain('ArgoCD');
    expect(ents).not.toContain('The');
    expect(ents).not.toContain('We');
  });
});

describe('GraphMemory', () => {
  beforeEach(() => { freshEnv(); });
  afterEach(() => { closeDb(); delete process.env.DB_PATH; delete process.env.EMBEDDING_BACKEND; });

  it('ingests entities and relations and supports graph-augmented lookup', async () => {
    const graph = getGraphMemory();
    const res = await graph.ingestText('The Checkout service uses Stripe. The Checkout service runs on Kubernetes.', { workspace: 'ws-1' });
    expect(res.entities).toContain('Stripe');
    expect(res.entities).toContain('Kubernetes');
    expect(res.relations).toBeGreaterThanOrEqual(1);

    const related = await graph.relatedFacts('Tell me about Checkout', { workspace: 'ws-1' });
    const rels = related.map(r => `${r.from} ${r.relation} ${r.to}`);
    expect(rels.some(r => r.includes('uses') || r.includes('runs_on'))).toBe(true);
  });

  it('models bi-temporal supersession of a single-valued relation', async () => {
    const graph = getGraphMemory();
    const checkout = await graph.upsertEntity('Checkout', { workspace: 'ws-2' });
    const mysql = await graph.upsertEntity('MySQL', { workspace: 'ws-2' });
    const postgres = await graph.upsertEntity('Postgres', { workspace: 'ws-2' });
    expect(checkout && mysql && postgres).toBeTruthy();

    await graph.relate(checkout!.id, 'stores_in', mysql!.id);
    // Migrate: now stored in Postgres → close the old edge.
    await graph.supersede(checkout!.id, 'stores_in', postgres!.id);

    // Currently-valid neighbours should point to Postgres, not MySQL.
    const current = graph.neighbors(checkout!.id).filter(e => e.relation === 'stores_in');
    expect(current.length).toBe(1);
    expect(current[0].dstId).toBe(postgres!.id);

    // The historical edge still exists (with valid_to set).
    const all = graph.neighbors(checkout!.id, { includeExpired: true }).filter(e => e.relation === 'stores_in');
    expect(all.length).toBe(2);
    const closed = all.find(e => e.dstId === mysql!.id);
    expect(closed?.validTo).toBeTruthy();
  });

  it('upsertEntity deduplicates by name within a workspace', async () => {
    const graph = getGraphMemory();
    const a = await graph.upsertEntity('Redis', { workspace: 'ws-3' });
    const b = await graph.upsertEntity('redis', { workspace: 'ws-3' });
    expect(a!.id).toBe(b!.id);

    const db = getDb();
    const count = (db.get("SELECT COUNT(*) AS n FROM memory_items WHERE source_type='entity'") as any).n;
    expect(count).toBe(1);
  });
});
