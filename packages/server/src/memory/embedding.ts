/**
 * Embedding Service — Dual Backend (OpenAI + Local MiniLM)
 *
 * Configuration:
 * - EMBEDDING_BACKEND=openai (default) | local
 * - EMBEDDING_MODEL=text-embedding-3-small | all-MiniLM-L6-v2
 * - OPENAI_API_KEY required for openai backend
 */

import { logger } from '../lib/logger.js';

// ---------- Interface ----------

export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly backend: string;
}

// ---------- LRU Cache ----------

class LRUCache<K, V> {
  private map = new Map<K, V>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // Move to end (most recent)
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
  }
}

// ---------- OpenAI Backend ----------

class OpenAIEmbedding implements EmbeddingService {
  readonly dimensions: number;
  readonly backend = 'openai';
  private model: string;
  private cache = new LRUCache<string, number[]>(1000);

  constructor() {
    this.model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
    // text-embedding-3-small = 1536 dims, text-embedding-3-large = 3072
    this.dimensions = this.model.includes('large') ? 3072 : 1536;
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) return cached;

    const result = await this.callApi([text]);
    this.cache.set(text, result[0]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const uncached: { idx: number; text: string }[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(texts[i]);
      if (cached) {
        results[i] = cached;
      } else {
        uncached.push({ idx: i, text: texts[i] });
      }
    }

    if (uncached.length > 0) {
      const embeddings = await this.callApi(uncached.map(u => u.text));
      for (let i = 0; i < uncached.length; i++) {
        results[uncached[i].idx] = embeddings[i];
        this.cache.set(uncached[i].text, embeddings[i]);
      }
    }

    return results;
  }

  private async callApi(inputs: string[]): Promise<number[][]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY required for openai embedding backend');

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: inputs }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI embedding API error: ${res.status} ${err}`);
    }

    const data = await res.json() as any;
    return data.data.map((d: any) => d.embedding);
  }
}

// ---------- Local MiniLM Backend ----------

class LocalEmbedding implements EmbeddingService {
  readonly dimensions = 384;
  readonly backend = 'local';
  private pipeline: any = null;
  private cache = new LRUCache<string, number[]>(1000);
  private initPromise: Promise<void> | null = null;

  private async ensureLoaded(): Promise<void> {
    if (this.pipeline) return;
    if (this.initPromise) { await this.initPromise; return; }

    this.initPromise = (async () => {
      try {
        // Dynamic import — only loaded when EMBEDDING_BACKEND=local
        const transformers = await import(/* @vite-ignore */ '@xenova/transformers');
        this.pipeline = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        logger.info('Local MiniLM embedding model loaded');
      } catch (err: any) {
        throw new Error(
          `Failed to load local embedding model. Install @xenova/transformers: ${err.message}`
        );
      }
    })();

    await this.initPromise;
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) return cached;

    await this.ensureLoaded();
    const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data as Float32Array).slice(0, this.dimensions);
    this.cache.set(text, embedding);
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Process sequentially to avoid OOM with large batches
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

// ---------- Pseudo Embedding (Fallback/Testing) ----------

class PseudoEmbedding implements EmbeddingService {
  readonly dimensions = 256;
  readonly backend = 'pseudo';

  async embed(text: string): Promise<number[]> {
    return this.generate(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.generate(t));
  }

  private generate(text: string): number[] {
    const embedding = new Array(this.dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      embedding[i % this.dimensions] += text.charCodeAt(i) / 1000;
    }
    const norm = Math.sqrt(embedding.reduce((s: number, v: number) => s + v * v, 0));
    return norm > 0 ? embedding.map((v: number) => v / norm) : embedding;
  }
}

// ---------- Singleton Factory ----------

let instance: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService {
  if (instance) return instance;

  const backend = process.env.EMBEDDING_BACKEND || 'openai';

  switch (backend) {
    case 'local':
      instance = new LocalEmbedding();
      logger.info('Using local MiniLM embedding (384 dims)');
      break;
    case 'openai':
      if (!process.env.OPENAI_API_KEY) {
        logger.warn('OPENAI_API_KEY not set, falling back to pseudo embedding');
        instance = new PseudoEmbedding();
      } else {
        instance = new OpenAIEmbedding();
        logger.info(`Using OpenAI embedding (${(instance as OpenAIEmbedding).dimensions} dims)`);
      }
      break;
    default:
      logger.warn(`Unknown EMBEDDING_BACKEND="${backend}", using pseudo`);
      instance = new PseudoEmbedding();
  }

  return instance;
}

/** Reset singleton (for testing) */
export function resetEmbeddingService(): void {
  instance = null;
}
