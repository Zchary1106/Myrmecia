/**
 * MemoryService — high-level facade over the unified MemoryStore.
 *
 * Provides the ergonomic operations the rest of the platform needs:
 *   - recall(...)            : scored retrieval
 *   - buildContextBlock(...) : token-budgeted, prompt-ready memory block
 *   - captureEpisode(...)    : record a task execution as episodic memory
 *   - remember(...)          : persist a semantic fact / preference / lesson
 *
 * Higher layers (write pipeline, reflection, graph) build on top of this.
 */

import { getMemoryStore, type SqliteMemoryStore } from './memory-store.js';
import { logger } from '../lib/logger.js';
import type {
  MemoryItem,
  MemoryQuery,
  MemoryScope,
  MemoryType,
  MemoryWriteInput,
  ScoredMemory,
} from './types.js';

export interface ContextBlockOptions {
  query: string;
  scope?: MemoryScope;
  types?: MemoryType[];
  topK?: number;
  /** Approx token budget for the rendered block. Default MEMORY_RECALL_TOKEN_BUDGET or 1500. */
  tokenBudget?: number;
  minScore?: number;
  heading?: string;
}

export interface CaptureEpisodeInput {
  input: string;
  output?: string;
  agentId: string;
  mode: string;
  workspaceId?: string;
  pipelineId?: string;
  success: boolean;
  quality: number;
}

/** Rough token estimate (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

function summarize(text: string, maxChars: number): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars - 1).trimEnd() + '…';
}

export class MemoryService {
  private store: SqliteMemoryStore;

  constructor(store?: SqliteMemoryStore) {
    this.store = store || getMemoryStore();
  }

  async recall(query: MemoryQuery): Promise<ScoredMemory[]> {
    try {
      return await this.store.recall(query);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'memory recall failed');
      return [];
    }
  }

  async add(input: MemoryWriteInput): Promise<MemoryItem | null> {
    try {
      return await this.store.add(input);
    } catch (err: any) {
      logger.warn({ err: err.message, type: input.type }, 'memory add failed');
      return null;
    }
  }

  /** Persist a semantic fact / preference / lesson. */
  async remember(
    content: string,
    opts: {
      type?: MemoryType;
      scope?: MemoryScope;
      importance?: number;
      summary?: string;
      sourceType?: string;
      sourceId?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<MemoryItem | null> {
    if (!content?.trim()) return null;
    return this.add({
      type: opts.type ?? 'semantic',
      content: content.trim(),
      summary: opts.summary,
      scope: opts.scope,
      importance: opts.importance ?? 0.5,
      sourceType: opts.sourceType ?? 'user',
      sourceId: opts.sourceId,
      metadata: opts.metadata,
    });
  }

  /** Record a task execution as episodic memory (workspace-scoped for cross-pipeline recall). */
  async captureEpisode(input: CaptureEpisodeInput): Promise<MemoryItem | null> {
    const outcome = input.output ? summarize(input.output, 600) : '';
    const content = outcome
      ? `Task: ${summarize(input.input, 400)}\nOutcome: ${outcome}`
      : `Task: ${summarize(input.input, 400)}`;

    return this.add({
      type: 'episodic',
      content,
      summary: outcome || undefined,
      scope: input.workspaceId ? { workspace: input.workspaceId } : {},
      importance: input.quality,
      success: input.success ? 1 : 0,
      quality: input.quality,
      sourceType: 'episode',
      metadata: {
        agentId: input.agentId,
        mode: input.mode,
        pipelineId: input.pipelineId ?? null,
        success: input.success,
      },
    });
  }

  /**
   * Recall memories and render them into a compact, prompt-ready markdown block
   * that fits within a token budget. Returns '' when nothing relevant is found.
   */
  async buildContextBlock(opts: ContextBlockOptions): Promise<string> {
    const budget = opts.tokenBudget ?? Number(process.env.MEMORY_RECALL_TOKEN_BUDGET ?? 1500);
    const results = await this.recall({
      query: opts.query,
      scope: opts.scope,
      types: opts.types,
      topK: opts.topK ?? 8,
      minScore: opts.minScore ?? 0.3,
    });
    if (results.length === 0) return '';

    const heading = opts.heading ?? '## Relevant Memory';
    const lines: string[] = [heading];
    let used = estimateTokens(heading);

    for (const { item, score } of results) {
      const text = item.summary || item.content;
      const label = labelFor(item);
      const line = `- ${label} ${summarize(text, 280)} _(score ${score.toFixed(2)})_`;
      const cost = estimateTokens(line);
      if (used + cost > budget) break;
      lines.push(line);
      used += cost;
    }

    return lines.length > 1 ? lines.join('\n') : '';
  }
}

function labelFor(item: MemoryItem): string {
  const tag = `[${item.type}]`;
  if (item.type === 'episodic') {
    const agent = (item.metadata as any)?.agentId;
    return agent ? `${tag}[${agent}]` : tag;
  }
  return tag;
}

// ---------- Singleton ----------

let service: MemoryService | null = null;

export function getMemoryService(): MemoryService {
  if (!service) service = new MemoryService();
  return service;
}

export function resetMemoryService(): void {
  service = null;
}
