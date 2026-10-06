import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotProvider, type CopilotClientLike, type CopilotSessionLike } from '../src/models/copilot-provider.js';

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
