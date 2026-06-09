/**
 * SqliteMemoryStore — Unified memory substrate (Phase 1)
 *
 * Backs all four memory layers with a single `memory_items` table plus a
 * dimension-adaptive HNSW index persisted in `hnsw_indexes`. Retrieval uses a
 * hybrid score (relevance + recency + importance + success) with MMR diversity,
 * mirroring the design in docs/MEMORY-ARCHITECTURE.md.
 */

import { v4 as uuid } from 'uuid';
import { HNSWIndex } from './hnsw.js';
import { getEmbeddingService, type EmbeddingService } from './embedding.js';
import {
  MEMORY_SCOPE_KEYS,
  type MemoryItem,
  type MemoryQuery,
  type MemoryScope,
  type MemoryStore,
  type MemoryType,
  type MemoryWriteInput,
  type ScoreWeights,
  type ScoredMemory,
} from './types.js';
import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';

// ---------- Schema ----------

export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('working','episodic','semantic','procedural','entity')),
  scope_org TEXT,
  scope_workspace TEXT,
  scope_user TEXT,
  scope_agent TEXT,
  scope_session TEXT,
  scope_pipeline TEXT,
  content TEXT NOT NULL,
  summary TEXT,
  embedding BLOB,
  importance REAL NOT NULL DEFAULT 0.5,
  success REAL,
  quality REAL,
  source_type TEXT,
  source_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at DATETIME,
  access_count INTEGER NOT NULL DEFAULT 0,
  valid_from DATETIME,
  valid_to DATETIME,
  expires_at DATETIME,
  metadata JSON NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_mem_type ON memory_items(type);
CREATE INDEX IF NOT EXISTS idx_mem_workspace ON memory_items(scope_workspace);
CREATE INDEX IF NOT EXISTS idx_mem_agent ON memory_items(scope_agent);
CREATE INDEX IF NOT EXISTS idx_mem_source ON memory_items(source_type, source_id);

