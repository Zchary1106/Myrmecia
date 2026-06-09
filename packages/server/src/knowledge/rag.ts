/**
 * RAG (Retrieval-Augmented Generation) / Vector Memory System
 *
 * Provides agents with long-term memory and knowledge retrieval:
 * - Document upload → chunking → embedding → storage
 * - Semantic search at execution time
 * - Per-workspace knowledge isolation
 * - Session memory persistence
 *
 * Backends:
 * - In-memory (development): simple cosine similarity search
 * - Pgvector (production): PostgreSQL extension
 * - Qdrant (optional): dedicated vector DB
 *
 * Configuration:
 * - VECTOR_BACKEND=memory|pgvector|qdrant (default: memory)
 * - EMBEDDING_MODEL — model for embeddings (default: text-embedding-3-small)
 * - QDRANT_URL — Qdrant endpoint (if backend=qdrant)
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';
import { getEmbeddingService } from '../memory/embedding.js';
import { getMemoryStore } from '../memory/memory-store.js';
import { Router } from 'express';

// ---------- Types ----------

export interface Document {
  id: string;
  workspaceId: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  chunkCount: number;
  createdAt: string;
}

export interface Chunk {
  id: string;
  documentId: string;
  content: string;
  embedding: number[];
  index: number;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface MemoryEntry {
  id: string;
  agentId: string;
  workspaceId: string;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- Vector Store Interface ----------

interface VectorStore {
  upsert(id: string, embedding: number[], metadata: Record<string, unknown>): void;
  search(embedding: number[], topK: number, filter?: Record<string, string>): Array<{ id: string; score: number }>;
  delete(id: string): void;
}

// ---------- In-Memory Vector Store ----------

class InMemoryVectorStore implements VectorStore {
  private vectors = new Map<string, { embedding: number[]; metadata: Record<string, unknown> }>();

  upsert(id: string, embedding: number[], metadata: Record<string, unknown>): void {
    this.vectors.set(id, { embedding, metadata });
  }

  search(embedding: number[], topK: number, filter?: Record<string, string>): Array<{ id: string; score: number }> {
    const results: Array<{ id: string; score: number }> = [];

    for (const [id, entry] of this.vectors) {
      if (filter) {
        const match = Object.entries(filter).every(([k, v]) => entry.metadata[k] === v);
        if (!match) continue;
      }
      const score = cosineSimilarity(embedding, entry.embedding);
      results.push({ id, score });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  delete(id: string): void {
    this.vectors.delete(id);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------- Embedding (uses shared service from memory/embedding.ts) ----------

async function getEmbedding(text: string): Promise<number[]> {
  return getEmbeddingService().embed(text);
}

// ---------- Chunking ----------

function chunkText(text: string, maxChunkSize = 1000, overlap = 200): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += maxChunkSize - overlap;
  }
  return chunks;
}

// ---------- RAG Service ----------

let vectorStore: VectorStore | undefined;

function getVectorStore(): VectorStore {
  if (!vectorStore) {
    const backend = process.env.VECTOR_BACKEND || 'memory';
    if (backend === 'pgvector') {
      // PgVectorStore is imported dynamically to avoid requiring 'pg' when not needed
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PgVectorStore } = require('./pgvector-store.js');
      vectorStore = new PgVectorStore() as VectorStore;
      logger.info('Using pgvector vector store');
    } else if (backend === 'memory') {
      vectorStore = new InMemoryVectorStore();
      logger.info('Using in-memory vector store');
    } else {
      logger.warn(`Vector backend "${backend}" not yet implemented, falling back to memory`);
      vectorStore = new InMemoryVectorStore();
    }
  }
  return vectorStore;
}

export const RAG_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSON NOT NULL DEFAULT '{}',
  chunk_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_id, workspace_id, key)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_docs_workspace ON knowledge_documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories(agent_id, workspace_id);
`;

// ---------- Public API ----------

export async function ingestDocument(workspaceId: string, title: string, content: string, metadata: Record<string, unknown> = {}): Promise<Document> {
  const db = getDb();
  const id = `doc_${uuid().slice(0, 8)}`;
  const chunks = chunkText(content);

  db.run(
    'INSERT INTO knowledge_documents (id, workspace_id, title, content, metadata, chunk_count) VALUES (?, ?, ?, ?, ?, ?)',
    id, workspaceId, title, content, JSON.stringify(metadata), chunks.length
  );

  // Embed and store each chunk
  const store = getVectorStore();
  for (let i = 0; i < chunks.length; i++) {
    const chunkId = `${id}_chunk_${i}`;
    const embedding = await getEmbedding(chunks[i]);
    store.upsert(chunkId, embedding, { documentId: id, workspaceId, index: i });

    // Bridge knowledge into the unified memory so it participates in recall /
    // context injection (reuses the embedding — no extra cost).
    if (process.env.MEMORY_KNOWLEDGE_BRIDGE !== 'false') {
      try {
        await getMemoryStore().add({
          type: 'semantic',
          content: chunks[i],
          embedding,
          scope: { workspace: workspaceId },
          importance: 0.5,
          sourceType: 'document',
          sourceId: id,
          metadata: { documentId: id, index: i, title },
        });
      } catch (err: any) {
        logger.warn({ err: err.message, docId: id }, 'knowledge→memory bridge failed');
      }
    }
  }

  logger.info({ docId: id, chunks: chunks.length }, 'Document ingested');
  return { id, workspaceId, title, content, metadata, chunkCount: chunks.length, createdAt: new Date().toISOString() };
}

export async function searchKnowledge(workspaceId: string, query: string, topK = 5): Promise<SearchResult[]> {
  const store = getVectorStore();
  const queryEmbedding = await getEmbedding(query);
  const results = store.search(queryEmbedding, topK, { workspaceId });

  const db = getDb();
  return results.map(r => {
    const [docId] = r.id.split('_chunk_');
    const doc = db.get('SELECT title, metadata FROM knowledge_documents WHERE id = ?', `doc_${docId.replace('doc_', '')}`) as any;
    // Retrieve chunk content from the original document
    const fullDoc = db.get('SELECT content FROM knowledge_documents WHERE id = ?', `doc_${docId.replace('doc_', '')}`) as any;
    const chunkIndex = parseInt(r.id.split('_chunk_')[1] || '0');
    const chunks = fullDoc ? chunkText(fullDoc.content) : [];

    return {
      chunkId: r.id,
      documentId: docId,
      content: chunks[chunkIndex] || '',
      score: r.score,
      metadata: doc?.metadata ? JSON.parse(doc.metadata) : {},
    };
  });
}

export function setAgentMemory(agentId: string, workspaceId: string, key: string, value: string): void {
  const db = getDb();
  db.run(
    `INSERT INTO agent_memories (id, agent_id, workspace_id, key, value)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, workspace_id, key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`,
    `mem_${uuid().slice(0, 8)}`, agentId, workspaceId, key, value, value
  );
}

export function getAgentMemory(agentId: string, workspaceId: string, key: string): string | undefined {
  const db = getDb();
  const row = db.get(
    'SELECT value FROM agent_memories WHERE agent_id = ? AND workspace_id = ? AND key = ?',
    agentId, workspaceId, key
  ) as { value: string } | undefined;
  return row?.value;
}

export function listAgentMemories(agentId: string, workspaceId: string): MemoryEntry[] {
  const db = getDb();
  return db.all(
    'SELECT * FROM agent_memories WHERE agent_id = ? AND workspace_id = ?',
    agentId, workspaceId
  );
}

// ---------- Routes ----------

export function createKnowledgeRoutes(): Router {
  const router = Router();

  // POST /knowledge/documents — upload and ingest a document
  router.post('/documents', async (req, res) => {
    const { title, content, metadata } = req.body;
    if (!title || !content) return res.status(400).json({ error: { message: 'title and content required' } });
    const workspaceId = (req as any).tenantContext?.workspaceId || 'default';
    const doc = await ingestDocument(workspaceId, title, content, metadata);
    res.status(201).json(doc);
  });

  // POST /knowledge/search — semantic search
  router.post('/search', async (req, res) => {
    const { query, topK } = req.body;
    if (!query) return res.status(400).json({ error: { message: 'query required' } });
    const workspaceId = (req as any).tenantContext?.workspaceId || 'default';
    const results = await searchKnowledge(workspaceId, query, topK);
    res.json(results);
  });

  // GET /knowledge/documents — list documents
  router.get('/documents', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || 'default';
    const db = getDb();
    const docs = db.all('SELECT id, workspace_id, title, chunk_count, created_at FROM knowledge_documents WHERE workspace_id = ? ORDER BY created_at DESC', workspaceId);
    res.json(docs);
  });

  return router;
}
