import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { Artifact } from '../../types.js';

function rowToArtifact(row: any): Artifact {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    content: row.content,
    readableBy: JSON.parse(row.readable_by || '[]'),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function createArtifact(data: {
  ownerId: string;
  name: string;
  content: string;
  readableBy: string[];
  ttlHours?: number;
}): Artifact {
  const db = getDb();
  const id = `art_${uuid().slice(0, 8)}`;
  const ttl = data.ttlHours ?? 24;
  const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000).toISOString();
  db.run(`
    INSERT INTO shared_artifacts (id, owner_id, name, content, readable_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, id, data.ownerId, data.name, data.content, JSON.stringify(data.readableBy), expiresAt);
  return getArtifact(id)!;
}

export function getArtifact(id: string): Artifact | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM shared_artifacts WHERE id = ?', id);
  return row ? rowToArtifact(row) : undefined;
}

export function listArtifacts(filter?: { ownerId?: string; limit?: number }): Artifact[] {
  const db = getDb();
  let sql = 'SELECT * FROM shared_artifacts';
  const conditions: string[] = [];
  const params: any[] = [];
  if (filter?.ownerId) { conditions.push('owner_id = ?'); params.push(filter.ownerId); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
  return db.all(sql, ...params).map(rowToArtifact);
}

export function deleteExpiredArtifacts(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run('DELETE FROM shared_artifacts WHERE expires_at < ?', now);
  return result.changes;
}

export function deleteArtifact(id: string): boolean {
  const db = getDb();
  const result = db.run('DELETE FROM shared_artifacts WHERE id = ?', id);
  return result.changes > 0;
}
