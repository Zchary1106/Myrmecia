import { describe, expect, it } from 'vitest';
import type { ExternalAgent } from '@myrmecia/shared';
import { HttpAgentAdapter, LocalCliAgentAdapter } from '../src/agents/external-agent-adapters.js';

function agent(adapter: ExternalAgent['adapter']): ExternalAgent {
  return {
    id: 'external_test',
    workspaceId: 'workspace-test',
    name: 'External test',
    adapter,
    status: 'draft',
    capabilities: [],
    allowedTools: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('external Agent adapters', () => {
  it('rejects a local CLI profile without an allowlisted workspace root', async () => {
    await expect(new LocalCliAgentAdapter().validate(agent({
      kind: 'local_cli',
      profile: 'codex',
      allowedWorkspaceRoots: [],
    }))).rejects.toThrow('allowed workspace root');
  });

  it('rejects custom CLI commands until they are server-owned profiles', async () => {
    await expect(new LocalCliAgentAdapter().validate(agent({
      kind: 'local_cli',
      profile: 'custom_profile',
      allowedWorkspaceRoots: ['/tmp'],
    }))).rejects.toThrow('not enabled');
  });

  it('rejects HTTP Agents that omit an allowed HTTPS host', async () => {
    await expect(new HttpAgentAdapter().validate(agent({
      kind: 'http',
      endpoint: 'https://agents.example.test/run',
      allowedHosts: [],
    }))).rejects.toThrow('allowedHosts');
  });

  it('rejects insecure HTTP endpoints outside the test-only localhost exception', async () => {
    await expect(new HttpAgentAdapter().validate(agent({
      kind: 'http',
      endpoint: 'http://agents.example.test/run',
      allowedHosts: ['agents.example.test'],
    }))).rejects.toThrow('must use HTTPS');
  });
});
