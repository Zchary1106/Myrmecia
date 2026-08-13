import { v4 as uuid } from 'uuid';
import { getDb } from '../database.js';
import type { ExecutionArtifact, ExecutionArtifactKind } from '../../types.js';

export interface StoredExecutionArtifact extends ExecutionArtifact {
  rootPath?: string;
  content?: string;
}

function rowToArtifact(row: any): StoredExecutionArtifact {
  const id = String(row.id);
  return {
    id,
    workspaceId: row.workspace_id || 'default',
    taskId: row.task_id,
    executionId: row.execution_id,
    pipelineId: row.pipeline_id || undefined,
    stageIndex: row.stage_index ?? undefined,
    name: row.name,
    kind: row.kind,
    mimeType: row.mime_type,
    source: row.source,
    relativePath: row.relative_path,
    rootPath: row.root_path || undefined,
    content: row.content ?? undefined,
    sizeBytes: Number(row.size_bytes) || 0,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {}),
    previewUrl: `/api/v1/artifacts/workbench/${encodeURIComponent(id)}/preview`,
    downloadUrl: `/api/v1/artifacts/workbench/${encodeURIComponent(id)}/download`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertExecutionArtifact(data: {
  workspaceId?: string;
  taskId: string;
  executionId: string;
  pipelineId?: string;
  stageIndex?: number;
  name: string;
  kind: ExecutionArtifactKind;
  mimeType: string;
  source: 'result' | 'workspace' | 'output';
  relativePath: string;
  rootPath?: string;
  content?: string;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
}): StoredExecutionArtifact {
  const db = getDb();
  const existing = db.get<{ id: string }>(
    'SELECT id FROM execution_artifacts WHERE execution_id = ? AND relative_path = ?',
    data.executionId,
    data.relativePath,
  );
  const id = existing?.id || `xart_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO execution_artifacts (
      id, workspace_id, task_id, execution_id, pipeline_id, stage_index,
      name, kind, mime_type, source, relative_path, root_path, content, size_bytes, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(execution_id, relative_path) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      mime_type = excluded.mime_type,
      source = excluded.source,
      root_path = excluded.root_path,
      content = excluded.content,
      size_bytes = excluded.size_bytes,
      metadata = excluded.metadata,
      updated_at = CURRENT_TIMESTAMP
  `,
    id,
    data.workspaceId || 'default',
    data.taskId,
    data.executionId,
    data.pipelineId || null,
    data.stageIndex ?? null,
    data.name,
    data.kind,
    data.mimeType,
    data.source,
    data.relativePath,
    data.rootPath || null,
    data.content || null,
    data.sizeBytes || 0,
    JSON.stringify(data.metadata || {}),
  );
  return getExecutionArtifact(id)!;
}

export function getExecutionArtifact(id: string): StoredExecutionArtifact | undefined {
  const row = getDb().get('SELECT * FROM execution_artifacts WHERE id = ?', id);
  return row ? rowToArtifact(row) : undefined;
}

export function listExecutionArtifacts(filter?: {
  workspaceId?: string;
  taskId?: string;
  executionId?: string;
  limit?: number;
}): StoredExecutionArtifact[] {
  let sql = 'SELECT * FROM execution_artifacts';
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter?.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter?.executionId) { conditions.push('execution_id = ?'); params.push(filter.executionId); }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY updated_at DESC';
  sql += ' LIMIT ?';
  params.push(Math.min(Math.max(filter?.limit || 100, 1), 500));
  return getDb().all(sql, ...params).map(rowToArtifact);
}
