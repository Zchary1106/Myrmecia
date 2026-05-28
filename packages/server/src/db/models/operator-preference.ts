import { getDb } from '../database.js';
import type { OperatorActor, OperatorPreference } from '../../types.js';

function mapRow(row: any): OperatorPreference {
  return {
    actor: {
      id: row.actor_id,
      role: row.actor_role,
      source: row.actor_source,
    },
    namespace: row.namespace,
    key: row.key,
    value: JSON.parse(row.value),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getOperatorPreference(
  actor: OperatorActor,
  namespace: string,
  key: string,
): OperatorPreference | undefined {
  const db = getDb();
  const row = db.get(`
    SELECT * FROM operator_preferences
    WHERE actor_source = ? AND actor_role = ? AND actor_id = ? AND namespace = ? AND key = ?
  `, actor.source, actor.role, actor.id, namespace, key);
  return row ? mapRow(row) : undefined;
}

export function listOperatorPreferences(actor: OperatorActor, namespace?: string): OperatorPreference[] {
  const db = getDb();
  const params: unknown[] = [actor.source, actor.role, actor.id];
  let sql = `
    SELECT * FROM operator_preferences
    WHERE actor_source = ? AND actor_role = ? AND actor_id = ?
  `;
  if (namespace) {
    sql += ' AND namespace = ?';
    params.push(namespace);
  }
  sql += ' ORDER BY namespace ASC, key ASC';
  return db.all(sql, ...params).map(mapRow);
}

export function upsertOperatorPreference(
  actor: OperatorActor,
  namespace: string,
  key: string,
  value: unknown,
): OperatorPreference {
  const db = getDb();
  const encoded = JSON.stringify(value);
  db.run(`
    INSERT INTO operator_preferences (actor_id, actor_role, actor_source, namespace, key, value)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(actor_source, actor_role, actor_id, namespace, key)
    DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `, actor.id, actor.role, actor.source, namespace, key, encoded);
  const preference = getOperatorPreference(actor, namespace, key);
  if (!preference) throw new Error('Failed to persist operator preference');
  return preference;
}

export function deleteOperatorPreference(actor: OperatorActor, namespace: string, key: string): boolean {
  const db = getDb();
  const result = db.run(`
    DELETE FROM operator_preferences
    WHERE actor_source = ? AND actor_role = ? AND actor_id = ? AND namespace = ? AND key = ?
  `, actor.source, actor.role, actor.id, namespace, key);
  return result.changes > 0;
}
