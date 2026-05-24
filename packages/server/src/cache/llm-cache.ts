import { createHash } from 'crypto';

export interface CacheKey {
  model: string;
  system: string;
  prompt: string;
}

export interface CacheValue {
  output: string;
  inputTokens: number;
  outputTokens: number;
}

interface CacheEntry {
  value: CacheValue;
  expiresAt: number;
}

export interface LLMCacheOptions {
  maxSize: number;
  ttlMs: number;
}

export class LLMCache {
  private store = new Map<string, CacheEntry>();
  private maxSize: number;
  private ttlMs: number;
  private hitCount = 0;
  private missCount = 0;

  constructor(opts: LLMCacheOptions) {
    this.maxSize = opts.maxSize;
    this.ttlMs = opts.ttlMs;
  }

  private hash(key: CacheKey): string {
    const raw = `${key.model}\x00${key.system}\x00${key.prompt}`;
    return createHash('sha256').update(raw).digest('hex');
  }

  get(key: CacheKey): CacheValue | undefined {
    const h = this.hash(key);
    const entry = this.store.get(h);
    if (!entry) {
      this.missCount++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(h);
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    return entry.value;
  }

  set(key: CacheKey, value: CacheValue): void {
    const h = this.hash(key);
    if (this.store.size >= this.maxSize && !this.store.has(h)) {
      const firstKey = this.store.keys().next().value!;
      this.store.delete(firstKey);
    }
    this.store.set(h, { value, expiresAt: Date.now() + this.ttlMs });
  }

  stats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.hitCount + this.missCount;
    return {
      hits: this.hitCount,
      misses: this.missCount,
      size: this.store.size,
      hitRate: total > 0 ? this.hitCount / total : 0,
    };
  }

  clear(): void {
    this.store.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }
}

/** Singleton — configurable via env vars */
export const llmCache = new LLMCache({
  maxSize: Number(process.env.LLM_CACHE_MAX_SIZE) || 500,
  ttlMs: Number(process.env.LLM_CACHE_TTL_MS) || 300_000,
});
