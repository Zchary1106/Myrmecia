import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import {
  loadDomains, listDomains, getDomain, createDomain, updateDomain, deleteDomain,
  resolveDomainForAgent, bindKnowledge,
} from '../src/agents/domain-registry.js';
import { buildDomainOverlay } from '../src/agents/domain-context.js';

let yamlPath: string;

function writeExampleYaml(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-factory-domains-'));
  const p = join(dir, 'domains.yaml');
  writeFileSync(p, [
    'domains:',
    '  - id: example',
    '    name: Example Domain',
    '    emoji: 📘',
    '    persona: You are an expert. Answer strictly from the knowledge base.',
    '    guidelines:',
    '      - Cite sources',
    '      - Do not speculate',
    '    disclaimer: For reference only.',
    '    retrieval: { enabled: true, topK: 5, minScore: 0.3 }',
    '    agents: [dev]',
  ].join('\n'), 'utf-8');
  return p;
}

describe('Domain Registry', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-domain-db-')), 'test.db');
    getDb();
    yamlPath = writeExampleYaml();
    loadDomains(yamlPath);
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('loads the built-in example domain from YAML', () => {
    const domains = listDomains();
    expect(domains).toHaveLength(1);
    expect(domains[0].id).toBe('example');
    expect(domains[0].builtin).toBe(true);
    expect(domains[0].agentIds).toContain('dev');
    expect(domains[0].retrieval.topK).toBe(5);
  });

  it('creates a custom domain and lists it alongside built-ins', () => {
    const created = createDomain({ name: 'Contract Review', persona: 'You review contracts.', agentIds: ['review'] });
    expect(created.id).toBe('contract-review');
    expect(created.builtin).toBe(false);
    const all = listDomains();
    expect(all.map(d => d.id).sort()).toEqual(['contract-review', 'example']);
  });

  it('rejects a domain without a persona', () => {
    expect(() => createDomain({ name: 'No Persona', persona: '' })).toThrow(/persona/);
  });

  it('materializes a built-in as a custom override when edited', () => {
    const updated = updateDomain('example', { tone: 'formal' });
    expect(updated.tone).toBe('formal');
    expect(updated.builtin).toBe(false);
    // Built-in id still resolves, now overridden by the custom row.
    expect(getDomain('example')?.tone).toBe('formal');
  });

  it('deleting an overridden built-in reverts to the built-in', () => {
    updateDomain('example', { tone: 'formal' });
    const result = deleteDomain('example');
    expect(result.reverted).toBe(true);
    expect(getDomain('example')?.builtin).toBe(true);
  });

  it('resolves a domain for an agent by binding', () => {
    expect(resolveDomainForAgent('dev')?.id).toBe('example');
    expect(resolveDomainForAgent('nonexistent')).toBeUndefined();
  });

  it('prefers an explicit domainId over agent binding', () => {
    createDomain({ id: 'legal', name: 'Legal', persona: 'You are a lawyer.' });
    expect(resolveDomainForAgent('dev', 'legal')?.id).toBe('legal');
  });

  it('binds knowledge document ids to a domain (idempotent union)', () => {
    bindKnowledge('example', ['doc_1', 'doc_2']);
    bindKnowledge('example', ['doc_2', 'doc_3']);
    expect(getDomain('example')?.knowledgeIds.sort()).toEqual(['doc_1', 'doc_2', 'doc_3']);
  });

  it('renders a system-prompt overlay with persona, guidelines and disclaimer', () => {
    const overlay = buildDomainOverlay(getDomain('example'));
    expect(overlay).toContain('Example Domain');
    expect(overlay).toContain('Cite sources');
    expect(overlay).toContain('For reference only.');
  });

  it('returns an empty overlay when no domain', () => {
    expect(buildDomainOverlay(undefined)).toBe('');
  });
});
