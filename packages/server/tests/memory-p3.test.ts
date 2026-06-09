/**
 * P3 tests — write pipeline: extraction + consolidation (ADD/UPDATE/NOOP).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { resetEmbeddingService } from '../src/memory/embedding.js';
import { getMemoryStore, resetMemoryStore } from '../src/memory/memory-store.js';
import { resetTrajectoryStore } from '../src/memory/trajectory-store.js';
import { extractFacts, getWritePipeline, resetWritePipeline } from '../src/memory/write-pipeline.js';

function freshEnv() {
  process.env.EMBEDDING_BACKEND = 'pseudo';
  delete process.env.OPENAI_API_KEY;
  resetEmbeddingService();
  resetMemoryStore();
  resetTrajectoryStore();
  resetWritePipeline();
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-mem-p3-')), 'test.db');
  getDb();
}

describe('extractFacts', () => {
  it('extracts preferences and conventions, skips noise', () => {
    const text = [
      'We always use TypeScript with strict mode enabled.',
      'The deploy pipeline runs on Kubernetes via ArgoCD.',
      '```',
      'ok',
      '# Heading',
    ].join('\n');
    const facts = extractFacts(text);
    const contents = facts.map(f => f.content);
    expect(contents.some(c => c.includes('TypeScript'))).toBe(true);
    expect(contents.some(c => c.includes('Kubernetes'))).toBe(true);
    expect(contents).not.toContain('ok');
    expect(facts.find(f => f.content.includes('always'))?.kind).toBe('preference');
  });
});

describe('WritePipeline consolidation', () => {
  beforeEach(() => { freshEnv(); });
  afterEach(() => { closeDb(); delete process.env.DB_PATH; delete process.env.EMBEDDING_BACKEND; });

  it('ADDs new facts then NOOPs on identical re-ingest', async () => {
    const wp = getWritePipeline();
    const text = 'We always use TypeScript with strict mode.\nThe API runs on Express 5 and SQLite.';

    const first = await wp.ingestText(text, { scope: { workspace: 'ws-1' } });
    expect(first.added).toBeGreaterThanOrEqual(1);
    const semanticCount = getMemoryStore().size('semantic');
    expect(semanticCount).toBe(first.added);

    // Re-ingesting identical text must not create new rows (NOOP path).
    const second = await wp.ingestText(text, { scope: { workspace: 'ws-1' } });
    expect(second.added).toBe(0);
    expect(getMemoryStore().size('semantic')).toBe(semanticCount);
  });

  it('ingestFromExecution persists workspace-scoped facts', async () => {
    const wp = getWritePipeline();
    const res = await wp.ingestFromExecution({
      input: 'Set up billing',
      output: 'The billing service uses Stripe and stores invoices in Postgres. We always validate webhooks.',
      scope: { workspace: 'ws-2' },
    });
    expect(res.added).toBeGreaterThanOrEqual(1);

    const db = getDb();
    const rows = db.all("SELECT * FROM memory_items WHERE type='semantic' AND scope_workspace='ws-2'") as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].source_type).toBe('extracted');
  });

  it('respects MEMORY_EXTRACTION_ENABLED=false', async () => {
    process.env.MEMORY_EXTRACTION_ENABLED = 'false';
    try {
      await getMemoryStore().initialize();
      const res = await getWritePipeline().ingestFromExecution({
        input: 'x',
        output: 'We always use TypeScript and Express and SQLite for everything in this project.',
        scope: { workspace: 'ws-3' },
      });
      expect(res.added).toBe(0);
      expect(getMemoryStore().size('semantic')).toBe(0);
    } finally {
      delete process.env.MEMORY_EXTRACTION_ENABLED;
    }
  });
});
