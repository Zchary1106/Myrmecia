/**
 * Tests for the unified SqliteMemoryStore + TrajectoryStore adapter (Phase 1).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { resetEmbeddingService } from '../src/memory/embedding.js';
import { getMemoryStore, resetMemoryStore, SqliteMemoryStore } from '../src/memory/memory-store.js';
import { getTrajectoryStore, resetTrajectoryStore } from '../src/memory/trajectory-store.js';

function freshDb() {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-memory-')), 'test.db');
  getDb();
}

describe('SqliteMemoryStore', () => {
  let store: SqliteMemoryStore;

  beforeEach(async () => {
    process.env.EMBEDDING_BACKEND = 'pseudo';
    delete process.env.OPENAI_API_KEY;
    resetEmbeddingService();
    resetMemoryStore();
    resetTrajectoryStore();
    freshDb();
    store = getMemoryStore();
    await store.initialize();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
    delete process.env.EMBEDDING_BACKEND;
  });

  it('adds and recalls a memory by semantic similarity', async () => {
    await store.add({ type: 'semantic', content: 'The deploy pipeline uses Redis for the BullMQ queue.' });
    await store.add({ type: 'semantic', content: 'The frontend dashboard is built with React and Vite.' });

    const results = await store.recall({ query: 'The deploy pipeline uses Redis for the BullMQ queue.', topK: 1 });
    expect(results.length).toBe(1);
    expect(results[0].item.content).toContain('Redis');
    expect(results[0].relevance).toBeGreaterThan(0.9);
  });

  it('filters by memory type', async () => {
    await store.add({ type: 'semantic', content: 'alpha bravo charlie' });
    await store.add({ type: 'procedural', content: 'alpha bravo charlie' });

    const results = await store.recall({ query: 'alpha bravo charlie', types: ['procedural'], topK: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.item.type === 'procedural')).toBe(true);
  });

  it('enforces scope isolation', async () => {
    await store.add({ type: 'semantic', content: 'workspace secret note', scope: { workspace: 'ws-a' } });

    // Query without the workspace should NOT see a workspace-scoped item.
    const unscoped = await store.recall({ query: 'workspace secret note', topK: 10 });
    expect(unscoped.find(r => r.item.scope.workspace === 'ws-a')).toBeUndefined();

    // Wrong workspace should not see it either.
    const wrong = await store.recall({ query: 'workspace secret note', scope: { workspace: 'ws-b' }, topK: 10 });
    expect(wrong.find(r => r.item.scope.workspace === 'ws-a')).toBeUndefined();

    // Matching workspace sees it.
    const right = await store.recall({ query: 'workspace secret note', scope: { workspace: 'ws-a' }, topK: 10 });
    expect(right.find(r => r.item.scope.workspace === 'ws-a')).toBeDefined();
  });

  it('forgets a memory', async () => {
    const item = await store.add({ type: 'semantic', content: 'forget me please' });
    expect(store.get(item.id)).toBeDefined();
    store.forget(item.id);
    expect(store.get(item.id)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('tracks access stats on recall', async () => {
    const item = await store.add({ type: 'semantic', content: 'access tracked content' });
    await store.recall({ query: 'access tracked content', topK: 1 });
    const reloaded = store.get(item.id)!;
    expect(reloaded.accessCount).toBeGreaterThanOrEqual(1);
    expect(reloaded.lastAccessedAt).toBeTruthy();
  });

  it('persists and reloads the HNSW index across instances', async () => {
    await store.add({ type: 'semantic', content: 'persisted content one' });
    await store.add({ type: 'semantic', content: 'persisted content two' });
    store.persist();

    resetMemoryStore();
    const reopened = getMemoryStore();
    await reopened.initialize();
    expect(reopened.size()).toBe(2);
    const results = await reopened.recall({ query: 'persisted content one', topK: 1 });
    expect(results.length).toBe(1);
  });
});

describe('TrajectoryStore (adapter)', () => {
  beforeEach(() => {
    process.env.EMBEDDING_BACKEND = 'pseudo';
    delete process.env.OPENAI_API_KEY;
    resetEmbeddingService();
    resetMemoryStore();
    resetTrajectoryStore();
    freshDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
    delete process.env.EMBEDDING_BACKEND;
  });

  it('records executions and recommends a route from history', async () => {
    const store = getTrajectoryStore();
    const input = 'implement an oauth login page with google sign in';
    for (let i = 0; i < 3; i++) {
      await store.record({
        taskInput: input,
        agentId: 'dev',
        mode: 'direct',
        success: true,
        quality: 0.9,
        durationMs: 30000,
      });
    }

    const rec = await store.recommendRoute(input);
    expect(rec).not.toBeNull();
    expect(rec!.suggestedAgent).toBe('dev');
    expect(rec!.suggestedMode).toBe('direct');
    expect(rec!.confidence).toBeGreaterThan(0.5);
  });

  it('writes trajectories into the unified memory_items table as episodic', async () => {
    const store = getTrajectoryStore();
    await store.record({
      taskInput: 'add dark mode toggle',
      agentId: 'ui',
      mode: 'pipeline',
      templateId: 'feature',
      success: true,
      quality: 0.8,
      durationMs: 12000,
    });

    const db = getDb();
    const row = db.get("SELECT * FROM memory_items WHERE type='episodic' LIMIT 1") as any;
    expect(row).toBeDefined();
    const meta = JSON.parse(row.metadata);
    expect(meta.agentId).toBe('ui');
    expect(meta.mode).toBe('pipeline');
  });
});
