/**
 * Domain routing test — when a task/pipeline carries a domainId, work should be
 * routed to the agents bound to that domain (matching the requested role).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createDomain, domainAgentForRole, loadDomains } from '../src/agents/domain-registry.js';
import { AgentManager } from '../src/agents/agent-manager.js';

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-domain-route-')), 'test.db');
  getDb();
  loadDomains('/nonexistent/domains.yaml');
  // Two developers with the same role; one is the domain specialist.
  createAgent({ id: 'dev-generalist', name: 'Generalist Dev', role: 'developer' });
  createAgent({ id: 'dev-legal', name: 'Legal Dev', role: 'developer' });
  createAgent({ id: 'reviewer', name: 'Reviewer', role: 'reviewer' });
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
});

describe('domain routing', () => {
  it('resolves the domain-bound agent for a role', () => {
    createDomain({ name: 'Legal', persona: 'Legal expert.', agentIds: ['dev-legal'] });
    const domain = domainAgentForRole(undefined, 'developer');
    expect(domain).toBeUndefined(); // no domainId → no preference
    const got = domainAgentForRole(legalId(), 'developer');
    expect(got).toBe('dev-legal');
  });

  it('returns undefined when the domain has no agent for the role', () => {
    createDomain({ name: 'Legal', persona: 'Legal expert.', agentIds: ['dev-legal'] });
    expect(domainAgentForRole(legalId(), 'tester')).toBeUndefined();
  });

  it('AgentManager.findAvailableAgent prefers the domain agent for a role', () => {
    createDomain({ name: 'Legal', persona: 'Legal expert.', agentIds: ['dev-legal'] });
    const mgr = new AgentManager('/nonexistent/registry.yaml');

    // Without a domain, selection is among all developers (could be either).
    const any = mgr.findAvailableAgent('developer');
    expect(['dev-generalist', 'dev-legal']).toContain(any?.id);

    // With the domain, it must pick the bound specialist.
    const routed = mgr.findAvailableAgent('developer', legalId());
    expect(routed?.id).toBe('dev-legal');
  });

  it('falls back to normal selection when the domain agent does not match the role', () => {
    createDomain({ name: 'Legal', persona: 'Legal expert.', agentIds: ['dev-legal'] });
    const mgr = new AgentManager('/nonexistent/registry.yaml');
    // Domain has only a developer; asking for a reviewer should still resolve the reviewer.
    const routed = mgr.findAvailableAgent('reviewer', legalId());
    expect(routed?.id).toBe('reviewer');
  });
});

/** Helper: the slug id created for the "Legal" domain. */
function legalId(): string {
  return 'legal';
}
