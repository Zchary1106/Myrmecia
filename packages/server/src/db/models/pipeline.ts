import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { Pipeline, PipelineStage, PipelineStatus, PipelineTemplate } from '../../types.js';

function rowToPipeline(row: any): Pipeline {
  return {
    ...row,
    stages: JSON.parse(row.stages),
    currentStageIndex: row.current_stage_index,
    gateMode: row.gate_mode,
    templateId: row.template_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    stageCheckpoints: row.stage_checkpoints,
  };
}

export function createPipeline(data: {
  name: string;
  templateId?: string;
  stages: PipelineStage[];
  gateMode?: 'auto' | 'manual';
  input: string;
}): Pipeline {
  const db = getDb();
  const id = `pipe_${uuid().slice(0, 8)}`;

  db.run(`
    INSERT INTO pipelines (id, name, template_id, stages, gate_mode, input)
    VALUES (?, ?, ?, ?, ?, ?)
  `, id, data.name, data.templateId || null, JSON.stringify(data.stages), data.gateMode || 'auto', data.input);

  return getPipeline(id)!;
}

export function getPipeline(id: string): Pipeline | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM pipelines WHERE id = ?', id);
  return row ? rowToPipeline(row) : undefined;
}

export function listPipelines(filter?: { status?: PipelineStatus }): Pipeline[] {
  const db = getDb();
  let sql = 'SELECT * FROM pipelines';
  const params: any[] = [];
  if (filter?.status) { sql += ' WHERE status = ?'; params.push(filter.status); }
  sql += ' ORDER BY created_at DESC';
  return db.all(sql, ...params).map(rowToPipeline);
}

export function updatePipeline(id: string, updates: Partial<{
  status: PipelineStatus;
  stages: PipelineStage[];
  currentStageIndex: number;
  completedAt: string;
  stageCheckpoints: string;
}>): Pipeline | undefined {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.stages !== undefined) { sets.push('stages = ?'); params.push(JSON.stringify(updates.stages)); }
  if (updates.currentStageIndex !== undefined) { sets.push('current_stage_index = ?'); params.push(updates.currentStageIndex); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt); }
  if (updates.stageCheckpoints !== undefined) { sets.push('stage_checkpoints = ?'); params.push(updates.stageCheckpoints); }

  if (sets.length === 0) return getPipeline(id);
  params.push(id);
  db.run(`UPDATE pipelines SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getPipeline(id);
}

// Templates
export function createTemplate(data: { name: string; description?: string; stages: any[] }): PipelineTemplate {
  const db = getDb();
  const id = `tmpl_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO pipeline_templates (id, name, description, stages) VALUES (?, ?, ?, ?)
  `, id, data.name, data.description || '', JSON.stringify(data.stages));
  return getTemplate(id)!;
}

export function getTemplate(id: string): PipelineTemplate | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM pipeline_templates WHERE id = ?', id);
  if (!row) return undefined;
  return { ...row, stages: JSON.parse(row.stages), templateId: row.template_id, createdAt: row.created_at };
}

export function listTemplates(): PipelineTemplate[] {
  const db = getDb();
  return db.all('SELECT * FROM pipeline_templates ORDER BY created_at DESC').map(row => ({
    ...row, stages: JSON.parse(row.stages), createdAt: row.created_at,
  }));
}

export function updateTemplate(id: string, updates: Partial<{
  name: string;
  description: string;
  stages: { name: string; role: string; promptTemplate: string }[];
}>): PipelineTemplate | undefined {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.stages !== undefined) { sets.push('stages = ?'); params.push(JSON.stringify(updates.stages)); }
  if (sets.length === 0) return getTemplate(id);
  params.push(id);
  db.run(`UPDATE pipeline_templates SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getTemplate(id);
}
