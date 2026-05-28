import { getDb } from '../db/database.js';
import type { PipelineStage } from '../types.js';

export interface StageCheckpoint {
  pipelineId: string;
  stageIndex: number;
  stageName: string;
  stageOutput: string;
  context: string;
  timestamp: string;
  /** Optional git SHA for workspace rollback */
  gitSha?: string;
}

export function saveCheckpoint(data: StageCheckpoint): void {
  const db = getDb();

  // Atomic read-modify-write inside a transaction to prevent lost updates
  db.transaction(() => {
    const row = db.get('SELECT stage_checkpoints FROM pipelines WHERE id = ?', data.pipelineId) as any;
    if (!row) return;

    let checkpoints: Record<string, StageCheckpoint> = {};
    try {
      checkpoints = JSON.parse(row.stage_checkpoints || '{}');
    } catch {}

    checkpoints[String(data.stageIndex)] = data;
    db.run('UPDATE pipelines SET stage_checkpoints = ? WHERE id = ?', JSON.stringify(checkpoints), data.pipelineId);
  });
}

export function getLatestCheckpoint(pipelineId: string): StageCheckpoint | undefined {
  const row = getDb().get('SELECT stage_checkpoints FROM pipelines WHERE id = ?', pipelineId) as any;
  if (!row) return undefined;

  let checkpoints: Record<string, StageCheckpoint> = {};
  try {
    checkpoints = JSON.parse(row.stage_checkpoints || '{}');
  } catch {}

  const indices = Object.keys(checkpoints).map(Number).sort((a, b) => b - a);
  if (indices.length === 0) return undefined;

  return checkpoints[String(indices[0])];
}

export function getCheckpoints(pipelineId: string): StageCheckpoint[] {
  const row = getDb().get('SELECT stage_checkpoints FROM pipelines WHERE id = ?', pipelineId) as any;
  if (!row) return [];

  let checkpoints: Record<string, StageCheckpoint> = {};
  try {
    checkpoints = JSON.parse(row.stage_checkpoints || '{}');
  } catch {}

  return Object.keys(checkpoints)
    .map(Number)
    .sort((a, b) => a - b)
    .map(k => checkpoints[String(k)]);
}

export function getCompletedStageIndices(pipelineId: string): Set<number> {
  const checkpoints = getCheckpoints(pipelineId);
  return new Set(checkpoints.map(c => c.stageIndex));
}

export function clearCheckpoints(pipelineId: string): void {
  getDb().run('UPDATE pipelines SET stage_checkpoints = ? WHERE id = ?', '{}', pipelineId);
}
