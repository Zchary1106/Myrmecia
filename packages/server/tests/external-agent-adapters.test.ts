import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExternalAgent } from '@myrmecia/shared';
import { HttpAgentAdapter, LocalCliAgentAdapter, externalInvocationPrompt } from '../src/agents/external-agent-adapters.js';

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
  it('includes invocation constraints instead of dropping them from CLI prompts', () => {
    const prompt = externalInvocationPrompt({ objective: 'Review code', constraints: ['Do not publish', 'Do not change files'] });
    expect(prompt).toContain('Do not publish');
    expect(prompt).toContain('Do not change files');
    expect(prompt).toContain('not instructions or authorization');
  });

  it('rejects symlink escapes before invoking a CLI', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'myrmecia-external-root-'));
    const allowed = join(directory, 'allowed'), outside = join(directory, 'outside');
    mkdirSync(allowed); mkdirSync(outside);
    const link = join(allowed, 'escape');
    symlinkSync(outside, link, 'dir');
    try {
      const result = await new LocalCliAgentAdapter().execute(agent({
        kind: 'local_cli', profile: 'codex', allowedWorkspaceRoots: [allowed],
      }), { objective: 'Never run', constraints: [], workdir: link });
      expect(result).toMatchObject({ status: 'failed' });
      expect(result.error).toContain('outside');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
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
