/**
 * Domain injection integration test — proves that a Domain Pack actually changes
 * what an agent receives, without needing a live model:
 *   - applyDomainOverlay() injects persona + guidelines + disclaimer into the system prompt
 *   - applyDomainKnowledge() retrieves the domain's bound knowledge and prepends it to the input
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { resetEmbeddingService } from '../src/memory/embedding.js';
import { resetMemoryStore } from '../src/memory/memory-store.js';
import { createDomain, loadDomains } from '../src/agents/domain-registry.js';
import { ingestDocument } from '../src/knowledge/rag.js';
import { applyDomainOverlay, applyDomainKnowledge, buildDomainKnowledgeBlock } from '../src/agents/domain-context.js';

beforeEach(() => {
  process.env.EMBEDDING_BACKEND = 'pseudo';
  delete process.env.OPENAI_API_KEY;
  resetEmbeddingService();
  resetMemoryStore();
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-domain-inject-')), 'test.db');
  getDb();
  loadDomains('/nonexistent/domains.yaml'); // start with no built-ins; use custom only
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
  delete process.env.EMBEDDING_BACKEND;
});

describe('domain injection', () => {
  it('overlays persona, guidelines and disclaimer onto the system prompt', () => {
    const domain = createDomain({
      name: 'Legal Reviewer',
      persona: 'You are a contract law expert.',
      guidelines: ['Cite the clause', 'Flag risks'],
      disclaimer: 'Not formal legal advice.',
    });
    const out = applyDomainOverlay('BASE SYSTEM PROMPT', domain);
    expect(out).toContain('Legal Reviewer');
    expect(out).toContain('You are a contract law expert.');
    expect(out).toContain('Cite the clause');
    expect(out).toContain('Not formal legal advice.');
    // Original prompt is preserved after the overlay.
    expect(out).toContain('BASE SYSTEM PROMPT');
    expect(out.indexOf('Legal Reviewer')).toBeLessThan(out.indexOf('BASE SYSTEM PROMPT'));
  });

  it('leaves the system prompt untouched when no domain applies', () => {
    expect(applyDomainOverlay('BASE', undefined)).toBe('BASE');
  });

  it('retrieves bound knowledge and prepends it to the task input', async () => {
    const domain = createDomain({
      name: 'Contract KB',
      persona: 'Contract expert.',
      retrieval: { enabled: true, topK: 5, minScore: 0 },
    });
    await ingestDocument('default', '付款条款', '第二条 付款条款：甲方应在收到发票后30日内支付款项。', {}, domain.id);

    const block = await buildDomainKnowledgeBlock(domain, '付款是怎么约定的', 'default');
    expect(block).toContain('领域知识');
    expect(block).toContain('30日内支付款项');

    const injected = await applyDomainKnowledge('原始任务：请说明付款约定', domain, 'default');
    expect(injected).toContain('30日内支付款项'); // knowledge injected
    expect(injected).toContain('原始任务：请说明付款约定'); // original task preserved
  });

  it('injects nothing when retrieval is disabled', async () => {
    const domain = createDomain({
      name: 'No Retrieval',
      persona: 'Expert.',
      retrieval: { enabled: false, topK: 5, minScore: 0 },
    });
    await ingestDocument('default', 'doc', 'some bound knowledge content here', {}, domain.id);
    const injected = await applyDomainKnowledge('TASK', domain, 'default');
    expect(injected).toBe('TASK');
  });

  it('does not leak knowledge from a different domain', async () => {
    const a = createDomain({ name: 'Domain A', persona: 'A', retrieval: { enabled: true, topK: 5, minScore: 0 } });
    const b = createDomain({ name: 'Domain B', persona: 'B', retrieval: { enabled: true, topK: 5, minScore: 0 } });
    await ingestDocument('default', 'a-doc', 'SECRET_A unique alpha content', {}, a.id);
    await ingestDocument('default', 'b-doc', 'SECRET_B unique beta content', {}, b.id);

    const blockB = await buildDomainKnowledgeBlock(b, 'content', 'default');
    expect(blockB).toContain('SECRET_B');
    expect(blockB).not.toContain('SECRET_A');
  });
});
