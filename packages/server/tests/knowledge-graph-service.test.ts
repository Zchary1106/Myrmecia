import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { resetEmbeddingService } from '../src/memory/embedding.js';
import { getMemoryStore, resetMemoryStore } from '../src/memory/memory-store.js';
import { KnowledgeGraphService } from '../src/memory/knowledge-graph-service.js';

describe('KnowledgeGraphService', () => {
  beforeEach(async () => {
    closeDb();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-graph-')), 'test.db');
    process.env.EMBEDDING_BACKEND = 'pseudo';
    resetEmbeddingService();
    resetMemoryStore();
    getDb();
    await getMemoryStore().initialize();
  });

  afterEach(() => {
    closeDb();
    resetMemoryStore();
    delete process.env.DB_PATH;
    delete process.env.EMBEDDING_BACKEND;
  });

  it('creates, lists and removes a workspace-scoped relationship', async () => {
    const store = getMemoryStore();
    const source = await store.add({ type: 'semantic', content: 'Redis persists queued work.', scope: { workspace: 'alpha' } });
    const target = await store.add({ type: 'entity', content: 'Recovery test evidence.', scope: { workspace: 'alpha' } });
    const graph = new KnowledgeGraphService();

    const edge = graph.create({ sourceId: source.id, targetId: target.id, relation: 'supports', workspace: 'alpha' });
    expect(edge.relation).toBe('supports');
    expect(graph.list({ workspace: 'alpha' })).toMatchObject({ nodes: expect.any(Array), edges: [expect.objectContaining({ sourceId: source.id })] });

    graph.remove(source.id, target.id, 'supports', 'alpha');
    expect(graph.list({ workspace: 'alpha' }).edges).toHaveLength(0);
  });

  it('rejects relationships across workspace boundaries', async () => {
    const store = getMemoryStore();
    const source = await store.add({ type: 'semantic', content: 'alpha', scope: { workspace: 'alpha' } });
    const target = await store.add({ type: 'semantic', content: 'beta', scope: { workspace: 'beta' } });

    expect(() => new KnowledgeGraphService().create({
      sourceId: source.id,
      targetId: target.id,
      relation: 'related_to',
      workspace: 'alpha',
    })).toThrow(/workspace/i);
  });

  it('limits topology nodes to the requested workspace', async () => {
    const store = getMemoryStore();
    await store.add({ type: 'semantic', content: 'alpha evidence', scope: { workspace: 'alpha' } });
    await store.add({ type: 'semantic', content: 'beta evidence', scope: { workspace: 'beta' } });

    const graph = new KnowledgeGraphService().list({ workspace: 'alpha' });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.scope.workspace).toBe('alpha');
  });
});
