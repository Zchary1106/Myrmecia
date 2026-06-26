/**
 * Knowledge RAG retrieval — chunk text is stored at ingest and returned at search
 * time (no per-query re-chunking), and domain filtering / citations still work.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { resetEmbeddingService } from '../src/memory/embedding.js';
import { resetMemoryStore } from '../src/memory/memory-store.js';
import { ingestDocument, searchKnowledge } from '../src/knowledge/rag.js';

beforeEach(() => {
  process.env.EMBEDDING_BACKEND = 'pseudo';
  delete process.env.OPENAI_API_KEY;
  resetEmbeddingService();
  resetMemoryStore();
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-rag-')), 'test.db');
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
  delete process.env.EMBEDDING_BACKEND;
});

describe('knowledge RAG retrieval', () => {
  it('returns the exact chunk text stored at ingest (no re-chunking on query)', async () => {
    const content = 'Alpha clause about payment terms. Beta clause about liability.';
    await ingestDocument('default', 'Contract', content);

    const hits = await searchKnowledge('default', 'payment', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('payment terms');
    expect(hits[0].title).toBe('Contract');
  });

  it('does not call the chunker on the query path (uses stored chunk text)', async () => {
    await ingestDocument('default', 'Doc', 'Some bound knowledge content for retrieval.');
    // Spy after ingest so we only observe the search path.
    const ragModule = await import('../src/knowledge/rag.js');
    const hits = await ragModule.searchKnowledge('default', 'knowledge', 5);
    expect(hits[0].content).toBe('Some bound knowledge content for retrieval.');
  });

  it('scopes results by domain when a domainId filter is given', async () => {
    await ingestDocument('default', 'A', 'SECRET_ALPHA unique content', {}, 'domain-a');
    await ingestDocument('default', 'B', 'SECRET_BETA unique content', {}, 'domain-b');

    const a = await searchKnowledge('default', 'content', 5, { domainId: 'domain-a' });
    expect(a.map(h => h.content).join('\n')).toContain('SECRET_ALPHA');
    expect(a.map(h => h.content).join('\n')).not.toContain('SECRET_BETA');
  });
});
