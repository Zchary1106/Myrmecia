import { getDb } from '../database.js';
import type { DomainPack } from '../../types.js';

const DEFAULT_RETRIEVAL = { enabled: true, topK: 6, minScore: 0.35 };

function safeJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

/** Map a domain_packs row to a DomainPack (custom = not built-in). */
export function rowToDomain(row: any): DomainPack {
  const retrieval = safeJson<Partial<DomainPack['retrieval']>>(row.retrieval, {});
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji || '📘',
    persona: row.persona || '',
    guidelines: safeJson<string[]>(row.guidelines, []),
    terminology: safeJson<Record<string, string>>(row.terminology, {}),
    disclaimer: row.disclaimer || undefined,
    tone: row.tone || undefined,
    retrieval: {
      enabled: retrieval.enabled ?? DEFAULT_RETRIEVAL.enabled,
      topK: retrieval.topK ?? DEFAULT_RETRIEVAL.topK,
      minScore: retrieval.minScore ?? DEFAULT_RETRIEVAL.minScore,
    },
    knowledgeIds: safeJson<string[]>(row.knowledge_ids, []),
    agentIds: safeJson<string[]>(row.agent_ids, []),
    workspaceId: row.workspace_id || 'default',
    builtin: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listDomainRows(workspaceId?: string): DomainPack[] {
  const db = getDb();
  const rows = (workspaceId
    ? db.all('SELECT * FROM domain_packs WHERE workspace_id = ? ORDER BY created_at', workspaceId)
    : db.all('SELECT * FROM domain_packs ORDER BY created_at')) as any[];
  return rows.map(rowToDomain);
}

export function getDomainRow(id: string): DomainPack | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM domain_packs WHERE id = ?', id);
  return row ? rowToDomain(row) : undefined;
}

export function insertDomainRow(pack: DomainPack): DomainPack {
  const db = getDb();
  db.run(
    `INSERT INTO domain_packs
      (id, name, emoji, persona, guidelines, terminology, disclaimer, tone, retrieval, knowledge_ids, agent_ids, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    pack.id, pack.name, pack.emoji, pack.persona,
    JSON.stringify(pack.guidelines), JSON.stringify(pack.terminology),
    pack.disclaimer || null, pack.tone || null,
    JSON.stringify(pack.retrieval), JSON.stringify(pack.knowledgeIds),
    JSON.stringify(pack.agentIds), pack.workspaceId || 'default',
  );
  return getDomainRow(pack.id)!;
}

export function updateDomainRow(id: string, pack: DomainPack): DomainPack {
  const db = getDb();
  db.run(
    `UPDATE domain_packs SET
      name = ?, emoji = ?, persona = ?, guidelines = ?, terminology = ?,
      disclaimer = ?, tone = ?, retrieval = ?, knowledge_ids = ?, agent_ids = ?,
      updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    pack.name, pack.emoji, pack.persona,
    JSON.stringify(pack.guidelines), JSON.stringify(pack.terminology),
    pack.disclaimer || null, pack.tone || null,
    JSON.stringify(pack.retrieval), JSON.stringify(pack.knowledgeIds),
    JSON.stringify(pack.agentIds), id,
  );
  return getDomainRow(id)!;
}

export function deleteDomainRow(id: string): boolean {
  const db = getDb();
  const result = db.run('DELETE FROM domain_packs WHERE id = ?', id);
  return result.changes > 0;
}
