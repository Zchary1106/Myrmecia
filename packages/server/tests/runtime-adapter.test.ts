import { afterEach, describe, expect, it } from 'vitest';
import { selectRuntimeAdapter, type RuntimeAdapter } from '../src/agents/runtime-adapter.js';
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
  afterEach(() => {
    delete process.env.AGENT_EXECUTOR;
    delete process.env.MYRMECIA_MODEL_PROVIDER;
  });

  const ts = adapter('ts-agent-loop', () => true);
  const adapters = [ts];

  it('uses the TS loop for tool-free agents', () => {
    const selected = selectRuntimeAdapter(makeAgent(), adapters);
    expect(selected?.name).toBe('ts-agent-loop');
  });

  it.each(['openai', 'deepseek', 'copilot'])('uses TS for built-in and MCP tools with %s', provider => {
    process.env.MYRMECIA_MODEL_PROVIDER = provider;
    for (const allowedTools of [['shell_exec'], ['web.search'], ['browser.query'], ['mcp__wechat-official-account__wechat_draft']]) {
      expect(selectRuntimeAdapter(makeAgent({ allowedTools }), adapters)?.name).toBe('ts-agent-loop');
    }
  });

  it('honors the AGENT_EXECUTOR=ts override even when the agent has tools', () => {
    process.env.AGENT_EXECUTOR = 'ts';
    const selected = selectRuntimeAdapter(makeAgent({ allowedTools: ['shell_exec'] }), adapters);
    expect(selected?.name).toBe('ts-agent-loop');
  });

  it.each(['python', 'python-runtime'])('rejects the retired %s override with migration guidance', executor => {
    process.env.AGENT_EXECUTOR = executor;
    expect(() => selectRuntimeAdapter(makeAgent(), adapters)).toThrow(/removed.*AGENT_EXECUTOR=ts/);
  });

  it('rejects an unknown override instead of silently using another runtime', () => {
    process.env.AGENT_EXECUTOR = 'unregistered';
    expect(() => selectRuntimeAdapter(makeAgent(), adapters)).toThrow('Unknown AGENT_EXECUTOR');
  });

  it('trims a valid explicit override', () => {
    process.env.AGENT_EXECUTOR = ' ts ';
    expect(selectRuntimeAdapter(makeAgent(), adapters)?.name).toBe('ts-agent-loop');
  });

  it('selects a registered external adapter by exact name override', () => {
    process.env.AGENT_EXECUTOR = 'claude-code';
    const external = adapter('claude-code', () => false);
    const selected = selectRuntimeAdapter(makeAgent(), [external, ts]);
    expect(selected?.name).toBe('claude-code');
  });

  it('lets a registered external adapter handle agents it claims', () => {
    const external = adapter('claude-code', a => a.role === 'developer');
    const selected = selectRuntimeAdapter(makeAgent({ allowedTools: ['shell_exec'] }), [external, ts]);
    expect(selected?.name).toBe('claude-code');
  });

  it('uses TS when an extension does not handle the Agent', () => {
    const external = adapter('claude-code', () => false);
    expect(selectRuntimeAdapter(makeAgent(), [external, ts])?.name).toBe('ts-agent-loop');
  });
});
