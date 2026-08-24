import { getDb } from '../db/database.js';
import { getMemoryStore } from './memory-store.js';
import {
  MEMORY_RELATIONS,
  type MemoryEdge,
  type MemoryGraph,
  type MemoryRelation,
  type MemoryType,
} from './types.js';

export interface KnowledgeGraphListOptions {
  workspace?: string;
  types?: MemoryType[];
  limit?: number;
}

export interface CreateKnowledgeEdgeInput {
  sourceId: string;
  targetId: string;
  relation: MemoryRelation;
  weight?: number;
  workspace?: string;
}

function asEdge(row: Record<string, unknown>): MemoryEdge {
  return {
    sourceId: String(row.src_id),
    targetId: String(row.dst_id),
    relation: String(row.relation) as MemoryRelation,
    weight: Number(row.weight ?? 1),
    metadata: {},
    createdAt: String(row.created_at),
    validFrom: row.valid_from ? String(row.valid_from) : undefined,
    validTo: row.valid_to ? String(row.valid_to) : undefined,
  };
}

/**
 * The editable topology is intentionally a thin layer on top of the existing
 * memory_items/memory_edges tables. It does not run extraction or alter agent
 * recall; it only exposes confirmed, workspace-scoped relationships.
 */
export class KnowledgeGraphService {
  list(options: KnowledgeGraphListOptions = {}): MemoryGraph {
    const db = getDb();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.workspace) {
      clauses.push('scope_workspace = ?');
      params.push(options.workspace);
    } else {
      clauses.push('scope_workspace IS NULL');
    }
    if (options.types?.length) {
      clauses.push('type IN (' + options.types.map(() => '?').join(', ') + ')');
      params.push(...options.types);
    }
    const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 500);
    const ids = (db.all(
      "SELECT id FROM memory_items WHERE deleted_at IS NULL AND COALESCE(json_extract(metadata, '$.knowledgeStatus'), 'confirmed') != 'candidate' AND " + clauses.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?',
      ...params,
      limit,
    ) as Array<{ id: string }>).map(row => row.id);
    const nodes = ids.map(id => getMemoryStore().get(id)).filter(Boolean);
    if (!nodes.length) return { nodes: [], edges: [] };

    const placeholders = nodes.map(() => '?').join(', ');
    const idsForQuery = nodes.map(node => node!.id);
    const edges = (db.all(
      'SELECT * FROM memory_edges WHERE valid_to IS NULL AND src_id IN (' + placeholders + ') AND dst_id IN (' + placeholders + ')',
      ...idsForQuery,
      ...idsForQuery,
    ) as Array<Record<string, unknown>>)
      .filter(row => MEMORY_RELATIONS.includes(String(row.relation) as MemoryRelation))
      .map(asEdge);
    return { nodes: nodes as MemoryGraph['nodes'], edges };
  }

  create(input: CreateKnowledgeEdgeInput): MemoryEdge {
    if (!MEMORY_RELATIONS.includes(input.relation)) throw new Error('Unsupported memory relationship');
    if (!input.sourceId || !input.targetId || input.sourceId === input.targetId) {
      throw new Error('Two distinct memory nodes are required');
    }
    const store = getMemoryStore();
    const source = store.get(input.sourceId);
    const target = store.get(input.targetId);
    if (!source || !target) throw new Error('Memory node not found');
    if (source.scope.workspace !== target.scope.workspace || (input.workspace && input.workspace !== source.scope.workspace)) {
      throw new Error('Memory relationships must remain inside one workspace');
    }
    const weight = Math.min(1, Math.max(0, Number.isFinite(input.weight) ? Number(input.weight) : 1));
    const db = getDb();
    db.run(
      'INSERT INTO memory_edges (src_id, dst_id, relation, weight, valid_from, valid_to, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP) ON CONFLICT(src_id, dst_id, relation) DO UPDATE SET weight = excluded.weight, valid_from = CURRENT_TIMESTAMP, valid_to = NULL',
      input.sourceId,
      input.targetId,
      input.relation,
      weight,
    );
    return asEdge(db.get(
      'SELECT * FROM memory_edges WHERE src_id = ? AND dst_id = ? AND relation = ? AND valid_to IS NULL',
      input.sourceId,
      input.targetId,
      input.relation,
    ) as Record<string, unknown>);
  }

  remove(sourceId: string, targetId: string, relation: MemoryRelation, workspace?: string): void {
    const source = getMemoryStore().get(sourceId);
    const target = getMemoryStore().get(targetId);
    if (!source || !target || source.scope.workspace !== target.scope.workspace || (workspace && source.scope.workspace !== workspace)) {
      throw new Error('Memory relationship not found');
    }
    getDb().run(
      'UPDATE memory_edges SET valid_to = CURRENT_TIMESTAMP WHERE src_id = ? AND dst_id = ? AND relation = ? AND valid_to IS NULL',
      sourceId,
      targetId,
      relation,
    );
  }
}

let service: KnowledgeGraphService | undefined;
export function getKnowledgeGraphService(): KnowledgeGraphService {
  service ??= new KnowledgeGraphService();
  return service;
}
