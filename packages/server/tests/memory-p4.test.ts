/**
 * P4 tests — reflection (insights + procedural lessons) and decay/forgetting.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { resetEmbeddingService } from '../src/memory/embedding.js';
import { getMemoryStore, resetMemoryStore } from '../src/memory/memory-store.js';
import { resetTrajectoryStore } from '../src/memory/trajectory-store.js';
import { resetWritePipeline } from '../src/memory/write-pipeline.js';
import { getReflectionService, resetReflectionService } from '../src/memory/reflection.js';
import { getMemoryMaintenance, resetMemoryMaintenance } from '../src/memory/decay.js';

function freshEnv() {
  process.env.EMBEDDING_BACKEND = 'pseudo';
  delete process.env.OPENAI_API_KEY;
  resetEmbeddingService();
  resetMemoryStore();
  resetTrajectoryStore();
  resetWritePipeline();
  resetReflectionService();
  resetMemoryMaintenance();
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-mem-p4-')), 'test.db');
  getDb();
}

function fakePipeline(): any {
  return {
    id: 'pl_1',
    name: 'Checkout Revamp',
    input: 'revamp the checkout flow with stripe',
    workspaceId: 'ws-1',
    templateId: 'feature',
    stages: [
      { name: 'Spec', agentRole: 'product-manager', status: 'done', taskId: 't1', output: 'The checkout uses Stripe for payments.' },
      { name: 'Build', agentRole: 'developer', status: 'done', taskId: 't2', output: 'We always validate Stripe webhooks with signing secrets.' },
    ],
  };
}

describe('ReflectionService', () => {
  beforeEach(() => { freshEnv(); });
  afterEach(() => { closeDb(); delete process.env.DB_PATH; delete process.env.EMBEDDING_BACKEND; });

  it('stores a reflection + a reusable procedural lesson', async () => {
    const result = await getReflectionService().reflectOnPipeline(fakePipeline());
    expect(result).not.toBeNull();
    expect(result!.lessonId).toBeTruthy();

    // Procedural lesson persisted and recallable.
    expect(getMemoryStore().size('procedural')).toBeGreaterThanOrEqual(1);
    const reflections = getMemoryStore().listReflections({ workspace: 'ws-1' });
    expect(reflections.length).toBe(1);
    expect(reflections[0].summary).toContain('Checkout Revamp');

    const recall = await getMemoryStore().recall({
      query: 'revamp the checkout flow with stripe',
      types: ['procedural'],
      scope: { workspace: 'ws-1' },
      topK: 3,
    });
    expect(recall.length).toBeGreaterThan(0);
  });

  it('respects MEMORY_REFLECTION_ENABLED=false', async () => {
    process.env.MEMORY_REFLECTION_ENABLED = 'false';
    try {
      const result = await getReflectionService().reflectOnPipeline(fakePipeline());
      expect(result).toBeNull();
    } finally {
      delete process.env.MEMORY_REFLECTION_ENABLED;
    }
  });
});

describe('MemoryMaintenance.runDecay', () => {
  beforeEach(() => { freshEnv(); });
  afterEach(() => { closeDb(); delete process.env.DB_PATH; delete process.env.EMBEDDING_BACKEND; });

  it('expires TTLs and prunes stale ephemeral/episodic memory but keeps durable facts', async () => {
    const store = getMemoryStore();
    const working = await store.add({ type: 'working', content: 'scratch note one two three' });
    const episode = await store.add({ type: 'episodic', content: 'an old low value episode', importance: 0.1 });
    const expiring = await store.add({ type: 'semantic', content: 'temporary value to expire soon' });
    const durable = await store.add({ type: 'semantic', content: 'The project uses pnpm and Node 20.', importance: 0.8 });

    const db = getDb();
    db.run("UPDATE memory_items SET created_at = datetime('now','-2 days') WHERE id = ?", working!.id);
    db.run("UPDATE memory_items SET created_at = datetime('now','-40 days'), access_count = 0 WHERE id = ?", episode!.id);
    db.run("UPDATE memory_items SET expires_at = datetime('now','-1 day') WHERE id = ?", expiring!.id);

    const result = await getMemoryMaintenance().runDecay();
    expect(result.prunedWorking).toBeGreaterThanOrEqual(1);
    expect(result.prunedEpisodic).toBeGreaterThanOrEqual(1);
    expect(result.expired).toBeGreaterThanOrEqual(1);

    expect(store.get(working!.id)).toBeUndefined();
    expect(store.get(episode!.id)).toBeUndefined();
    expect(store.get(expiring!.id)).toBeUndefined();
    // Durable, high-importance semantic memory survives.
    expect(store.get(durable!.id)).toBeDefined();
  });
});
