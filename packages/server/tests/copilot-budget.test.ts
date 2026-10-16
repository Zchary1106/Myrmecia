import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotProvider, type CopilotClientLike, type CopilotSessionLike } from '../src/models/copilot-provider.js';
import { AgentRunStopped } from '../src/agents/run-state.js';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { failedRequestUsage } from '../src/models/failed-request-usage.js';

afterEach(() => vi.useRealTimers());

function harness() {
  const handlers = new Map<string, (event: any) => void>();
  let finish!: (value: { data: { content: string } }) => void;
  let config: Parameters<CopilotClientLike['createSession']>[0];
  const session: CopilotSessionLike = {
    on: (event, handler) => { handlers.set(event, handler); return () => { handlers.delete(event); }; },
    sendAndWait: vi.fn(() => new Promise(resolve => { finish = resolve; })),
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  };
  const client: CopilotClientLike = {
    start: async () => undefined, stop: async () => [],
    createSession: async value => { config = value; return session; },
  };
  return {
    provider: new CopilotProvider({}, () => client), session, handlers,
    finish: () => finish({ data: { content: 'answer' } }),
    tools: () => config.tools!,
  };
}
const params = {
  model: 'test', messages: [{ role: 'user', content: 'research' }],
  tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
};

describe('Copilot execution budgets', () => {
  it('restores each request context for tools and deltas on a reused SDK transport', async () => {
    const context = new AsyncLocalStorage<string>();
    let transport!: AsyncResource;
    const seen: string[] = [];
    const provider = new CopilotProvider({}, () => ({
      start: async () => { transport = new AsyncResource('shared-sdk-fixture'); },
      stop: async () => [],
      createSession: async config => {
        const handlers = new Map<string, (event: any) => void>();
        return {
          on: (event, handler) => { handlers.set(event, handler); return () => { handlers.delete(event); }; },
          abort: async () => {}, disconnect: async () => {},
          sendAndWait: async () => {
            await transport.runInAsyncScope(config.tools![0].handler, undefined, {},
              { toolCallId: 'fixture', toolName: 'search' });
            transport.runInAsyncScope(handlers.get('assistant.message_delta')!, undefined,
              { data: { deltaContent: 'answer' } });
            return { data: { content: 'answer' } };
          },
        };
      },
    }));
    try {
      for (const scope of ['first', 'second']) {
        await context.run(scope, () => provider.complete(params, {
          onToolCall: async () => { seen.push(`tool:${context.getStore()}`); return 'data'; },
          onDelta: () => { seen.push(`delta:${context.getStore()}`); },
        }));
      }
      expect(seen).toEqual(['tool:first', 'delta:first', 'tool:second', 'delta:second']);
    } finally { transport.emitDestroy(); await provider.stop(); }
  });
  it('aborts the inner SDK loop on a terminal host tool refusal', async () => {
    const h = harness();
    const stop = new AgentRunStopped('tool_unavailable', 'TOOL_REJECTION_LIMIT: read the file');
    const pending = h.provider.complete(params, { onToolCall: async () => { throw stop; } });
    const failure = expect(pending).rejects.toBe(stop);
    await vi.waitFor(() => expect(h.tools()).toBeDefined());
    await expect(h.tools()[0].handler({}, { toolCallId: 'refused', toolName: 'search' })).rejects.toBe(stop);
    h.finish();
    await failure;
    expect(h.session.abort).toHaveBeenCalledOnce();
    await expect(h.tools()[0].handler({}, { toolCallId: 'late', toolName: 'search' })).rejects.toThrow('aborted');
    expect(h.handlers.size).toBe(0);
  });

  it('enforces observed token usage inside SDK turns including prior host usage', async () => {
    const h = harness();
    const pending = h.provider.complete(params, { onToolCall: async () => 'data',
      contextBudget: { limits: { maxExecutionTokens: 100 }, inputTokens: 20, outputTokens: 10 } });
    const failure = expect(pending).rejects.toMatchObject({ reason: 'token_budget' });
    const stopped = pending.catch(error => error);
    await vi.waitFor(() => expect(h.handlers.has('assistant.usage')).toBe(true));
    h.handlers.get('assistant.usage')!({ data: { inputTokens: 40, outputTokens: 5 } });
    expect(h.session.abort).not.toHaveBeenCalled();
    h.handlers.get('assistant.usage')!({ data: { inputTokens: 30, outputTokens: 1 } });
    h.finish();
    await failure;
    expect(failedRequestUsage(await stopped)).toMatchObject({
      prompt_tokens: 70, completion_tokens: 6, total_tokens: 76,
      input_tokens_observed: true, output_tokens_observed: true, cost_type: 'subscription', cost_usd: null,
    });
    expect(h.session.abort).toHaveBeenCalledOnce();
    expect(h.handlers.size).toBe(0);
  });
  it('does not hang forever after successful output when SDK disconnect never settles', async () => {
    vi.useFakeTimers();
    const session: CopilotSessionLike = {
      on: () => () => {}, sendAndWait: async () => ({ data: { content: 'Answer' } }),
      abort: async () => {}, disconnect: () => new Promise(() => {}),
    };
    const provider = new CopilotProvider({}, () => ({ start: async () => {}, stop: async () => [], createSession: async () => session }));
    const pending = provider.complete({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }] });
    await vi.advanceTimersByTimeAsync(5001);
    expect((await pending).usage.session_cleanup_confirmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds session startup and disposes a late session without sending the prompt', async () => {
    vi.useFakeTimers();
    let finish!: (session: CopilotSessionLike) => void;
    const session: CopilotSessionLike = {
      on: () => () => undefined, sendAndWait: vi.fn(),
      abort: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    };
    const provider = new CopilotProvider({}, () => ({
      start: async () => undefined, stop: async () => [],
      createSession: () => new Promise(resolve => { finish = resolve; }),
    }));
    const pending = provider.complete(params, { onToolCall: async () => 'data', timeoutMs: 1000 });
    const failure = expect(pending).rejects.toThrow(/EXECUTION_(IDLE|WALL)_TIMEOUT/);
    await vi.advanceTimersByTimeAsync(1001);
    await failure;
    finish(session);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.sendAndWait).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows ongoing progress beyond 120 seconds and cleans up after success', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.provider.complete(params, { onToolCall: async () => 'data' });
    await vi.advanceTimersByTimeAsync(100_000);
    h.handlers.get('assistant.message_delta')!({ data: { deltaContent: 'working' } });
    await vi.advanceTimersByTimeAsync(100_000);
    h.finish();
    expect((await pending).choices[0].message.content).toBe('answer');
    expect(h.session.sendAndWait).toHaveBeenCalledWith({ prompt: 'research' }, 600_000);
    expect(h.session.abort).not.toHaveBeenCalled();
    expect(h.handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a silent session and prevents late tools and deltas', async () => {
    vi.useFakeTimers();
    const h = harness();
    const tool = vi.fn().mockResolvedValue('data');
    const pending = h.provider.complete(params, { onToolCall: tool, idleTimeoutMs: 1000 });
    const failure = expect(pending).rejects.toThrow('EXECUTION_IDLE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(1001);
    await failure;
    expect(h.session.abort).toHaveBeenCalledOnce();
    await expect(h.tools()[0].handler({}, { toolCallId: 'late', toolName: 'search' })).rejects.toThrow('aborted');
    expect(tool).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces the total deadline even with continuous progress', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.provider.complete(params, { onToolCall: async () => 'data', timeoutMs: 3000, idleTimeoutMs: 2000 });
    const failure = expect(pending).rejects.toThrow('EXECUTION_WALL_TIMEOUT');
    await vi.advanceTimersByTimeAsync(1000);
    h.handlers.get('assistant.message_delta')!({ data: { deltaContent: 'a' } });
    await vi.advanceTimersByTimeAsync(1000);
    h.handlers.get('assistant.message_delta')!({ data: { deltaContent: 'b' } });
    await vi.advanceTimersByTimeAsync(1001);
    await failure;
    expect(h.session.abort).toHaveBeenCalledOnce();
    expect(h.session.disconnect).toHaveBeenCalledOnce();
  });

  it('settles promptly on user cancellation even if the SDK never becomes idle', async () => {
    vi.useFakeTimers();
    const h = harness();
    const controller = new AbortController();
    const pending = h.provider.complete(params, { onToolCall: async () => 'data', signal: controller.signal });
    const failure = expect(pending).rejects.toThrow('Request aborted');
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await failure;
    expect(h.session.abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
