import { describe, it, expect, beforeEach } from 'vitest';
import { LLMCache } from './llm-cache.js';

describe('LLMCache', () => {
  let cache: LLMCache;

  beforeEach(() => {
    cache = new LLMCache({ maxSize: 100, ttlMs: 60_000 });
  });

  it('returns undefined on cache miss', () => {
    const result = cache.get({ model: 'gpt-5.4', system: 'You are PM', prompt: 'hello' });
    expect(result).toBeUndefined();
  });

  it('returns cached response on exact match', () => {
    const key = { model: 'gpt-5.4', system: 'You are PM', prompt: 'hello' };
    cache.set(key, { output: 'world', inputTokens: 10, outputTokens: 5 });
    const result = cache.get(key);
    expect(result).toEqual({ output: 'world', inputTokens: 10, outputTokens: 5 });
  });

  it('does not match different prompts', () => {
    cache.set({ model: 'gpt-5.4', system: 'sys', prompt: 'a' }, { output: 'x', inputTokens: 1, outputTokens: 1 });
    const result = cache.get({ model: 'gpt-5.4', system: 'sys', prompt: 'b' });
    expect(result).toBeUndefined();
  });

  it('evicts entries beyond maxSize', () => {
    const small = new LLMCache({ maxSize: 2, ttlMs: 60_000 });
    small.set({ model: 'm', system: 's', prompt: '1' }, { output: 'a', inputTokens: 1, outputTokens: 1 });
    small.set({ model: 'm', system: 's', prompt: '2' }, { output: 'b', inputTokens: 1, outputTokens: 1 });
    small.set({ model: 'm', system: 's', prompt: '3' }, { output: 'c', inputTokens: 1, outputTokens: 1 });
    expect(small.get({ model: 'm', system: 's', prompt: '1' })).toBeUndefined();
    expect(small.get({ model: 'm', system: 's', prompt: '3' })).toEqual({ output: 'c', inputTokens: 1, outputTokens: 1 });
  });

  it('expires entries after TTL', () => {
    const shortTtl = new LLMCache({ maxSize: 100, ttlMs: 1 });
    shortTtl.set({ model: 'm', system: 's', prompt: 'x' }, { output: 'y', inputTokens: 1, outputTokens: 1 });
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    expect(shortTtl.get({ model: 'm', system: 's', prompt: 'x' })).toBeUndefined();
  });

  it('reports stats', () => {
    const key = { model: 'm', system: 's', prompt: 'p' };
    cache.get(key); // miss
    cache.set(key, { output: 'r', inputTokens: 1, outputTokens: 1 });
    cache.get(key); // hit
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });
});
