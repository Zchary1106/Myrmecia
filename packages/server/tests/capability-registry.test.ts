/**
 * CapabilityRegistry — indexes agents by capability and resolves providers
 * (respecting per-agent concurrency).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { CapabilityRegistry } from '../src/agents/capability-registry.js';

let registry: CapabilityRegistry;

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-cap-')), 'test.db');
  getDb();
  createAgent({ id: 'dev', name: 'Dev', role: 'developer', capabilities: ['typescript', 'react'] });
  createAgent({ id: 'qa', name: 'QA', role: 'tester', capabilities: ['testing', 'typescript'] });
  createAgent({ id: 'ops', name: 'Ops', role: 'devops', capabilities: ['docker'] });
  registry = new CapabilityRegistry();
  registry.buildIndex();
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
});

describe('CapabilityRegistry', () => {
  it('finds a provider for a capability', () => {
    expect(registry.findProvider('docker')?.id).toBe('ops');
  });

  it('returns undefined for an unknown capability', () => {
    expect(registry.findProvider('quantum-computing')).toBeUndefined();
  });

  it('finds all providers of a shared capability', () => {
    const ids = registry.findAllProviders('typescript').map(a => a.id).sort();
    expect(ids).toEqual(['dev', 'qa']);
  });

  it('returns an agent capabilities list', () => {
    expect(registry.getAgentCapabilities('qa').sort()).toEqual(['testing', 'typescript']);
    expect(registry.getAgentCapabilities('nonexistent')).toEqual([]);
  });

  it('lists capabilities with provider counts', () => {
    const caps = registry.listCapabilities();
    const byCap = Object.fromEntries(caps.map(c => [c.capability, c.providerCount]));
    expect(byCap.typescript).toBe(2);
    expect(byCap.docker).toBe(1);
  });

  it('reflects newly added agents after a refresh', () => {
    expect(registry.findProvider('security')).toBeUndefined();
    createAgent({ id: 'sec', name: 'Sec', role: 'security-reviewer', capabilities: ['security'] });
    registry.refresh();
    expect(registry.findProvider('security')?.id).toBe('sec');
  });
});
