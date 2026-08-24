/**
 * Memory REST API — /api/v1/memory
 *
 * Browse, search, add and forget unified memories. Scoped to the caller's
 * workspace (tenant context) where applicable.
 */

import { Router } from 'express';
import { getMemoryStore } from '../memory/memory-store.js';
import { getMemoryService } from '../memory/memory-service.js';
import { getMemoryMaintenance } from '../memory/decay.js';
import { getGraphMemory } from '../memory/graph.js';
import { MEMORY_RELATIONS, MEMORY_TYPES, type MemoryRelation, type MemoryType } from '../memory/types.js';
import { getKnowledgeGraphService } from '../memory/knowledge-graph-service.js';
import {
  confirmKnowledgeCandidate,
  listKnowledgeCandidates,
  rejectKnowledgeCandidate,
} from '../memory/runtime-knowledge-bridge.js';

function parseTypes(value: unknown): MemoryType[] | undefined {
  if (!value) return undefined;
  const raw = String(value).split(',').map(s => s.trim());
  const types = raw.filter((t): t is MemoryType => (MEMORY_TYPES as readonly string[]).includes(t));
  return types.length ? types : undefined;
}

export function createMemoryRoutes(): Router {
  const router = Router();

  router.get('/candidates', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    res.json(listKnowledgeCandidates(workspaceId, limit));
  });

  router.post('/candidates/:id/confirm', async (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    const item = await confirmKnowledgeCandidate(req.params.id, workspaceId);
    if (!item) return res.status(404).json({ error: { message: 'Knowledge candidate not found' } });
    return res.json(stripEmbedding(item));
  });

  router.delete('/candidates/:id', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    if (!rejectKnowledgeCandidate(req.params.id, workspaceId)) {
      return res.status(404).json({ error: { message: 'Knowledge candidate not found' } });
    }
    return res.status(204).send();
  });

  // User-managed topology. These routes intentionally operate on confirmed
  // edges only; automatic extraction remains an independent suggestion flow.
  router.get('/graph', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    const types = parseTypes(req.query.type);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(getKnowledgeGraphService().list({ workspace: workspaceId, types, limit }));
  });

  router.post('/graph/edges', (req, res) => {
    const { sourceId, targetId, relation, weight } = req.body || {};
    if (!sourceId || !targetId || !MEMORY_RELATIONS.includes(relation as MemoryRelation)) {
      return res.status(400).json({ error: { message: 'sourceId, targetId and a supported relation are required' } });
    }
    try {
      const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
      const edge = getKnowledgeGraphService().create({ sourceId, targetId, relation, weight, workspace: workspaceId });
      return res.status(201).json(edge);
    } catch (error) {
      return res.status(400).json({ error: { message: error instanceof Error ? error.message : 'Unable to create memory relationship' } });
    }
  });

  router.delete('/graph/edges/:sourceId/:targetId/:relation', (req, res) => {
    const relation = req.params.relation as MemoryRelation;
    if (!MEMORY_RELATIONS.includes(relation)) {
      return res.status(400).json({ error: { message: 'Unsupported memory relationship' } });
    }
    try {
      getKnowledgeGraphService().remove(
        req.params.sourceId,
        req.params.targetId,
        relation,
        (req as any).tenantContext?.workspaceId || undefined,
      );
      return res.status(204).send();
    } catch {
      return res.status(404).json({ error: { message: 'Memory relationship not found' } });
    }
  });

  router.patch('/:id', async (req, res) => {
    const store = getMemoryStore();
    const existing = store.get(req.params.id);
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    if (!existing || (workspaceId && existing.scope.workspace !== workspaceId)) {
      return res.status(404).json({ error: { message: 'Memory not found' } });
    }
    const { content, summary, importance, metadata } = req.body || {};
    if (content !== undefined && typeof content !== 'string') {
      return res.status(400).json({ error: { message: 'content must be a string' } });
    }
    if (summary !== undefined && typeof summary !== 'string') {
      return res.status(400).json({ error: { message: 'summary must be a string' } });
    }
    if (importance !== undefined && (typeof importance !== 'number' || importance < 0 || importance > 1)) {
      return res.status(400).json({ error: { message: 'importance must be between 0 and 1' } });
    }
    if (metadata !== undefined && (typeof metadata !== 'object' || Array.isArray(metadata))) {
      return res.status(400).json({ error: { message: 'metadata must be an object' } });
    }
    if (content === undefined && summary === undefined && importance === undefined && metadata === undefined) {
      return res.status(400).json({ error: { message: 'At least one mutable field is required' } });
    }
    const updated = await store.update(req.params.id, { content, summary, importance, metadata });
    return res.json(stripEmbedding(updated!));
  });

  router.post('/:id/restore', (req, res) => {
    const store = getMemoryStore();
    const deleted = store.get(req.params.id, { includeDeleted: true });
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    if (!deleted || (workspaceId && deleted.scope.workspace !== workspaceId)) {
      return res.status(404).json({ error: { message: 'Memory not found' } });
    }
    const restored = store.restore(req.params.id);
    return res.json(stripEmbedding(restored!));
  });

  // GET /memory — list recent memories (?type=semantic,episodic&limit=50)
  router.get('/', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    // Default browse view excludes raw graph entity nodes.
    const types = parseTypes(req.query.type) ?? (['working', 'episodic', 'semantic', 'procedural'] as MemoryType[]);
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const items = getMemoryStore().list({ types, workspace: workspaceId, limit });
    res.json(items.map(stripEmbedding));
  });

  // GET /memory/stats — counts per type
  router.get('/stats', (_req, res) => {
    res.json({ counts: getMemoryStore().countByType(), total: getMemoryStore().size() });
  });

  // GET /memory/reflections — recent reflections
  router.get('/reflections', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    res.json(getMemoryStore().listReflections({ workspace: workspaceId, limit }));
  });

  // POST /memory/decay — run a maintenance/forgetting pass
  router.post('/decay', async (_req, res) => {
    const result = await getMemoryMaintenance().runDecay();
    res.json(result);
  });

  // POST /memory/graph/ingest — extract entities/relations from text
  router.post('/graph/ingest', async (req, res) => {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: { message: 'text required' } });
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    const result = await getGraphMemory().ingestText(String(text), workspaceId ? { workspace: workspaceId } : undefined);
    res.json(result);
  });

  // GET /memory/graph/related?query=... — graph-augmented lookup
  router.get('/graph/related', async (req, res) => {
    const query = req.query.query ? String(req.query.query) : '';
    if (!query) return res.status(400).json({ error: { message: 'query required' } });
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    const facts = await getGraphMemory().relatedFacts(query, workspaceId ? { workspace: workspaceId } : undefined);
    res.json(facts);
  });

  // POST /memory/recall — semantic retrieval { query, types?, topK? }
  router.post('/recall', async (req, res) => {
    const { query, types, topK, minScore } = req.body || {};
    if (!query) return res.status(400).json({ error: { message: 'query required' } });
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    const results = await getMemoryService().recall({
      query: String(query),
      types: Array.isArray(types) ? types : parseTypes(types),
      scope: workspaceId ? { workspace: workspaceId } : undefined,
      topK: topK ? Number(topK) : 8,
      minScore: minScore != null ? Number(minScore) : undefined,
    });
    res.json(results.map(r => ({ ...r, item: stripEmbedding(r.item) })));
  });

  // POST /memory — add a semantic memory { content, type?, importance?, summary? }
  router.post('/', async (req, res) => {
    const { content, type, importance, summary } = req.body || {};
    if (!content) return res.status(400).json({ error: { message: 'content required' } });
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    const item = await getMemoryService().remember(String(content), {
      type: parseTypes(type)?.[0] ?? 'semantic',
      importance: importance != null ? Number(importance) : undefined,
      summary: summary ? String(summary) : undefined,
      scope: workspaceId ? { workspace: workspaceId } : undefined,
      sourceType: 'user',
    });
    if (!item) return res.status(500).json({ error: { message: 'failed to store memory' } });
    res.status(201).json(stripEmbedding(item));
  });

  // DELETE /memory/:id — forget a memory
  router.delete('/:id', (req, res) => {
    const existing = getMemoryStore().get(req.params.id);
    const workspaceId = (req as any).tenantContext?.workspaceId || undefined;
    if (!existing || (workspaceId && existing.scope.workspace !== workspaceId)) {
      return res.status(404).json({ error: { message: 'memory not found' } });
    }
    getMemoryStore().forget(req.params.id);
    res.json({ ok: true, id: req.params.id });
  });

  return router;
}

function stripEmbedding<T extends { embedding?: number[] }>(item: T): Omit<T, 'embedding'> {
  const { embedding, ...rest } = item;
  return rest;
}
