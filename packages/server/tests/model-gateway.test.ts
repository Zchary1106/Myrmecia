/**
 * Model gateway tests: provider resolution + streaming accumulation (no network).
 */

import { describe, expect, it } from 'vitest';
import { resolveProviderName, accumulateStream, readProviders } from '../src/models/gateway.js';
import { CopilotProvider, type CopilotClientLike, type CopilotSessionLike } from '../src/models/copilot-provider.js';

describe('resolveProviderName', () => {
  const providers = {
    default: { type: 'openai' as const, baseURL: 'https://default/v1', apiKey: '' },
    openai: { type: 'openai' as const, baseURL: 'https://api.openai.com/v1', apiKey: 'k' },
    anthropic: { type: 'openai' as const, baseURL: 'https://api.anthropic.com/v1', apiKey: 'k' },
  };

  it('uses explicit map first', () => {
    expect(resolveProviderName('gpt-5.5', providers, { 'gpt-5.5': 'anthropic' })).toBe('anthropic');
  });

  it('falls back to prefix heuristic', () => {
    expect(resolveProviderName('gpt-5.5', providers, {})).toBe('openai');
    expect(resolveProviderName('claude-opus-4.8', providers, {})).toBe('anthropic');
  });

  it('defaults when nothing matches', () => {
    expect(resolveProviderName('mystery-model', providers, {})).toBe('default');
    expect(resolveProviderName(undefined, providers, {})).toBe('default');
  });
});

describe('Copilot provider configuration', () => {
  it('recognizes a server-side Copilot provider without reading token fields', () => {
    const previous = process.env.MODEL_PROVIDERS;
    try {
      process.env.MODEL_PROVIDERS = JSON.stringify({
        copilot: {
          type: 'copilot',
          baseDirectory: '/server-only/copilot-home',
          apiKey: 'must-not-be-used',
          apiKeyEnv: 'GITHUB_TOKEN',
        },
      });

      expect(readProviders().copilot).toEqual({
        type: 'copilot',
        baseDirectory: '/server-only/copilot-home',
        cliPath: undefined,
      });
    } finally {
      if (previous === undefined) delete process.env.MODEL_PROVIDERS;
      else process.env.MODEL_PROVIDERS = previous;
    }
  });

  it('selects Copilot from MYRMECIA_MODEL_PROVIDER without a Dashboard model map', () => {
    const previous = process.env.MYRMECIA_MODEL_PROVIDER;
    try {
      process.env.MYRMECIA_MODEL_PROVIDER = 'copilot';
      const providers = readProviders();
      expect(providers.copilot?.type).toBe('copilot');
      expect(resolveProviderName('any-model', providers, {})).toBe('copilot');
    } finally {
      if (previous === undefined) delete process.env.MYRMECIA_MODEL_PROVIDER;
      else process.env.MYRMECIA_MODEL_PROVIDER = previous;
    }
  });
});

