import type { Task } from '../types.js';
import { getDb } from '../db/database.js';
import { getExecutionArtifact, type StoredExecutionArtifact } from '../db/models/execution-artifact.js';
import { readArtifactSnapshot } from '../artifacts/artifact-snapshot-store.js';

/** Internal host handoff only; no API lets a model grant itself contract inputs. */
export function bindQualityInput(task: Task, inputName: string, artifact: StoredExecutionArtifact): void {
  if (task.createdBy !== 'master' || !task.parentTaskId || task.parentTaskId !== artifact.taskId
    || (task.workspaceId || 'default') !== artifact.workspaceId || !/^(Test|Review|Fix):\s/.test(task.title)
    || !readArtifactSnapshot(artifact)) throw new Error('QUALITY_INPUT_SCOPE_DENIED');
  getDb().run(`INSERT INTO quality_input_artifacts(workspace_id,task_id,input_name,artifact_id,source_task_id)
    VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,task_id,input_name) DO UPDATE SET artifact_id=excluded.artifact_id`,
  task.workspaceId || 'default', task.id, inputName, artifact.id, artifact.taskId);
}
export function qualityInputArtifacts(task: Task): Array<{ name: string; kind: StoredExecutionArtifact['kind'] | 'report' }> {
  if (task.createdBy !== 'master' || !task.parentTaskId || !/^(Test|Review|Fix):\s/.test(task.title)) return [];
  return getDb().all<{ input_name: string; artifact_id: string; source_task_id: string }>(
    'SELECT input_name,artifact_id,source_task_id FROM quality_input_artifacts WHERE workspace_id=? AND task_id=?',
    task.workspaceId || 'default', task.id,
  ).flatMap<{ name: string; kind: StoredExecutionArtifact['kind'] | 'report' }>(row => {
    const artifact = getExecutionArtifact(row.artifact_id);
    if (!artifact || row.source_task_id !== task.parentTaskId || artifact.taskId !== task.parentTaskId
      || artifact.workspaceId !== (task.workspaceId || 'default')) return [];
    // Snapshot hash errors fail closed; do not accept a mutable prose reference.
    const bytes = readArtifactSnapshot(artifact);
    if (!bytes) return [];
    if (row.input_name === 'test-report' && artifact.kind === 'json') {
      const report = JSON.parse(bytes.toString('utf8'));
      if (report.schemaVersion !== 1 || !report.evidence || !Number.isInteger(report.evidence.exitCode)
        || !report.evidence.command || !report.evidence.cwd) return [];
      return [{ name: row.input_name, kind: 'report' as const }];
    }
    return [{ name: row.input_name, kind: artifact.kind }];
  });
}
