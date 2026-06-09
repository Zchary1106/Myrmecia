/**
 * Memory Write Pipeline (P3) — extract → consolidate → score → persist.
 *
 * Turns raw text (task inputs/outputs) into durable semantic memories while
 * avoiding duplicates and merging near-identical facts, following the
 * ADD / UPDATE / DELETE / NOOP model popularised by Mem0.
 */

import { getMemoryStore, type SqliteMemoryStore } from './memory-store.js';
import { getGraphMemory } from './graph.js';
import { logger } from '../lib/logger.js';
import type { MemoryItem, MemoryScope, ScoreWeights } from './types.js';

export type ConsolidationAction = 'ADD' | 'UPDATE' | 'NOOP';

export interface FactCandidate {
  content: string;
  importance: number;
  kind: 'preference' | 'convention' | 'fact';
}

export interface IngestResult {
  added: number;
  updated: number;
  noop: number;
  items: MemoryItem[];
}

export interface IngestOptions {
  scope?: MemoryScope;
  sourceType?: string;
  sourceId?: string;
  maxCandidates?: number;
  /** Pluggable extractor (defaults to the rule-based one). */
  extractor?: (text: string) => FactCandidate[];
}

const RELEVANCE_ONLY: ScoreWeights = { relevance: 1, recency: 0, importance: 0, success: 0 };
const DUP_THRESHOLD = 0.95;     // >= → treat as the same fact
const SIMILAR_THRESHOLD = 0.82; // >= → candidate for merge/update

const PREF_EN = /\b(prefer|prefers|preferred|always|never|must|should|convention|standard|use|uses|using)\b/i;
const PREF_ZH = /(偏好|约定|统一|规范|必须|总是|应当|应该|默认使用|采用)/;
const FACT_VERB = /\b(is|are|was|were|uses|use|runs|requires|depends|supports|has|have|stores|handles|implements)\b/i;
const FACT_ZH = /(使用|采用|基于|依赖|支持|包含|负责|实现|运行在|存储在)/;

/** Rule-based fact/preference extraction. Deterministic and offline. */
export function extractFacts(text: string): FactCandidate[] {
  if (!text) return [];
  const segments = text
    .split(/\n+|(?<=[.!?。！？])\s+/)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const out: FactCandidate[] = [];

  for (const seg of segments) {
    if (seg.length < 15 || seg.length > 240) continue;
    const key = seg.toLowerCase();
    if (seen.has(key)) continue;

    const isPref = PREF_EN.test(seg) || PREF_ZH.test(seg);
    const isFact = FACT_VERB.test(seg) || FACT_ZH.test(seg);
    if (!isPref && !isFact) continue;

    // Skip obvious noise: code-fence markers, headings, list bullets without content.
    if (/^[#>*\-\d.`]+\s*$/.test(seg) || seg.startsWith('```')) continue;

    seen.add(key);
    out.push({
      content: seg,
      kind: isPref ? (PREF_ZH.test(seg) || /\b(prefer|always|never|must|should)\b/i.test(seg) ? 'preference' : 'convention') : 'fact',
      importance: isPref ? 0.7 : 0.5,
    });
  }

  return out;
}

export class WritePipeline {
  private store: SqliteMemoryStore;

  constructor(store?: SqliteMemoryStore) {
    this.store = store || getMemoryStore();
  }

  /** Decide ADD/UPDATE/NOOP for a single candidate against existing semantic memory. */
  async consolidateOne(candidate: FactCandidate, scope?: MemoryScope): Promise<{ action: ConsolidationAction; item: MemoryItem | null }> {
    const matches = await this.store.recall({
      query: candidate.content,
      types: ['semantic'],
      scope,
      topK: 3,
      weights: RELEVANCE_ONLY,
      mmrLambda: 1,
    });

    const best = matches[0];
    if (best && best.relevance >= DUP_THRESHOLD) {
      return { action: 'NOOP', item: best.item };
    }

    if (best && best.relevance >= SIMILAR_THRESHOLD) {
      // Merge: keep the more informative (longer) phrasing, bump importance.
      if (candidate.content.length > best.item.content.length) {
        const updated = await this.store.update(best.item.id, {
          content: candidate.content,
          importance: Math.max(best.item.importance, candidate.importance),
        });
        return { action: 'UPDATE', item: updated ?? best.item };
      }
      return { action: 'NOOP', item: best.item };
    }

    const item = await this.store.add({
      type: 'semantic',
      content: candidate.content,
      importance: candidate.importance,
      scope,
      sourceType: 'extracted',
      metadata: { kind: candidate.kind },
    });
    return { action: 'ADD', item };
  }

  /** Extract facts from text and persist them with deduplication. */
  async ingestText(text: string, opts: IngestOptions = {}): Promise<IngestResult> {
    const extractor = opts.extractor ?? extractFacts;
    const max = opts.maxCandidates ?? 5;
    const candidates = extractor(text).slice(0, max);

    const result: IngestResult = { added: 0, updated: 0, noop: 0, items: [] };
    for (const candidate of candidates) {
      try {
        const { action, item } = await this.consolidateOne(candidate, opts.scope);
        if (action === 'ADD') result.added++;
        else if (action === 'UPDATE') result.updated++;
        else result.noop++;
        if (item) result.items.push(item);
      } catch (err: any) {
        logger.warn({ err: err.message }, 'memory write-pipeline consolidate failed');
      }
    }

    // Build the entity/relation graph from the same text (best-effort).
    if (process.env.MEMORY_GRAPH_ENABLED !== 'false' && candidates.length > 0) {
      getGraphMemory().ingestText(text, opts.scope).catch(() => undefined);
    }

    return result;
  }

  /** Convenience: extract from a completed execution's input + output. */
  async ingestFromExecution(input: { input: string; output?: string; scope?: MemoryScope }): Promise<IngestResult> {
    if (process.env.MEMORY_EXTRACTION_ENABLED === 'false') {
      return { added: 0, updated: 0, noop: 0, items: [] };
    }
    const text = [input.input, input.output].filter(Boolean).join('\n');
    if (text.trim().length < 60) return { added: 0, updated: 0, noop: 0, items: [] };
    return this.ingestText(text, { scope: input.scope, sourceType: 'extracted', maxCandidates: 4 });
  }
}

// ---------- Singleton ----------

let pipeline: WritePipeline | null = null;

export function getWritePipeline(): WritePipeline {
  if (!pipeline) pipeline = new WritePipeline();
  return pipeline;
}

export function resetWritePipeline(): void {
  pipeline = null;
}
