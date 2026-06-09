/**
 * Graph Memory (P5) — lightweight bi-temporal entity/relation layer.
 *
 * Entities are stored as semantic memory nodes (source_type='entity'); relations
 * are bi-temporal edges in `memory_edges` with both a transaction time
 * (created_at) and a valid time (valid_from / valid_to), à la Zep/Graphiti.
 * This enables "what did we believe at time T" and graph-augmented recall.
 */

import { getMemoryStore, type SqliteMemoryStore } from './memory-store.js';
import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';
import type { MemoryItem, MemoryScope } from './types.js';

export interface GraphEdge {
  srcId: string;
  dstId: string;
  relation: string;
  weight: number;
  validFrom?: string;
  validTo?: string;
  createdAt?: string;
}

export interface IngestGraphResult {
  entities: string[];
  relations: number;
}

const STOPWORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'We', 'Our', 'You', 'Your', 'They', 'It',
  'A', 'An', 'And', 'Or', 'But', 'For', 'With', 'When', 'While', 'Then', 'There', 'Here',
  'I', 'He', 'She', 'If', 'In', 'On', 'At', 'To', 'Of', 'As', 'By', 'Set', 'Add', 'Use',
]);

const RELATION_PATTERNS: Array<{ re: RegExp; rel: string }> = [
  { re: /\b(runs?\s+on|deployed?\s+on|hosted?\s+on)\b/i, rel: 'runs_on' },
  { re: /\b(uses?|using|leverages?)\b/i, rel: 'uses' },
  { re: /\b(depends?\s+on|requires?)\b/i, rel: 'depends_on' },
  { re: /\b(stores?\s+in|persists?\s+in|saved?\s+in)\b/i, rel: 'stores_in' },
  { re: /\b(integrates?\s+with|connects?\s+to)\b/i, rel: 'integrates_with' },
];

