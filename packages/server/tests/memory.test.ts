/**
 * Tests for Memory System: HNSW Index + Trajectory Store
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HNSWIndex } from '../src/memory/hnsw.js';

describe('HNSWIndex', () => {
  let index: HNSWIndex;

  beforeEach(() => {
    index = new HNSWIndex({ dimensions: 4 });
  });

  it('should add and search vectors', () => {
    index.add('a', [1, 0, 0, 0]);
    index.add('b', [0, 1, 0, 0]);
    index.add('c', [0.9, 0.1, 0, 0]);

    const results = index.search([1, 0, 0, 0], 2);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('a'); // exact match
    expect(results[1].id).toBe('c'); // closest
  });

  it('should return empty for empty index', () => {
    const results = index.search([1, 0, 0, 0], 5);
    expect(results).toEqual([]);
  });

  it('should handle remove', () => {
    index.add('a', [1, 0, 0, 0]);
    index.add('b', [0, 1, 0, 0]);
    index.remove('a');

    expect(index.size()).toBe(1);
    const results = index.search([1, 0, 0, 0], 5);
    expect(results[0].id).toBe('b');
  });

  it('should serialize and deserialize', () => {
    index.add('a', [1, 0, 0, 0]);
    index.add('b', [0, 1, 0, 0]);
    index.add('c', [0, 0, 1, 0]);

    const buf = index.serialize();
    const restored = HNSWIndex.deserialize(buf);

    expect(restored.size()).toBe(3);
    const results = restored.search([1, 0, 0, 0], 1);
    expect(results[0].id).toBe('a');
  });

  it('should handle many vectors', () => {
    // Add 100 random vectors
    for (let i = 0; i < 100; i++) {
      const v = [Math.random(), Math.random(), Math.random(), Math.random()];
      // Normalize
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      index.add(`v${i}`, v.map(x => x / norm));
    }

    expect(index.size()).toBe(100);
    const results = index.search([1, 0, 0, 0], 5);
    expect(results.length).toBe(5);
    // Results should be sorted by distance
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
  });

  it('should reject dimension mismatch', () => {
    expect(() => index.add('x', [1, 0, 0])).toThrow('dimensions mismatch');
  });
});

describe('EmbeddingService', () => {
  it('should provide pseudo embeddings when no API key', async () => {
    // Clear env to force pseudo backend
    const orig = process.env.OPENAI_API_KEY;
    const origBackend = process.env.EMBEDDING_BACKEND;
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDING_BACKEND;

    // Reset singleton
    const { resetEmbeddingService, getEmbeddingService } = await import('../src/memory/embedding.js');
    resetEmbeddingService();

    const svc = getEmbeddingService();
    expect(svc.backend).toBe('pseudo');

    const emb = await svc.embed('hello world');
    expect(emb.length).toBe(svc.dimensions);
    // Should be normalized (length ≈ 1)
    const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 1);

    // Same input → same output (deterministic)
    const emb2 = await svc.embed('hello world');
    expect(emb).toEqual(emb2);

    // Restore
    if (orig) process.env.OPENAI_API_KEY = orig;
    if (origBackend) process.env.EMBEDDING_BACKEND = origBackend;
    resetEmbeddingService();
  });
});
