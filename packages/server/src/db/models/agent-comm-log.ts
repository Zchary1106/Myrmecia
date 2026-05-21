import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { CommMessageRecord } from '../../types.js';

function rowToRecord(row: any): CommMessageRecord {
  return {
    id: row.id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    capability: row.capability,
    mode: row.mode,
    status: row.status,
    payloadSummary: row.payload_summary,
    taskId: row.task_id,
    outputSummary: row.output_summary,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function createCommLog(data: {
  fromAgentId: string;
  toAgentId: string;
  capability: string;
  mode: 'sync' | 'async';
  payloadSummary?: string;
  taskId?: string;
}): CommMessageRecord {
  const db = getDb();
  const id = `comm_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO agent_comm_log (id, from_agent_id, to_agent_id, capability, mode, payload_summary, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, id, data.fromAgentId, data.toAgentId, data.capability, data.mode, data.payloadSummary || null, data.taskId || null);
  return getCommLog(id)!;
}

export function getCommLog(id: string): CommMessageRecord | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM agent_comm_log WHERE id = ?', id);
  return row ? rowToRecord(row) : undefined;
}

export function updateCommLog(id: string, updates: {
  status?: string;
  taskId?: string;
  outputSummary?: string;
  durationMs?: number;
  completedAt?: string;
}): CommMessageRecord | undefined {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.taskId !== undefined) { sets.push('task_id = ?'); params.push(updates.taskId); }
  if (updates.outputSummary !== undefined) { sets.push('output_summary = ?'); params.push(updates.outputSummary); }
  if (updates.durationMs !== undefined) { sets.push('duration_ms = ?'); params.push(updates.durationMs); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt); }
  if (sets.length === 0) return getCommLog(id);
  params.push(id);
  db.run(`UPDATE agent_comm_log SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getCommLog(id);
}

export function listCommLogs(filter?: {
  fromAgentId?: string;
  toAgentId?: string;
  capability?: string;
  mode?: string;
  status?: string;
  limit?: number;
}): CommMessageRecord[] {
  const db = getDb();
  let sql = 'SELECT * FROM agent_comm_log';
  const conditions: string[] = [];
  const params: any[] = [];
  if (filter?.fromAgentId) { conditions.push('from_agent_id = ?'); params.push(filter.fromAgentId); }
  if (filter?.toAgentId) { conditions.push('to_agent_id = ?'); params.push(filter.toAgentId); }
  if (filter?.capability) { conditions.push('capability = ?'); params.push(filter.capability); }
  if (filter?.mode) { conditions.push('mode = ?'); params.push(filter.mode); }
  if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
  return db.all(sql, ...params).map(rowToRecord);
}