CREATE TABLE IF NOT EXISTS memory_edges (
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  valid_from DATETIME DEFAULT CURRENT_TIMESTAMP,
  valid_to DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (src_id, dst_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_mem_edges_src ON memory_edges(src_id);
CREATE INDEX IF NOT EXISTS idx_mem_edges_dst ON memory_edges(dst_id);

CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY,
  scope_workspace TEXT,
  scope_pipeline TEXT,
  summary TEXT NOT NULL,
  insights JSON NOT NULL DEFAULT '[]',
  source_episode_ids JSON NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hnsw_indexes (
  name TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

const INDEX_NAME = 'memory';

// ---------- Helpers ----------

function defaultWeights(): ScoreWeights {
  return {
    relevance: Number(process.env.MEMORY_SCORE_W_RELEVANCE ?? 0.55),
    recency: Number(process.env.MEMORY_SCORE_W_RECENCY ?? 0.15),
    importance: Number(process.env.MEMORY_SCORE_W_IMPORTANCE ?? 0.2),
    success: Number(process.env.MEMORY_SCORE_W_SUCCESS ?? 0.1),
  };
}

function defaultTauDays(): number {
  return Number(process.env.MEMORY_RECENCY_TAU_DAYS ?? 14);
}

function embeddingToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

function blobToEmbedding(blob: unknown): number[] {
  if (!blob) return [];
  const buf = blob as Buffer;
  return Array.from(new Float32Array(buf.buffer || buf, buf.byteOffset || 0, Math.floor(buf.byteLength / 4)));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function rowToItem(row: any): MemoryItem {
  return {
    id: row.id,
    type: row.type,
    scope: {
      org: row.scope_org ?? undefined,
      workspace: row.scope_workspace ?? undefined,
      user: row.scope_user ?? undefined,
      agent: row.scope_agent ?? undefined,
      session: row.scope_session ?? undefined,
      pipeline: row.scope_pipeline ?? undefined,
    },
    content: row.content,
    summary: row.summary ?? undefined,
    embedding: row.embedding ? blobToEmbedding(row.embedding) : undefined,
    importance: row.importance,
    success: row.success ?? undefined,
    quality: row.quality ?? undefined,
    sourceType: row.source_type ?? undefined,
    sourceId: row.source_id ?? undefined,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at ?? undefined,
    accessCount: row.access_count ?? 0,
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    metadata: safeJson(row.metadata),
  };
}

/** Parse a SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) or ISO string to epoch ms. */
function parseDbTime(value: string): number {
  if (!value) return Date.now();
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
  const ts = Date.parse(withZone);
  return Number.isNaN(ts) ? Date.now() : ts;
}

function safeJson(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function safeArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as string[];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * An item is in-scope for a query when, for every scope dimension the *item*
 * constrains, the query provides the same value. Items with an unset dimension
 * are global on that axis and always match. This prevents leaking
 * workspace/user-scoped memories into broader queries.
 */
function itemMatchesScope(item: MemoryItem, queryScope?: MemoryScope): boolean {
  for (const key of MEMORY_SCOPE_KEYS) {
    const itemVal = item.scope[key];
    if (itemVal == null) continue;
    if (queryScope?.[key] !== itemVal) return false;
  }
  return true;
}

// ---------- Store ----------

export class SqliteMemoryStore implements MemoryStore {
  private index: HNSWIndex | null = null;
  private embedding: EmbeddingService;
  private initialized = false;
  private addsSincePersist = 0;

  constructor(embeddingService?: EmbeddingService) {
    this.embedding = embeddingService || getEmbeddingService();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDb();
    db.exec(MEMORY_SCHEMA);

    const saved = db.get(
      'SELECT data, dimensions FROM hnsw_indexes WHERE name = ?',
      INDEX_NAME
    ) as { data: Buffer; dimensions: number } | undefined;

    if (saved && saved.dimensions === this.embedding.dimensions) {
      try {
        this.index = HNSWIndex.deserialize(saved.data);
        logger.info({ entries: this.index.size() }, 'Loaded unified memory HNSW index');
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Failed to deserialize memory index, rebuilding');
        this.index = null;
      }
    }

    if (!this.index) {
      this.index = new HNSWIndex({ dimensions: this.embedding.dimensions });
      this.rebuildIndex();
    }

    this.initialized = true;
  }

  async add(input: MemoryWriteInput): Promise<MemoryItem> {
    await this.initialize();

    const id = `mem_${uuid().slice(0, 12)}`;
    const embedding = input.embedding ?? (await this.embedding.embed(input.summary || input.content));
    const scope = input.scope || {};
    const importance = clamp01(input.importance ?? 0.5);

    const db = getDb();
    db.run(
      `INSERT INTO memory_items (
        id, type, scope_org, scope_workspace, scope_user, scope_agent, scope_session, scope_pipeline,
        content, summary, embedding, importance, success, quality, source_type, source_id,
        valid_from, valid_to, expires_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.type,
      scope.org ?? null,
      scope.workspace ?? null,
      scope.user ?? null,
      scope.agent ?? null,
      scope.session ?? null,
      scope.pipeline ?? null,
      input.content,
      input.summary ?? null,
      embeddingToBlob(embedding),
      importance,
      input.success ?? null,
      input.quality ?? null,
      input.sourceType ?? null,
      input.sourceId ?? null,
      input.validFrom ?? null,
      input.validTo ?? null,
      input.expiresAt ?? null,
      JSON.stringify(input.metadata ?? {})
    );

    if (embedding.length === this.embedding.dimensions) {
      this.index!.add(id, embedding);
      this.addsSincePersist++;
      if (this.addsSincePersist >= 10) this.persist();
    }

    return this.get(id)!;
  }

  get(id: string): MemoryItem | undefined {
    const db = getDb();
    const row = db.get('SELECT * FROM memory_items WHERE id = ?', id);
    return row ? rowToItem(row) : undefined;
  }

  /** Update mutable fields of a memory; re-embeds + re-indexes when content/summary change. */
  async update(
    id: string,
    patch: { content?: string; summary?: string; importance?: number; metadata?: Record<string, unknown> }
  ): Promise<MemoryItem | undefined> {
    await this.initialize();
    const existing = this.get(id);
    if (!existing) return undefined;

    const db = getDb();
    const sets: string[] = [];
    const params: any[] = [];
    let embedding: number[] | undefined;

    if (patch.content !== undefined) { sets.push('content = ?'); params.push(patch.content); }
    if (patch.summary !== undefined) { sets.push('summary = ?'); params.push(patch.summary); }
    if (patch.importance !== undefined) { sets.push('importance = ?'); params.push(clamp01(patch.importance)); }
    if (patch.metadata !== undefined) { sets.push('metadata = ?'); params.push(JSON.stringify(patch.metadata)); }

    if (patch.content !== undefined || patch.summary !== undefined) {
      const summary = patch.summary ?? existing.summary;
      const content = patch.content ?? existing.content;
      embedding = await this.embedding.embed(summary || content);
      sets.push('embedding = ?');
      params.push(embeddingToBlob(embedding));
    }

    if (sets.length === 0) return existing;
    params.push(id);
    db.run(`UPDATE memory_items SET ${sets.join(', ')} WHERE id = ?`, ...params);

    if (embedding && embedding.length === this.embedding.dimensions) {
      this.index!.remove(id);
      this.index!.add(id, embedding);
      this.persist();
    }

    return this.get(id);
  }

  async recall(query: MemoryQuery): Promise<ScoredMemory[]> {
    await this.initialize();
    if (this.index!.size() === 0) return [];

    const topK = query.topK ?? 5;
    const weights = { ...defaultWeights(), ...query.weights };
    const tau = (query.recencyTauDays ?? defaultTauDays()) * 24 * 60 * 60 * 1000;
    const lambda = query.mmrLambda ?? 0.7;
    const now = Date.now();

    const queryEmbedding = await this.embedding.embed(query.query);
    // Over-fetch so scope/type filtering still leaves enough candidates.
    const pool = this.index!.search(queryEmbedding, Math.max(topK * 5, 25));

    const db = getDb();
    const scored: Array<ScoredMemory & { embedding: number[] }> = [];

    for (const hit of pool) {
      const row = db.get('SELECT * FROM memory_items WHERE id = ?', hit.id);
      if (!row) continue;
      const item = rowToItem(row);

      if (query.types && !query.types.includes(item.type)) continue;
      if (!itemMatchesScope(item, query.scope)) continue;
      if (!query.includeExpired && item.expiresAt && parseDbTime(item.expiresAt) < now) continue;

      const relevance = 1 - hit.distance;
      const ageMs = now - parseDbTime(item.createdAt);
      const recency = Math.exp(-Math.max(0, ageMs) / tau);
      const success = item.success ?? 0.5;
      const score =
        weights.relevance * relevance +
        weights.recency * recency +
        weights.importance * item.importance +
        weights.success * success;

      scored.push({ item, score, relevance, embedding: item.embedding ?? [] });
    }

    if (scored.length === 0) return [];
    scored.sort((a, b) => b.score - a.score);

    const selected = this.mmrRerank(scored, topK, lambda);

    const filtered = selected.filter(s => (query.minScore == null ? true : s.score >= query.minScore));
    for (const s of filtered) this.touch(s.item.id);

    return filtered.map(({ item, score, relevance }) => ({ item, score, relevance }));
  }

  forget(id: string): void {
    const db = getDb();
    db.run('DELETE FROM memory_items WHERE id = ?', id);
    this.index?.remove(id);
    this.persist();
  }

  touch(id: string): void {
    const db = getDb();
    db.run(
      'UPDATE memory_items SET last_accessed_at = CURRENT_TIMESTAMP, access_count = access_count + 1 WHERE id = ?',
      id
    );
  }

  size(type?: MemoryType): number {
    const db = getDb();
    const row = type
      ? (db.get('SELECT COUNT(*) AS n FROM memory_items WHERE type = ?', type) as any)
      : (db.get('SELECT COUNT(*) AS n FROM memory_items') as any);
    return row?.n ?? 0;
  }

  /** List recent memories (newest first), optionally filtered by type and workspace. */
  list(opts: { types?: MemoryType[]; workspace?: string; limit?: number } = {}): MemoryItem[] {
    const db = getDb();
    const conds: string[] = [];
    const params: any[] = [];
    if (opts.types && opts.types.length) {
      conds.push(`type IN (${opts.types.map(() => '?').join(',')})`);
      params.push(...opts.types);
    }
    if (opts.workspace) {
      conds.push('(scope_workspace = ? OR scope_workspace IS NULL)');
      params.push(opts.workspace);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    params.push(limit);
    const rows = db.all(`SELECT * FROM memory_items ${where} ORDER BY created_at DESC LIMIT ?`, ...params) as any[];
    return rows.map(rowToItem);
  }

  /** Count memories grouped by type. */
  countByType(): Record<string, number> {
    const db = getDb();
    const rows = db.all('SELECT type, COUNT(*) AS n FROM memory_items GROUP BY type') as Array<{ type: string; n: number }>;
    const out: Record<string, number> = { working: 0, episodic: 0, semantic: 0, procedural: 0, entity: 0 };
    for (const r of rows) out[r.type] = r.n;
    return out;
  }

  /** Persist a reflection record (summary + insights derived from episodes). */
  addReflection(input: {
    scope?: MemoryScope;
    summary: string;
    insights?: string[];
    sourceEpisodeIds?: string[];
  }): string {
    const db = getDb();
    const id = `refl_${uuid().slice(0, 12)}`;
    db.run(
      `INSERT INTO reflections (id, scope_workspace, scope_pipeline, summary, insights, source_episode_ids)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.scope?.workspace ?? null,
      input.scope?.pipeline ?? null,
      input.summary,
      JSON.stringify(input.insights ?? []),
      JSON.stringify(input.sourceEpisodeIds ?? [])
    );
    return id;
  }

  listReflections(opts: { workspace?: string; limit?: number } = {}): Array<{
    id: string; summary: string; insights: string[]; sourceEpisodeIds: string[]; createdAt: string;
  }> {
    const db = getDb();
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const rows = opts.workspace
      ? (db.all('SELECT * FROM reflections WHERE scope_workspace = ? ORDER BY created_at DESC LIMIT ?', opts.workspace, limit) as any[])
      : (db.all('SELECT * FROM reflections ORDER BY created_at DESC LIMIT ?', limit) as any[]);
    return rows.map(r => ({
      id: r.id,
      summary: r.summary,
      insights: safeArray(r.insights),
      sourceEpisodeIds: safeArray(r.source_episode_ids),
      createdAt: r.created_at,
    }));
  }

  persist(): void {
    if (!this.index) return;
    const db = getDb();
    const data = this.index.serialize();
    db.run(
      `INSERT INTO hnsw_indexes (name, data, dimensions, entry_count, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(name) DO UPDATE SET data = ?, dimensions = ?, entry_count = ?, updated_at = CURRENT_TIMESTAMP`,
      INDEX_NAME, data, this.embedding.dimensions, this.index.size(),
      data, this.embedding.dimensions, this.index.size()
    );
    this.addsSincePersist = 0;
  }

  /** Rebuild the HNSW index from persisted rows whose embedding dimension matches. */
  private rebuildIndex(): void {
    const db = getDb();
    const rows = db.all('SELECT id, embedding FROM memory_items WHERE embedding IS NOT NULL') as any[];
    this.index = new HNSWIndex({ dimensions: this.embedding.dimensions });

    let added = 0;
    for (const row of rows) {
      try {
        const embedding = blobToEmbedding(row.embedding);
        if (embedding.length === this.embedding.dimensions) {
          this.index.add(row.id, embedding);
          added++;
        }
      } catch {
        // skip corrupted entries
      }
    }

    if (added > 0) {
      logger.info({ rebuilt: added }, 'Rebuilt unified memory HNSW index');
      this.persist();
    }
  }

  /** Maximal Marginal Relevance re-ranking for diversity. */
  private mmrRerank(
    candidates: Array<ScoredMemory & { embedding: number[] }>,
    topK: number,
    lambda: number
  ): Array<ScoredMemory & { embedding: number[] }> {
    if (candidates.length <= topK || lambda >= 1) return candidates.slice(0, topK);

    const selected: Array<ScoredMemory & { embedding: number[] }> = [];
    const pool = [...candidates];

    while (selected.length < topK && pool.length > 0) {
      let bestIdx = 0;
      let bestVal = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        let maxSim = 0;
        for (const s of selected) {
          const sim = cosineSimilarity(c.embedding, s.embedding);
          if (sim > maxSim) maxSim = sim;
        }
        const val = lambda * c.score - (1 - lambda) * maxSim;
        if (val > bestVal) {
          bestVal = val;
          bestIdx = i;
        }
      }
      selected.push(pool.splice(bestIdx, 1)[0]);
    }

    return selected;
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// ---------- Singleton ----------

let store: SqliteMemoryStore | null = null;

export function getMemoryStore(): SqliteMemoryStore {
  if (!store) store = new SqliteMemoryStore();
  return store;
}

export function resetMemoryStore(): void {
  store = null;
}
