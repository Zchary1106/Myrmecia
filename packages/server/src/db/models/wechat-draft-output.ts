import { getDb } from '../database.js';

export function recordWeChatDraftOutput(data: {
  taskId: string;
  pipelineId: string;
  stageIndex: number;
  mediaId: string;
}): void {
  getDb().run(`
    INSERT OR REPLACE INTO wechat_draft_outputs
      (task_id, pipeline_id, stage_index, media_id)
    VALUES (?, ?, ?, ?)
  `, data.taskId, data.pipelineId, data.stageIndex, data.mediaId);
}

export function getWeChatDraftMediaIds(
  pipelineId: string,
  taskIds: string[],
): string[] {
  if (taskIds.length === 0) return [];
  const placeholders = taskIds.map(() => '?').join(', ');
  return getDb().all<{ media_id: string }>(`
    SELECT media_id
    FROM wechat_draft_outputs
    WHERE pipeline_id = ? AND task_id IN (${placeholders})
    ORDER BY created_at DESC
  `, pipelineId, ...taskIds).map(row => row.media_id);
}
