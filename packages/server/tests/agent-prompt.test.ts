/**
 * buildAgentSystemPrompt — composes the agent system prompt from the runtime
 * profile and an optional skill override. Shared by both executor paths, so its
 * output is worth pinning down.
 */

import { describe, it, expect } from 'vitest';
import type { AgentDefinition } from '../src/types.js';
import { buildAgentSystemPrompt } from '../src/agents/agent-prompt.js';

function agent(o: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'dev',
    name: 'Dev Agent',
    role: 'developer',
    description: 'Writes production code',
    whenToUse: 'Implementation tasks',
    capabilities: ['typescript', 'react'],
    ...o,
  } as AgentDefinition;
}

describe('buildAgentSystemPrompt', () => {
  it('composes a runtime profile from the agent fields', () => {
    const prompt = buildAgentSystemPrompt(agent(), ['file_read', 'shell_exec']);
    expect(prompt).toContain('You are Dev Agent, a developer agent.');
    expect(prompt).toContain('Mission: Writes production code');
    expect(prompt).toContain('When to use: Implementation tasks');
    expect(prompt).toContain('Capabilities: typescript, react');
    expect(prompt).toContain('Allowed tools: file_read, shell_exec');
  });

  it('omits the allowed-tools line when there are no tools', () => {
    const prompt = buildAgentSystemPrompt(agent(), []);
    expect(prompt).not.toContain('Allowed tools:');
  });

  it('omits optional lines that are absent', () => {
    const prompt = buildAgentSystemPrompt(
      agent({ description: undefined, whenToUse: '', capabilities: [] }),
      [],
    );
    expect(prompt).toContain('You are Dev Agent, a developer agent.');
    expect(prompt).not.toContain('Mission:');
    expect(prompt).not.toContain('When to use:');
    expect(prompt).not.toContain('Capabilities:');
  });

  it('layers a resolved skill over the runtime profile', () => {
    const prompt = buildAgentSystemPrompt(agent(), ['file_read'], '# Skill\nDo the thing.');
    expect(prompt.startsWith('# Skill\nDo the thing.')).toBe(true);
    expect(prompt).toContain('## Runtime Profile Override');
    expect(prompt).toContain('You are Dev Agent, a developer agent.');
  });

  it('returns just the runtime profile when no skill content and no skill path', () => {
    const prompt = buildAgentSystemPrompt(agent({ skillPath: undefined }), []);
    expect(prompt).not.toContain('## Runtime Profile Override');
    expect(prompt).toContain('You are Dev Agent, a developer agent.');
  });
});
