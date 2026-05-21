import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { ExecutionScore } from '../../types.js';

function rowToScore(row: any): ExecutionScore {
  return {
    id: row.id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    baseScore: row.base_score,
    llmScore: row.llm_score,
    finalScore: row.final_score,
    dimensions: JSON.parse(row.dimensions || '{}'),
    createdAt: row.created_at,
  };
}

export function createExecutionScore(data: {
  executionId: string;
  agentId: string;
  taskId: string;
  baseScore: number;
  llmScore: number | null;
  finalScore: number;
  dimensions: Record<string, number | undefined>;
}): ExecutionScore {
  const db = getDb();
  const id = `score_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO execution_scores (id, execution_id, agent_id, task_id, base_score, llm_score, final_score, dimensions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, id, data.executionId, data.agentId, data.taskId, data.baseScore, data.llmScore, data.finalScore, JSON.stringify(data.dimensions));
  return getExecutionScore(id)!;
}

export function getExecutionScore(id: string): ExecutionScore | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM execution_scores WHERE id = ?', id);
  return row ? rowToScore(row) : undefined;
}

export function listExecutionScores(filter?: { agentId?: string; taskId?: string; limit?: number }): ExecutionScore[] {
  const db = getDb();
  let sql = 'SELECT * FROM execution_scores';
  const conditions: string[] = [];
  const params: any[] = [];
  if (filter?.agentId) { conditions.push('agent_id = ?'); params.push(filter.agentId); }
  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
  return db.all(sql, ...params).map(rowToScore);
}

export function getAgentAvgScore(agentId: string, windowSize: number = 20): number {
  const db = getDb();
  const row = db.get(`
    SELECT AVG(final_score) as avg_score FROM (
      SELECT final_score FROM execution_scores
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `, agentId, windowSize) as { avg_score: number | null } | undefined;
  return row?.avg_score ?? 100;
}
