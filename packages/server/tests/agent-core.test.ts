import { describe, expect, it, vi } from 'vitest';
import { defaultRuntimeCapabilities, type RuntimeRequest, type RuntimeResponse } from '@myrmecia/shared';
import { runAgentCore } from '../src/agents/core/loop.js';
import { composeTurnHooks } from '../src/agents/core/hooks.js';

const request = (): RuntimeRequest => ({ modelId: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect' }] }] });
const reply = (tools: RuntimeResponse['toolCalls'] = []): RuntimeResponse => ({
  content: tools.length ? [] : [{ type: 'text', text: 'Verified' }], toolCalls: tools,
  stopReason: tools.length ? 'tool_calls' : 'stop',
  provider: 'fixture', costType: 'unavailable', costUSD: null,
  metrics: { requestCount: 1, modelTurnCount: 1, toolCallCount: 0, inputTokens: null, outputTokens: null },
});
describe('thin Agent Core', () => {
  it('owns the actual request/tool loop and runs hooks in fixed order', async () => {
    const order: string[] = [];
    const complete = vi.fn()
      .mockImplementationOnce(async () => { order.push('request'); return reply([{ id: 't', name: 'read', arguments: '{}' }]); })
      .mockImplementationOnce(async value => {
        order.push('request');
        expect(value.messages.find((message: any) => message.role === 'tool').content[0].text).toBe('evidence');
        return reply();
      });
    const hooks = composeTurnHooks([{
      prepareRequest: value => { order.push('prepare'); return value; },
      transformContext: value => { order.push('transform'); return value; },
      beforeToolCall: () => { order.push('before'); },
      afterToolCall: () => { order.push('after'); },
      finishTurn: () => { order.push('finish'); },
      prepareNextTurn: value => { order.push('next'); return value; },
    }]);
    const result = await runAgentCore(request(), {
      maxTurns: 2, signal: new AbortController().signal, hooks,
      provider: { capabilities: defaultRuntimeCapabilities('host_loop'), complete },
      executeTool: async () => { order.push('tool'); return 'evidence'; },
    });
    expect(result.turns).toBe(2);
    expect(order).toEqual(['prepare', 'transform', 'request', 'before', 'tool', 'after', 'finish', 'next', 'prepare', 'transform', 'request', 'finish']);
  });
  it('cannot execute tools after a rejecting governance hook', async () => {
    const executeTool = vi.fn();
    await expect(runAgentCore(request(), {
      maxTurns: 2, signal: new AbortController().signal, executeTool,
      provider: { capabilities: defaultRuntimeCapabilities('host_loop'), complete: async () => reply([{ id: 't', name: 'write', arguments: '{}' }]) },
      hooks: composeTurnHooks([{ beforeToolCall: () => { throw new Error('DENIED'); } }]),
    })).rejects.toThrow('DENIED');
    expect(executeTool).not.toHaveBeenCalled();
  });
  it('rejects a response resolving after abort before output or tools can be used', async () => {
    const controller = new AbortController();
    const finish = vi.fn();
    await expect(runAgentCore(request(), {
      maxTurns: 1, signal: controller.signal, executeTool: vi.fn(), hooks: { finishTurn: finish },
      provider: { capabilities: defaultRuntimeCapabilities('host_loop'), complete: async () => { controller.abort(); return reply(); } },
    })).rejects.toMatchObject({ reason: 'cancelled' });
    expect(finish).not.toHaveBeenCalled();
  });
  it('does not replay SDK-owned tool calls at the host boundary', async () => {
    const executeTool = vi.fn();
    await expect(runAgentCore(request(), {
      maxTurns: 1, signal: new AbortController().signal, executeTool,
      provider: { capabilities: defaultRuntimeCapabilities('provider_loop'), complete: async () => reply([{ id: 't', name: 'read', arguments: '{}' }]) },
    })).rejects.toThrow('PROVIDER_OWNED_TOOLS');
    expect(executeTool).not.toHaveBeenCalled();
  });
  it('preserves a max-turn stop rather than accepting a tools-only response', async () => {
    await expect(runAgentCore(request(), {
      maxTurns: 1, signal: new AbortController().signal, executeTool: async () => 'evidence',
      provider: { capabilities: defaultRuntimeCapabilities('host_loop'), complete: async () => reply([{ id: 't', name: 'read', arguments: '{}' }]) },
    })).rejects.toMatchObject({ reason: 'max_turns' });
  });
  it('retains ordered middleware transformations and stops on hook cancellation', async () => {
    const controller = new AbortController();
    const complete = vi.fn();
    await expect(runAgentCore(request(), {
      maxTurns: 1, signal: controller.signal, executeTool: vi.fn(),
      provider: { capabilities: defaultRuntimeCapabilities('host_loop'), complete },
      hooks: composeTurnHooks([{ prepareRequest: value => { controller.abort(); return value; } }]),
    })).rejects.toMatchObject({ reason: 'cancelled' });
    expect(complete).not.toHaveBeenCalled();
  });
});
