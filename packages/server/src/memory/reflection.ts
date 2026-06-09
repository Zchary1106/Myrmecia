/**
 * Reflection (P4) — consolidate completed work into higher-level insights.
 *
 * After a pipeline finishes, summarise its stages, extract durable insights,
 * and persist a reusable *procedural* lesson (à la Generative Agents reflection
 * and Reflexion). These lessons feed future routing/decomposition via recall.
 */

import { getMemoryStore, type SqliteMemoryStore } from './memory-store.js';
import { getWritePipeline, extractFacts, type WritePipeline } from './write-pipeline.js';
import { logger } from '../lib/logger.js';
import type { Pipeline } from '../types.js';
import type { MemoryScope } from './types.js';

export interface ReflectionResult {
  reflectionId: string;
  summary: string;
  insights: string[];
  lessonId?: string;
}

function summarize(text: string, maxChars: number): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : clean.slice(0, maxChars - 1).trimEnd() + '…';
}

export class ReflectionService {
  private store: SqliteMemoryStore;
  private writePipeline: WritePipeline;

  constructor(store?: SqliteMemoryStore, writePipeline?: WritePipeline) {
    this.store = store || getMemoryStore();
    this.writePipeline = writePipeline || getWritePipeline();
  }

  /** Reflect on a completed pipeline: store a reflection + a procedural lesson. */
  async reflectOnPipeline(pipeline: Pipeline): Promise<ReflectionResult | null> {
    if (process.env.MEMORY_REFLECTION_ENABLED === 'false') return null;
    await this.store.initialize();

    const stages = pipeline.stages || [];
    const done = stages.filter(s => s.status === 'done');
    if (done.length === 0) return null;

    const scope: MemoryScope = pipeline.workspaceId ? { workspace: pipeline.workspaceId } : {};
    const combinedOutput = done.map(s => s.output || '').join('\n').trim();

    // 1. Insights: durable facts surfaced across the run.
    const insights = extractFacts(combinedOutput).slice(0, 5).map(f => f.content);

    // 2. Human-readable summary of the run.
    const route = stages.map(s => `${s.name}(${s.agentRole})`).join(' → ');
    const summary = [
      `Pipeline "${pipeline.name}" for: ${summarize(pipeline.input, 200)}`,
      `Route: ${route}`,
      `Completed ${done.length}/${stages.length} stages.`,
    ].join('\n');

    const reflectionId = this.store.addReflection({
      scope,
      summary,
      insights,
      sourceEpisodeIds: done.map(s => s.taskId).filter(Boolean) as string[],
    });

    // 3. Reusable procedural lesson — recallable when routing similar future work.
    const completion = stages.length > 0 ? done.length / stages.length : 0;
    const lesson = `For tasks like "${summarize(pipeline.input, 160)}", the route [${route}] worked (${done.length}/${stages.length} stages done).`;
    const lessonItem = await this.store.add({
      type: 'procedural',
      content: lesson,
      summary: lesson,
      scope,
      importance: 0.5 + 0.4 * completion,
      success: completion >= 0.99 ? 1 : completion,
      quality: completion,
      sourceType: 'reflection',
      sourceId: reflectionId,
      metadata: { pipelineId: pipeline.id, route, template: pipeline.templateId ?? null },
    });

    // 4. Persist insights as deduplicated semantic facts.
    if (insights.length > 0) {
      await this.writePipeline
        .ingestText(insights.join('\n'), { scope, sourceType: 'reflection' })
        .catch(() => undefined);
    }

    logger.info({ pipelineId: pipeline.id, insights: insights.length }, 'Reflection stored');
    return { reflectionId, summary, insights, lessonId: lessonItem?.id };
  }
}

// ---------- Singleton ----------

let service: ReflectionService | null = null;

export function getReflectionService(): ReflectionService {
  if (!service) service = new ReflectionService();
  return service;
}

export function resetReflectionService(): void {
  service = null;
}
