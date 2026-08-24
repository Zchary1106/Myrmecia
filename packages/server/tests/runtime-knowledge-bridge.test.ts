import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { resetEmbeddingService } from '../src/memory/embedding.js';
import { getMemoryStore, resetMemoryStore } from '../src/memory/memory-store.js';
import {
  captureExecutionArtifactKnowledge,
  confirmKnowledgeCandidate,
  listKnowledgeCandidates,
  rejectKnowledgeCandidate,
} from '../src/memory/runtime-knowledge-bridge.js';
import { KnowledgeGraphService } from '../src/memory/knowledge-graph-service.js';

describe('runtime knowledge bridge', () => {
  beforeEach(async () => {
    closeDb();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-runtime-knowledge-')), 'test.db');
    process.env.EMBEDDING_BACKEND = 'pseudo';
    resetEmbeddingService();
    resetMemoryStore();
    getDb();
    await getMemoryStore().initialize();
  });

  afterEach(() => {
    closeDb();
    resetMemoryStore();
    delete process.env.DB_PATH;
    delete process.env.EMBEDDING_BACKEND;
  });

  const artifact = {
    id: 'xart_test',
    workspaceId: 'alpha',
    taskId: 'task_1',
    executionId: 'exec_1',
    name: 'test-report.json',
    kind: 'test-report' as const,
    mimeType: 'application/json',
    source: 'output' as const,
    relativePath: 'reports/test-report.json',
    sizeBytes: 20,
    metadata: {},
    previewUrl: '/preview',
    downloadUrl: '/download',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('quarantines runtime evidence until confirmation, then links it to its task', async () => {
    const candidate = await captureExecutionArtifactKnowledge(artifact);
    expect(listKnowledgeCandidates('alpha')).toHaveLength(1);
    expect(new KnowledgeGraphService().list({ workspace: 'alpha' }).nodes).toHaveLength(0);
    const recalled = await getMemoryStore().recall({ query: candidate.content, scope: { workspace: 'alpha' }, topK: 10 });
    expect(recalled.some(result => result.item.id === candidate.id)).toBe(false);

    const confirmed = await confirmKnowledgeCandidate(candidate.id, 'alpha');
    expect(confirmed?.metadata.knowledgeStatus).toBe('confirmed');
    expect(listKnowledgeCandidates('alpha')).toHaveLength(0);
    expect(new KnowledgeGraphService().list({ workspace: 'alpha' }).edges).toHaveLength(1);
  });

  it('rejects candidates with recoverable soft deletion', async () => {
    const candidate = await captureExecutionArtifactKnowledge({ ...artifact, id: 'xart_reject' });
    expect(rejectKnowledgeCandidate(candidate.id, 'alpha')).toBe(true);
    expect(getMemoryStore().get(candidate.id)).toBeUndefined();
    expect(getMemoryStore().get(candidate.id, { includeDeleted: true })?.deletedAt).toBeTruthy();
  });
});
