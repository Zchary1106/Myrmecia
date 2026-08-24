import { getDb } from '../db/database.js';
import type { StoredExecutionArtifact } from '../db/models/execution-artifact.js';
import { getKnowledgeGraphService } from './knowledge-graph-service.js';
import { getMemoryStore } from './memory-store.js';
import type { MemoryItem } from './types.js';

export interface KnowledgeCandidate {
  item: MemoryItem;
  taskId?: string;
  evidenceKind?: string;
}

function candidateFrom(item: MemoryItem): KnowledgeCandidate {
  return {
    item,
    taskId: typeof item.metadata.taskId === 'string' ? item.metadata.taskId : undefined,
    evidenceKind: typeof item.metadata.evidenceKind === 'string' ? item.metadata.evidenceKind : undefined,
  };
}

/** Capture durable runtime evidence without making it available to Agent recall. */
export async function captureExecutionArtifactKnowledge(artifact: StoredExecutionArtifact): Promise<MemoryItem> {
  const store = getMemoryStore();
  await store.initialize();
  const existing = getDb().get(
    "SELECT id FROM memory_items WHERE source_type = 'execution_artifact' AND source_id = ? AND deleted_at IS NULL LIMIT 1",
    artifact.id,
  ) as { id: string } | undefined;
  if (existing) return store.get(existing.id)!;

  const evidenceText = [artifact.name, artifact.relativePath, JSON.stringify(artifact.metadata || {})].join(' ');
  const evidenceKind = /review/i.test(evidenceText)
    ? 'review'
    : /test|coverage/i.test(evidenceText)
      ? 'test'
      : 'artifact';
  return store.add({
    type: 'semantic',
    scope: { workspace: artifact.workspaceId },
    content: artifact.name + ' — ' + artifact.relativePath,
    summary: evidenceKind + ' evidence produced by task ' + artifact.taskId,
    importance: evidenceKind === 'artifact' ? 0.5 : 0.7,
    sourceType: 'execution_artifact',
    sourceId: artifact.id,
    metadata: {
      knowledgeStatus: 'candidate',
      evidenceKind,
      taskId: artifact.taskId,
      executionId: artifact.executionId,
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      relativePath: artifact.relativePath,
      previewUrl: artifact.previewUrl,
    },
  });
}

export function listKnowledgeCandidates(workspace?: string, limit = 100): KnowledgeCandidate[] {
  return getMemoryStore()
    .list({ workspace, limit: Math.min(Math.max(limit, 1), 200) })
    .filter(item => item.metadata.knowledgeStatus === 'candidate')
    .map(candidateFrom);
}

/** Confirm a candidate and only then connect its evidence to the originating task. */
export async function confirmKnowledgeCandidate(id: string, workspace?: string): Promise<MemoryItem | undefined> {
  const store = getMemoryStore();
  const item = store.get(id);
  if (!item || item.metadata.knowledgeStatus !== 'candidate') return undefined;
  if (workspace && item.scope.workspace !== workspace) return undefined;
  const confirmed = await store.update(id, {
    metadata: {
      ...item.metadata,
      knowledgeStatus: 'confirmed',
      confirmedAt: new Date().toISOString(),
    },
  });
  if (!confirmed) return undefined;

  const taskId = typeof confirmed.metadata.taskId === 'string' ? confirmed.metadata.taskId : undefined;
  if (taskId) {
    const db = getDb();
    let taskRow = db.get(
      "SELECT id FROM memory_items WHERE source_type = 'task' AND source_id = ? AND deleted_at IS NULL LIMIT 1",
      taskId,
    ) as { id: string } | undefined;
    if (!taskRow) {
      const task = await store.add({
        type: 'entity',
        scope: confirmed.scope,
        content: 'Task ' + taskId,
        importance: 0.6,
        sourceType: 'task',
        sourceId: taskId,
        metadata: { kind: 'task', knowledgeStatus: 'confirmed' },
      });
      taskRow = { id: task.id };
    }
    const failed = /fail|reject|error/i.test(confirmed.content + ' ' + String(confirmed.summary || ''));
    const evidenceKind = String(confirmed.metadata.evidenceKind || '');
    getKnowledgeGraphService().create({
      sourceId: confirmed.id,
      targetId: taskRow.id,
      relation: failed ? 'contradicts' : evidenceKind === 'artifact' ? 'produced_by' : 'supports',
      workspace: confirmed.scope.workspace,
    });
  }
  return confirmed;
}

export function rejectKnowledgeCandidate(id: string, workspace?: string): boolean {
  const store = getMemoryStore();
  const item = store.get(id);
  if (!item || item.metadata.knowledgeStatus !== 'candidate') return false;
  if (workspace && item.scope.workspace !== workspace) return false;
  store.forget(id);
  return true;
}