describe('CopilotProvider', () => {
  it('discovers models from the signed-in Copilot account', async () => {
    const models = [{
      id: 'claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      capabilities: {},
      supportedReasoningEfforts: ['low', 'high'],
    }] as any[];
    const client: CopilotClientLike = {
      start: async () => undefined,
      stop: async () => [],
      listModels: async () => models,
      createSession: async () => { throw new Error('session should not be created'); },
    };
    const provider = new CopilotProvider({}, () => client);

    await expect(provider.listModels()).resolves.toEqual(models);
  });

  it('uses only the logged-in local SDK session with a deny-by-default tool allow-list', async () => {
    let clientOptions: any;
    let sessionConfig: any;
    let aborts = 0;
    let disconnects = 0;
    const deltaHandlers: Array<(event: { data: { deltaContent: string } }) => void> = [];
    const session: CopilotSessionLike = {
      on: (_event, handler) => {
        deltaHandlers.push(handler);
        return () => undefined;
      },
      sendAndWait: async ({ prompt }) => {
        expect(prompt).toBe('Explain the adapter.');
        deltaHandlers.forEach(handler => handler({ data: { deltaContent: 'Hello' } }));
        return { data: { content: 'Hello from Copilot' } };
      },
      abort: async () => { aborts++; },
      disconnect: async () => { disconnects++; },
    };
    const client: CopilotClientLike = {
      start: async () => undefined,
      stop: async () => [],
      createSession: async config => {
        sessionConfig = config;
        return session;
      },
    };
    const provider = new CopilotProvider(
      { baseDirectory: '/server-only/copilot-home' },
      options => {
        clientOptions = options;
        return client;
      },
    );
    const deltas: string[] = [];

    const result = await provider.complete({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Explain the adapter.' },
      ],
    }, { onDelta: delta => deltas.push(delta) });

    expect(clientOptions).toMatchObject({
      mode: 'empty',
      useLoggedInUser: true,
      baseDirectory: '/server-only/copilot-home',
      logLevel: 'error',
    });
    expect(clientOptions).not.toHaveProperty('gitHubToken');
    expect(sessionConfig).toEqual({
      model: 'gpt-5',
      availableTools: [],
      systemMessage: { mode: 'append', content: 'Be concise.' },
      streaming: true,
    });
    expect(result.choices[0].message.content).toBe('Hello from Copilot');
    expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(deltas).toEqual(['Hello']);
    expect(aborts).toBe(0);
    expect(disconnects).toBe(1);
  });

  it('fails closed when an OpenAI function tool has no server-side handler', async () => {
    const provider = new CopilotProvider({}, () => {
      throw new Error('SDK should not start for unsupported tools');
    });

    await expect(provider.complete({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Use a tool' }],
      tools: [{ type: 'function' }],
    })).rejects.toThrow('requires a server-side tool handler');
  });

  it('bridges allowed OpenAI function tools back to the server-side handler', async () => {
    let sessionConfig: any;
    const session: CopilotSessionLike = {
      on: () => () => undefined,
      sendAndWait: async () => {
        const output = await sessionConfig.tools[0].handler({ query: 'status' }, {
          toolCallId: 'call_1',
          toolName: 'tool_0_web_search',
        });
        expect(output).toBe('safe tool output');
        return { data: { content: 'Completed with the tool result.' } };
      },
      abort: async () => undefined,
      disconnect: async () => undefined,
    };
    const client: CopilotClientLike = {
      start: async () => undefined,
      stop: async () => [],
      createSession: async config => {
        sessionConfig = config;
        return session;
      },
    };
    const calls: any[] = [];
    const provider = new CopilotProvider({}, () => client);

    const result = await provider.complete({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Search for status.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'tool_0_web_search',
          description: 'Search safely',
          parameters: { type: 'object' },
        },
      }],
    }, {
      onToolCall: async call => {
        calls.push(call);
        return 'safe tool output';
      },
    });

    expect(sessionConfig.availableTools).toEqual(['custom:*']);
    expect(sessionConfig.tools).toHaveLength(1);
    expect(sessionConfig.tools[0].defer).toBe('never');
    expect(calls).toEqual([{
      id: 'call_1',
      function: { name: 'tool_0_web_search', arguments: '{"query":"status"}' },
    }]);
    expect(result.choices[0].message.content).toBe('Completed with the tool result.');
  });
});

async function* fakeStream(chunks: any[]) {
  for (const c of chunks) yield c;
}

describe('accumulateStream', () => {
  it('accumulates text deltas and emits them', async () => {
    const deltas: string[] = [];
    const result = await accumulateStream(fakeStream([
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ', world' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ]), (d) => deltas.push(d));

    expect(result.choices[0].message.content).toBe('Hello, world');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage.total_tokens).toBe(7);
    expect(deltas).toEqual(['Hello', ', world']);
  });

  it('accumulates streamed tool calls by index', async () => {
    const result = await accumulateStream(fakeStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'add', arguments: '{"a":1' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ',"b":2}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]));

    const tc = result.choices[0].message.tool_calls!;
    expect(tc.length).toBe(1);
    expect(tc[0].id).toBe('c1');
    expect(tc[0].function.name).toBe('add');
    expect(JSON.parse(tc[0].function.arguments)).toEqual({ a: 1, b: 2 });
  });
});
