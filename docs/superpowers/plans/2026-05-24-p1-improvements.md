# P1 Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pipeline loop stages (repeat-until-pass) and LLM response caching to reduce cost and enable iterative quality workflows.

**Architecture:** Loop stages add a `maxIterations` + `exitCondition` to pipeline stage definitions. LLM cache uses an in-memory LRU keyed by hash(model + prompt + system) with optional Redis backend.

**Tech Stack:** TypeScript, crypto (sha256), LRU cache, pipeline engine extension

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/server/src/pipelines/loop-stage.ts` | Loop stage logic: evaluate exit condition, track iterations |
| `packages/server/src/pipelines/loop-stage.test.ts` | Tests for loop stage |
| `packages/server/src/pipelines/pipeline-engine.ts` | Wire loop support into stage advancement |
| `packages/server/src/cache/llm-cache.ts` | LRU cache for LLM responses with hash-based keys |
| `packages/server/src/cache/llm-cache.test.ts` | Tests for cache |
| `packages/server/src/agents/agent-runtime.ts` | Integrate cache lookup before LLM call |
| `packages/shared/src/types.ts` or `packages/server/src/types.ts` | Extended PipelineStage type |
| `templates/feature-with-qa-loop.yaml` | Example template using loop stage |

---

### Task 1: LLM Response Cache

**Files:**
- Create: `packages/server/src/cache/llm-cache.ts`
- Create: `packages/server/src/cache/llm-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/cache/llm-cache.test.ts`:

```typescript
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
    // First entry should be evicted
    expect(small.get({ model: 'm', system: 's', prompt: '1' })).toBeUndefined();
    expect(small.get({ model: 'm', system: 's', prompt: '3' })).toEqual({ output: 'c', inputTokens: 1, outputTokens: 1 });
  });

  it('expires entries after TTL', () => {
    const shortTtl = new LLMCache({ maxSize: 100, ttlMs: 1 });
    shortTtl.set({ model: 'm', system: 's', prompt: 'x' }, { output: 'y', inputTokens: 1, outputTokens: 1 });
    // Wait for expiry
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && npx vitest run src/cache/llm-cache.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement llm-cache.ts**

Create `packages/server/src/cache/llm-cache.ts`:

```typescript
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
    // Evict oldest if at capacity
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

// Singleton instance — 5 min TTL, 500 entries max
export const llmCache = new LLMCache({
  maxSize: Number(process.env.LLM_CACHE_MAX_SIZE) || 500,
  ttlMs: Number(process.env.LLM_CACHE_TTL_MS) || 300_000,
});
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/server && npx vitest run src/cache/llm-cache.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cache/llm-cache.ts packages/server/src/cache/llm-cache.test.ts
git commit -m "feat(cache): add LLM response cache with LRU eviction and TTL

Exact-match cache keyed by sha256(model + system + prompt).
Configurable via LLM_CACHE_MAX_SIZE and LLM_CACHE_TTL_MS env vars.
Reports hit/miss stats for observability. 6/6 tests passing."
```

---

### Task 2: Pipeline Loop Stage

**Files:**
- Create: `packages/server/src/pipelines/loop-stage.ts`
- Create: `packages/server/src/pipelines/loop-stage.test.ts`
- Modify: `packages/server/src/types.ts` (extend PipelineStage)
- Create: `templates/feature-with-qa-loop.yaml`

- [ ] **Step 1: Check and extend PipelineStage type**

In `packages/server/src/types.ts`, find the PipelineStage interface and add loop fields:

```typescript
// Add to existing PipelineStage interface:
  loop?: {
    maxIterations: number;
    exitCondition: 'pass' | 'approve' | 'custom';
    exitPattern?: string; // regex pattern to match in output for 'custom'
    currentIteration?: number;
  };
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/pipelines/loop-stage.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shouldLoopContinue, type LoopConfig } from './loop-stage.js';

describe('shouldLoopContinue', () => {
  const baseLoop: LoopConfig = { maxIterations: 3, exitCondition: 'pass', currentIteration: 0 };

  it('continues when output does not indicate pass', () => {
    const result = shouldLoopContinue(baseLoop, 'FAIL: 2 tests failed');
    expect(result.continue).toBe(true);
    expect(result.nextIteration).toBe(1);
  });

  it('stops when output indicates pass', () => {
    const result = shouldLoopContinue(baseLoop, 'All tests passed. PASS');
    expect(result.continue).toBe(false);
  });

  it('stops when maxIterations reached', () => {
    const exhausted = { ...baseLoop, currentIteration: 3 };
    const result = shouldLoopContinue(exhausted, 'FAIL: still broken');
    expect(result.continue).toBe(false);
    expect(result.reason).toBe('max_iterations');
  });

  it('supports custom regex exit condition', () => {
    const custom: LoopConfig = { maxIterations: 5, exitCondition: 'custom', exitPattern: 'LGTM|approved', currentIteration: 0 };
    expect(shouldLoopContinue(custom, 'Changes look good. LGTM').continue).toBe(false);
    expect(shouldLoopContinue(custom, 'Needs more work').continue).toBe(true);
  });

  it('approve condition looks for approval keywords', () => {
    const approve: LoopConfig = { maxIterations: 3, exitCondition: 'approve', currentIteration: 0 };
    expect(shouldLoopContinue(approve, 'Approved. Ship it.').continue).toBe(false);
    expect(shouldLoopContinue(approve, 'Rejected. Fix the auth logic.').continue).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/server && npx vitest run src/pipelines/loop-stage.test.ts
```

- [ ] **Step 4: Implement loop-stage.ts**

Create `packages/server/src/pipelines/loop-stage.ts`:

```typescript
export interface LoopConfig {
  maxIterations: number;
  exitCondition: 'pass' | 'approve' | 'custom';
  exitPattern?: string;
  currentIteration: number;
}

export interface LoopResult {
  continue: boolean;
  nextIteration: number;
  reason?: 'exit_condition_met' | 'max_iterations';
}

const PASS_PATTERNS = /\b(pass(ed)?|success(ful)?|all\s+tests?\s+pass(ed)?)\b/i;
const APPROVE_PATTERNS = /\b(approved?|lgtm|ship\s+it|looks?\s+good)\b/i;

/**
 * Evaluate whether a loop stage should continue iterating.
 */
export function shouldLoopContinue(loop: LoopConfig, stageOutput: string): LoopResult {
  // Check max iterations first
  if (loop.currentIteration >= loop.maxIterations) {
    return { continue: false, nextIteration: loop.currentIteration, reason: 'max_iterations' };
  }

  // Check exit condition against output
  let conditionMet = false;

  switch (loop.exitCondition) {
    case 'pass':
      conditionMet = PASS_PATTERNS.test(stageOutput);
      break;
    case 'approve':
      conditionMet = APPROVE_PATTERNS.test(stageOutput);
      break;
    case 'custom':
      if (loop.exitPattern) {
        conditionMet = new RegExp(loop.exitPattern, 'i').test(stageOutput);
      }
      break;
  }

  if (conditionMet) {
    return { continue: false, nextIteration: loop.currentIteration, reason: 'exit_condition_met' };
  }

  return { continue: true, nextIteration: loop.currentIteration + 1 };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/server && npx vitest run src/pipelines/loop-stage.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 6: Add example template**

Create `templates/feature-with-qa-loop.yaml`:

```yaml
name: Feature with QA Loop
description: Feature development with iterative QA — loops until tests pass (max 3 attempts)
stages:
  - name: Spec
    role: pm
    prompt_template: |
      Write a brief feature spec for: {input}

  - name: Code
    role: dev
    prompt_template: |
      Implement this feature based on the spec:
      {input}

  - name: QA Loop
    role: qa
    prompt_template: |
      Test this implementation. If all tests pass, output "All tests passed. PASS".
      If tests fail, output the failures and suggest fixes.
      {input}
    loop:
      max_iterations: 3
      exit_condition: pass

  - name: Review
    role: review
    prompt_template: |
      Review the final implementation for quality and security:
      {input}
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/pipelines/loop-stage.ts packages/server/src/pipelines/loop-stage.test.ts templates/feature-with-qa-loop.yaml
git commit -m "feat(pipelines): add loop stage support for iterative workflows

Stages can now define a loop config with maxIterations and exit condition.
Supports 'pass', 'approve', and custom regex exit conditions.
Includes example template: feature-with-qa-loop. 5/5 tests passing."
```

---

## Summary

| Task | Time Estimate | Impact |
|------|:---:|--------|
| 1. LLM Cache | 10 min | Cost reduction on repeated prompts |
| 2. Pipeline Loop Stage | 15 min | Enables iterative QA workflows |

Total: ~25 minutes.
