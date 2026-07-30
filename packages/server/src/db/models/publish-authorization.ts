import { getDb } from '../database.js';

export function consumePublishAuthorization(data: {
  taskId: string;
  pipelineId?: string;
  stageIndex?: number;
  scope: string;
  toolName: string;
}): boolean {
  const result = getDb().run(`
    INSERT OR IGNORE INTO publish_authorization_consumptions
      (task_id, pipeline_id, stage_index, scope, tool_name)
    VALUES (?, ?, ?, ?, ?)
  `,
  data.taskId,
  data.pipelineId ?? null,
  data.stageIndex ?? null,
  data.scope,
  data.toolName);
  return result.changes === 1;
}
