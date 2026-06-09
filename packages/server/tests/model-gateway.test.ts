/**
 * Model gateway tests: provider resolution + streaming accumulation (no network).
 */

import { describe, expect, it } from 'vitest';
import { resolveProviderName, accumulateStream } from '../src/models/gateway.js';

describe('resolveProviderName', () => {
  const providers = {
    default: { baseURL: 'https://default/v1', apiKey: '' },
    openai: { baseURL: 'https://api.openai.com/v1', apiKey: 'k' },
    anthropic: { baseURL: 'https://api.anthropic.com/v1', apiKey: 'k' },
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
