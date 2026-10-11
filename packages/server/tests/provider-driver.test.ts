import { describe, expect, it, vi } from 'vitest';
import { defaultRuntimeCapabilities, type RuntimeEvent } from '@myrmecia/shared';
import { ProviderDriver, normalizeGatewayRequest, toGatewayRequest } from '../src/models/provider-driver.js';
import { createScriptedProvider, fixtureCompletion } from './fixtures/runtime-providers.js';
import { CopilotProvider, type CopilotSessionLike } from '../src/models/copilot-provider.js';
import { accumulateStream } from '../src/models/gateway.js';
const identity = { workspaceId: 'w', conversationId: 'c', runId: 'r', requestId: 'q' };
const request = normalizeGatewayRequest({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 });
describe('normalized Provider contract', () => {
  it('keeps a missing OpenAI-compatible streaming usage receipt unknown too', async () => {
    const driver = new ProviderDriver({
      providerFor: () => 'fixture',
      completeForModel: async () => accumulateStream((async function* () {
        yield { choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] };
      })()),
    }, 'fixture', { identity });
    expect((await driver.complete(request, new AbortController().signal)).metrics)
      .toMatchObject({ inputTokens: null, outputTokens: null, modelTurnCount: 1 });
  });
  it.each([undefined, { inputTokens: 0 }, { outputTokens: 7 }])('keeps unobserved SDK usage unknown and observed zero distinct: %s', async usage => {
    const listeners = new Map<string, (event: any) => void>();
    const session: CopilotSessionLike = {
      on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); },
      sendAndWait: async () => {
        if (usage) listeners.get('assistant.usage')?.({ data: usage });
        return { data: { content: 'Answer' } };
      },
      abort: async () => {}, disconnect: async () => {},
    };
    const sdk = new CopilotProvider({}, () => ({
      start: async () => {}, stop: async () => [], createSession: async () => session,
    }));
    const driver = new ProviderDriver({
      providerFor: () => 'copilot',
      completeForModel: (_id, params, options) => sdk.complete(params, options),
    }, 'fixture', { identity });
    const result = await driver.complete(request, new AbortController().signal);
    expect(result.metrics.inputTokens).toBe(usage && 'inputTokens' in usage ? usage.inputTokens : null);
    expect(result.metrics.outputTokens).toBe(usage && 'outputTokens' in usage ? usage.outputTokens : null);
    expect(result.metrics.modelTurnCount).toBeNull();
    expect(result.costUSD).toBeNull();
  });
  it('normalizes host usage, final text and scoped sequence without inventing cost', async () => {
    const events: RuntimeEvent[] = [];
    const scripted = createScriptedProvider([fixtureCompletion('Answer')]);
    const driver = new ProviderDriver({ ...scripted, providerFor: () => 'fixture' }, 'fixture', { identity, onEvent: event => events.push(event) });
    const result = await driver.complete(request, new AbortController().signal);
    expect(result.metrics).toEqual({ requestCount: 1, modelTurnCount: 1, toolCallCount: 0, inputTokens: 10, outputTokens: 10 });
    expect(result.costUSD).toBeNull();
    expect(events.map(event => event.type)).toEqual(['request.started', 'assistant.completed', 'usage', 'request.stopped']);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.every(event => event.workspaceId === 'w' && event.requestId === 'q')).toBe(true);
  });
  it('does not report SDK internal turns as a single host turn', async () => {
    const events: RuntimeEvent[] = [];
    const onToolCall = vi.fn(async () => 'fixture data');
    const transport = {
      providerFor: () => 'custom-sdk-name',
      runtimeCapabilitiesFor: () => defaultRuntimeCapabilities('provider_loop'),
      completeForModel: async (_id: string, _params: any, options: any) => {
        await options.onToolCall({ id: '1', function: { name: 'read', arguments: '{}' } });
        await options.onToolCall({ id: '2', function: { name: 'read', arguments: '{}' } });
        return { choices: [{ message: { role: 'assistant', content: 'Answer' }, finish_reason: 'stop' }], usage: {} };
      },
    };
    const driver = new ProviderDriver(transport, 'fixture', { identity, onToolCall, onEvent: event => events.push(event) });
    const result = await driver.complete(request, new AbortController().signal);
    expect(result.metrics).toMatchObject({ requestCount: 1, modelTurnCount: null, toolCallCount: 2, inputTokens: null });
    expect(result.costType).toBe('subscription');
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(events.filter(event => event.type === 'tool.started')).toHaveLength(2);
  });
  it('preserves tool messages and schema through the compatibility boundary', () => {
    const original = {
      model: 'fixture', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: '1', content: 'evidence' }],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], max_tokens: 100,
    };
    const restored = toGatewayRequest(normalizeGatewayRequest(original), defaultRuntimeCapabilities('host_loop'));
    expect(restored.messages[0].tool_calls).toEqual(original.messages[0].tool_calls);
    expect(restored.messages[1]).toMatchObject({ role: 'tool', tool_call_id: '1', content: 'evidence' });
    expect(restored.tools[0].function.parameters).toEqual({ type: 'object' });
  });
  it('rejects unknown image capability and a missing tool result id before transport', async () => {
    const completeForModel = vi.fn();
    const driver = new ProviderDriver({ providerFor: () => 'fixture', completeForModel }, 'fixture', { identity });
    await expect(driver.complete({ ...request, messages: [{ role: 'user', content: [{ type: 'image', uri: 'fixture://image' }] }] },
      new AbortController().signal)).rejects.toThrow('IMAGE_INPUT_UNSUPPORTED');
    await expect(driver.complete({ ...request, messages: [{ role: 'tool', content: [{ type: 'text', text: 'evidence' }] }] },
      new AbortController().signal)).rejects.toThrow('MISSING_ID');
    expect(completeForModel).not.toHaveBeenCalled();
  });
  it('does not expose arbitrary model reasoning or exception text in events', async () => {
    const events: RuntimeEvent[] = [];
    const driver = new ProviderDriver({ providerFor: () => 'fixture',
      completeForModel: async () => { throw new Error('secret=private-example'); },
    }, 'fixture', { identity, onEvent: event => events.push(event) });
    await expect(driver.complete(request, new AbortController().signal)).rejects.toThrow('secret=');
    expect(JSON.stringify(events)).not.toContain('private-example');
    expect(events.at(-1)).toMatchObject({ type: 'request.stopped', reason: 'failed' });
  });
  it('rejects partial or non-object tool arguments instead of dispatching an empty fallback', async () => {
    for (const args of ['{"path":', '[]', 'null']) {
      const scripted = createScriptedProvider([fixtureCompletion('', 'tool_calls', [
        { id: 'a', type: 'function', function: { name: 'write', arguments: args } },
      ])]);
      const driver = new ProviderDriver({ ...scripted, providerFor: () => 'fixture' }, 'fixture', { identity });
      await expect(driver.complete(request, new AbortController().signal)).rejects.toThrow('MODEL_TOOL_ARGUMENTS_INVALID');
    }
    const onToolCall = vi.fn();
    const driver = new ProviderDriver({
      providerFor: () => 'copilot',
      completeForModel: async (_id, _params, options) => options!.onToolCall!({ id: 'a', function: { name: 'write', arguments: '[' } }),
    }, 'fixture', { identity, onToolCall });
    await expect(driver.complete(request, new AbortController().signal)).rejects.toThrow('MODEL_TOOL_ARGUMENTS_INVALID');
    expect(onToolCall).not.toHaveBeenCalled();
  });
});
