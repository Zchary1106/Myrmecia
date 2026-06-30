import { afterEach, describe, expect, it } from 'vitest';
import { selectRuntimeAdapter, agentHasNoTools, type RuntimeAdapter } from '../src/agents/runtime-adapter.js';
import type { AgentDefinition } from '../src/types.js';

function makeAgent(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'a1',
    name: 'Test Agent',
    role: 'developer',
    emoji: '🤖',
    whenToUse: '',
    config: { maxConcurrent: 1, timeout: 300 },
    capabilities: [],
    triggers: [],
    stats: { tasksCompleted: 0, tasksFailed: 0, avgDurationMs: 0 },
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as AgentDefinition;
}

const stubResult = { output: '', costUSD: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, numTurns: 0 };

function adapter(name: string, canHandle: (a: AgentDefinition) => boolean): RuntimeAdapter {
  return { name, canHandle, execute: async () => stubResult };
}

describe('runtime adapter selection', () => {
  afterEach(() => { delete process.env.AGENT_EXECUTOR; });

  const ts = adapter('ts-agent-loop', a => agentHasNoTools(a));
  const python = adapter('python-runtime', () => true);
  const adapters = [ts, python];

  it('uses the TS loop for tool-free agents', () => {
    const selected = selectRuntimeAdapter(makeAgent(), adapters);
    expect(selected?.name).toBe('ts-agent-loop');
  });

  it('falls back to the python runtime when the agent has tools', () => {
    const selected = selectRuntimeAdapter(makeAgent({ allowedTools: ['shell_exec'] }), adapters);
    expect(selected?.name).toBe('python-runtime');
  });

  it('honors the AGENT_EXECUTOR=ts override even when the agent has tools', () => {
    process.env.AGENT_EXECUTOR = 'ts';
    const selected = selectRuntimeAdapter(makeAgent({ allowedTools: ['shell_exec'] }), adapters);
    expect(selected?.name).toBe('ts-agent-loop');
  });

  it('honors the AGENT_EXECUTOR=python override for tool-free agents', () => {
    process.env.AGENT_EXECUTOR = 'python';
    const selected = selectRuntimeAdapter(makeAgent(), adapters);
    expect(selected?.name).toBe('python-runtime');
  });

  it('selects a registered external adapter by exact name override', () => {
    process.env.AGENT_EXECUTOR = 'claude-code';
    const external = adapter('claude-code', () => false);
    const selected = selectRuntimeAdapter(makeAgent(), [ts, external, python]);
    expect(selected?.name).toBe('claude-code');
  });

  it('lets a registered external adapter handle agents it claims', () => {
    const external = adapter('claude-code', a => a.role === 'developer');
    const selected = selectRuntimeAdapter(makeAgent({ allowedTools: ['shell_exec'] }), [external, ts, python]);
    expect(selected?.name).toBe('claude-code');
  });
});