/** Extract candidate entity names from text (CamelCase, capitalised, `backticked`). */
export function extractEntities(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  for (const m of text.matchAll(/`([^`]{2,40})`/g)) found.add(m[1].trim());
  // CamelCase / TitleCase tech terms and proper nouns.
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9.+#]{2,})\b/g)) {
    const term = m[1];
    if (STOPWORDS.has(term)) continue;
    found.add(term);
  }

  return Array.from(found).slice(0, 20);
}

export class GraphMemory {
  private store: SqliteMemoryStore;

  constructor(store?: SqliteMemoryStore) {
    this.store = store || getMemoryStore();
  }

  /** Upsert an entity node, deduplicated by name within the workspace scope. */
  async upsertEntity(name: string, scope?: MemoryScope): Promise<MemoryItem | null> {
    await this.store.initialize();
    const db = getDb();
    const existing = db.get(
      `SELECT id FROM memory_items
        WHERE source_type = 'entity' AND LOWER(content) = LOWER(?)
          AND (scope_workspace IS ? OR scope_workspace = ?)
        LIMIT 1`,
      name,
      scope?.workspace ?? null,
      scope?.workspace ?? null
    ) as { id: string } | undefined;
    if (existing) return this.store.get(existing.id) ?? null;

    return this.store.add({
      type: 'entity',
      content: name,
      scope,
      importance: 0.4,
      sourceType: 'entity',
      metadata: { kind: 'entity' },
    });
  }

  /** Create/refresh a bi-temporal relation edge between two entity nodes. */
  async relate(
    srcId: string,
    relation: string,
    dstId: string,
    opts: { weight?: number; validFrom?: string; validTo?: string } = {}
  ): Promise<void> {
    await this.store.initialize();
    const db = getDb();
    db.run(
      `INSERT INTO memory_edges (src_id, dst_id, relation, weight, valid_from, valid_to, created_at)
       VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, CURRENT_TIMESTAMP)
       ON CONFLICT(src_id, dst_id, relation) DO UPDATE SET
         weight = excluded.weight,
         valid_from = COALESCE(excluded.valid_from, memory_edges.valid_from),
         valid_to = excluded.valid_to`,
      srcId, dstId, relation, opts.weight ?? 1.0, opts.validFrom ?? null, opts.validTo ?? null
    );
  }

  /**
   * Supersede prior `(src, relation)` edges (close their valid_to = now) and add
   * a new current edge to `dstId`. Models a changing single-valued fact over time.
   */
  async supersede(srcId: string, relation: string, dstId: string): Promise<void> {
    await this.store.initialize();
    const db = getDb();
    db.run(
      `UPDATE memory_edges SET valid_to = CURRENT_TIMESTAMP
        WHERE src_id = ? AND relation = ? AND dst_id != ? AND valid_to IS NULL`,
      srcId, relation, dstId
    );
    await this.relate(srcId, relation, dstId);
  }

  /** Neighbouring edges of an entity, optionally valid at a given time. */
  neighbors(entityId: string, opts: { at?: string; includeExpired?: boolean } = {}): GraphEdge[] {
    const db = getDb();
    const rows = db.all(
      'SELECT * FROM memory_edges WHERE src_id = ? OR dst_id = ?',
      entityId, entityId
    ) as any[];

    const at = opts.at ? Date.parse(opts.at) : Date.now();
    return rows
      .map(toEdge)
      .filter(e => {
        if (opts.includeExpired) return true;
        const from = e.validFrom ? Date.parse(e.validFrom.replace(' ', 'T') + 'Z') : -Infinity;
        const to = e.validTo ? Date.parse(e.validTo.replace(' ', 'T') + 'Z') : Infinity;
        return from <= at && at < to;
      });
  }

  /** Extract entities + simple relations from text and persist them. */
  async ingestText(text: string, scope?: MemoryScope): Promise<IngestGraphResult> {
    if (process.env.MEMORY_GRAPH_ENABLED === 'false') return { entities: [], relations: 0 };
    await this.store.initialize();

    const sentences = text.split(/\n+|(?<=[.!?。！？])\s+/).map(s => s.trim()).filter(Boolean);
    const entitySet = new Set<string>();
    let relations = 0;

    for (const sentence of sentences) {
      const names = extractEntities(sentence);
      if (names.length === 0) continue;
      names.forEach(n => entitySet.add(n));

      if (names.length >= 2) {
        const rel = RELATION_PATTERNS.find(p => p.re.test(sentence))?.rel;
        if (rel) {
          try {
            const src = await this.upsertEntity(names[0], scope);
            const dst = await this.upsertEntity(names[1], scope);
            if (src && dst) {
              await this.relate(src.id, rel, dst.id);
              relations++;
            }
          } catch (err: any) {
            logger.warn({ err: err.message }, 'graph relate failed');
          }
        }
      }
    }

    // Ensure all mentioned entities exist as nodes.
    for (const name of entitySet) await this.upsertEntity(name, scope).catch(() => undefined);

    return { entities: Array.from(entitySet), relations };
  }

  /** Graph-augmented lookup: entities related to ones mentioned in the query. */
  async relatedFacts(query: string, scope?: MemoryScope): Promise<Array<{ from: string; relation: string; to: string }>> {
    await this.store.initialize();
    const db = getDb();
    const names = extractEntities(query);
    const out: Array<{ from: string; relation: string; to: string }> = [];

    for (const name of names) {
      const node = db.get(
        `SELECT id, content FROM memory_items
          WHERE source_type='entity' AND LOWER(content)=LOWER(?)
            AND (scope_workspace IS ? OR scope_workspace = ?) LIMIT 1`,
        name, scope?.workspace ?? null, scope?.workspace ?? null
      ) as { id: string; content: string } | undefined;
      if (!node) continue;

      for (const edge of this.neighbors(node.id)) {
        const other = edge.srcId === node.id ? edge.dstId : edge.srcId;
        const otherNode = this.store.get(other);
        if (!otherNode) continue;
        out.push(
          edge.srcId === node.id
            ? { from: node.content, relation: edge.relation, to: otherNode.content }
            : { from: otherNode.content, relation: edge.relation, to: node.content }
        );
      }
    }

    return out;
  }
}

function toEdge(row: any): GraphEdge {
  return {
    srcId: row.src_id,
    dstId: row.dst_id,
    relation: row.relation,
    weight: row.weight,
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to ?? undefined,
    createdAt: row.created_at ?? undefined,
  };
}

// ---------- Singleton ----------

let graph: GraphMemory | null = null;

export function getGraphMemory(): GraphMemory {
  if (!graph) graph = new GraphMemory();
  return graph;
}

export function resetGraphMemory(): void {
  graph = null;
}
