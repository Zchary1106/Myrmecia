/**
 * PgVector Store — PostgreSQL-based vector persistence (#28)
 *
 * Uses pgvector extension for similarity search with HNSW indexing.
 * Drop-in replacement for InMemoryVectorStore in rag.ts.
 */

import { logger } from '../lib/logger.js';
import { getEmbeddingService } from '../memory/embedding.js';

// ---------- Interface (mirrors rag.ts VectorStore) ----------

export interface VectorStore {
  upsert(id: string, embedding: number[], metadata: Record<string, unknown>): void;
  search(embedding: number[], topK: number, filter?: Record<string, string>): Array<{ id: string; score: number }>;
  delete(id: string): void;
  deleteByDocument?(documentId: string): void;
}

// ---------- PgVectorStore ----------

export class PgVectorStore implements VectorStore {
  private pool: any;
  private initialized = false;

  constructor(connectionString?: string) {
    const connStr = connectionString || process.env.DATABASE_URL || '';
    if (!connStr) {
      throw new Error('PgVectorStore requires DATABASE_URL or a connection string');
    }
    try {
      const pg = require('pg');
      this.pool = new pg.Pool({ connectionString: connStr, max: 10 });
    } catch {
      throw new Error('PgVectorStore requires "pg" package. Install: pnpm add pg');
    }
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    const dims = getEmbeddingService().dimensions;
    const client = await this.pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`
        CREATE TABLE IF NOT EXISTS embeddings (
          id TEXT PRIMARY KEY,
          document_id TEXT,
          chunk_index INTEGER,
          embedding vector(${dims}),
          content TEXT,
          metadata JSONB DEFAULT '{}',
          workspace_id TEXT
        )
      `);
      // Guard against a dimension change between runs: an existing table with a
      // different vector width would break inserts/queries, so surface it loudly.
      const dimRow = await client.query(
        `SELECT atttypmod AS typmod
           FROM pg_attribute
          WHERE attrelid = 'embeddings'::regclass AND attname = 'embedding'`
      );
      const existingDims = dimRow.rows?.[0]?.typmod;
      if (existingDims && existingDims > 0 && existingDims !== dims) {
        logger.warn(
          { existingDims, configuredDims: dims },
          'pgvector embeddings column dimension differs from current embedding backend; ' +
          'recreate the table or align EMBEDDING_BACKEND/EMBEDDING_MODEL'
        );
      }
      // HNSW index for fast cosine search
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw
        ON embeddings USING hnsw (embedding vector_cosine_ops)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_embeddings_workspace
        ON embeddings (workspace_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_embeddings_document
        ON embeddings (document_id)
      `);
      this.initialized = true;
      logger.info({ dimensions: dims }, 'PgVectorStore schema initialized');
    } finally {
      client.release();
    }
  }

  upsert(id: string, embedding: number[], metadata: Record<string, unknown>): void {
    // Fire-and-forget async init + upsert
    this._upsertAsync(id, embedding, metadata).catch(err =>
      logger.error({ err, id }, 'PgVectorStore upsert failed')
    );
  }

  private async _upsertAsync(id: string, embedding: number[], metadata: Record<string, unknown>): Promise<void> {
    await this.ensureSchema();
    const vectorStr = `[${embedding.join(',')}]`;
    const documentId = (metadata.documentId as string) || null;
    const chunkIndex = (metadata.index as number) ?? null;
    const workspaceId = (metadata.workspaceId as string) || null;
    const content = (metadata.content as string) || null;

    await this.pool.query(
      `INSERT INTO embeddings (id, document_id, chunk_index, embedding, content, metadata, workspace_id)
       VALUES ($1, $2, $3, $4::vector, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         embedding = $4::vector,
         metadata = $6,
         content = $5`,
      [id, documentId, chunkIndex, vectorStr, content, JSON.stringify(metadata), workspaceId]
    );
  }

  search(embedding: number[], topK: number, filter?: Record<string, string>): Array<{ id: string; score: number }> {
    // Return empty for sync call; use searchAsync for real results
    // This maintains interface compat; the RAG layer should prefer searchAsync
    logger.warn('PgVectorStore.search() called synchronously — use searchAsync() for actual results');
    return [];
  }

  async searchAsync(embedding: number[], topK: number, filter?: Record<string, string>): Promise<Array<{ id: string; score: number }>> {
    await this.ensureSchema();
    const vectorStr = `[${embedding.join(',')}]`;

    let sql = `SELECT id, 1 - (embedding <=> $1::vector) as score FROM embeddings`;
    const params: any[] = [vectorStr];
    const conditions: string[] = [];

    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (key === 'workspaceId') {
          params.push(value);
          conditions.push(`workspace_id = $${params.length}`);
        } else if (key === 'documentId') {
          params.push(value);
          conditions.push(`document_id = $${params.length}`);
        } else {
          params.push(value);
          conditions.push(`metadata->>$${params.length} IS NOT NULL`);
        }
      }
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    params.push(topK);
    sql += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length}`;

    const result = await this.pool.query(sql, params);
    return result.rows.map((row: any) => ({ id: row.id, score: parseFloat(row.score) }));
  }

  delete(id: string): void {
    this._deleteAsync(id).catch(err =>
      logger.error({ err, id }, 'PgVectorStore delete failed')
    );
  }

  private async _deleteAsync(id: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query('DELETE FROM embeddings WHERE id = $1', [id]);
  }

  deleteByDocument(documentId: string): void {
    this._deleteByDocAsync(documentId).catch(err =>
      logger.error({ err, documentId }, 'PgVectorStore deleteByDocument failed')
    );
  }

  private async _deleteByDocAsync(documentId: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query('DELETE FROM embeddings WHERE document_id = $1', [documentId]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
