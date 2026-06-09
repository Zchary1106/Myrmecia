/**
 * Trajectory Store — Task Execution Learning (adapter over the unified MemoryStore)
 *
 * Historically this owned its own `task_trajectories` table + HNSW index. As of
 * the Phase 1 memory unification it delegates to {@link SqliteMemoryStore},
 * storing each execution as an `episodic` memory. The public API is unchanged so
 * existing callers (agent-runtime, intent-classifier) keep working.
 *
 * Semantic routing: "what agent/mode worked best for similar tasks?"
 */

import { getMemoryStore, type SqliteMemoryStore } from './memory-store.js';
import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';
import type { ScoreWeights } from './types.js';

// ---------- Types (stable public API) ----------

export interface TaskTrajectory {
  id: string;
  taskInput: string;
  embedding: number[];
  agentId: string;
  mode: string;
  templateId?: string;
  success: boolean;
  quality: number;        // 0-1
  durationMs: number;
  createdAt: string;
}

export interface RouteRecommendation {
  suggestedAgent: string;
  suggestedMode: string;
  suggestedTemplate?: string;
  confidence: number;
  basedOn: number;        // number of matching trajectories
}

export interface SimilarTrajectory {
  trajectory: TaskTrajectory;
  similarity: number;
}

const TRAJECTORY_SOURCE = 'task_trajectory';
// Pure-cosine weights so routing similarity matches the legacy behaviour.
const RELEVANCE_ONLY: ScoreWeights = { relevance: 1, recency: 0, importance: 0, success: 0 };

// ---------- TrajectoryStore ----------

export class TrajectoryStore {
  private store: SqliteMemoryStore;
  private initialized = false;

  constructor(store?: SqliteMemoryStore) {
    this.store = store || getMemoryStore();
  }

  /** Initialize the underlying memory store and migrate any legacy rows. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.initialize();
    await this.migrateLegacy();
    this.initialized = true;
  }

  /** Record a completed task trajectory as an episodic memory. */
  async record(data: {
    taskInput: string;
    agentId: string;
    mode: string;
    templateId?: string;
    success: boolean;
    quality: number;
    durationMs: number;
  }): Promise<void> {
    await this.initialize();

    await this.store.add({
      type: 'episodic',
      content: data.taskInput,
      importance: data.quality,
      success: data.success ? 1 : 0,
      quality: data.quality,
      sourceType: 'task',
      metadata: {
        agentId: data.agentId,
        mode: data.mode,
        templateId: data.templateId ?? null,
        durationMs: data.durationMs,
        success: data.success,
      },
    });
  }

  /** Find similar historical trajectories (ranked by cosine similarity). */
  async findSimilar(input: string, topK = 5): Promise<SimilarTrajectory[]> {
    await this.initialize();

    const results = await this.store.recall({
      query: input,
      types: ['episodic', 'procedural'],
      topK,
      weights: RELEVANCE_ONLY,
      mmrLambda: 1,
    });

    return results
      .map(({ item, relevance }) => {
        const meta = item.metadata as Record<string, any>;
        const agentId = (meta.agentId as string) || item.scope.agent || '';
        if (!agentId) return null;
        const trajectory: TaskTrajectory = {
          id: item.id,
          taskInput: item.content,
          embedding: item.embedding ?? [],
          agentId,
          mode: (meta.mode as string) || 'direct',
          templateId: (meta.templateId as string) || undefined,
          success: item.success != null ? item.success >= 0.5 : !!meta.success,
          quality: item.quality ?? item.importance,
          durationMs: (meta.durationMs as number) ?? 0,
          createdAt: item.createdAt,
        };
        return { trajectory, similarity: relevance };
      })
      .filter((x): x is SimilarTrajectory => x !== null)
      .sort((a, b) => b.similarity - a.similarity);
  }

  /** Recommend a route based on historical success. */
  async recommendRoute(input: string): Promise<RouteRecommendation | null> {
    const similar = await this.findSimilar(input, 5);

    const relevant = similar.filter(s => s.similarity >= 0.7);
    if (relevant.length === 0) return null;

    // Weighted voting: weight = similarity * quality, successes only.
    const votes = new Map<string, { weight: number; mode: string; templateId?: string }>();
    for (const { trajectory, similarity } of relevant) {
      if (!trajectory.success) continue;
      const weight = similarity * trajectory.quality;
      const existing = votes.get(trajectory.agentId);
      if (!existing || weight > existing.weight) {
        votes.set(trajectory.agentId, { weight, mode: trajectory.mode, templateId: trajectory.templateId });
      }
    }

    if (votes.size === 0) return null;

    let bestAgent = '';
    let bestWeight = 0;
    let bestMode = '';
    let bestTemplate: string | undefined;
    for (const [agent, vote] of votes) {
      if (vote.weight > bestWeight) {
        bestAgent = agent;
        bestWeight = vote.weight;
        bestMode = vote.mode;
        bestTemplate = vote.templateId;
      }
    }

    const avgQuality = relevant.reduce((s, r) => s + r.trajectory.quality, 0) / relevant.length;
    const confidence = relevant[0].similarity * avgQuality;

    return {
      suggestedAgent: bestAgent,
      suggestedMode: bestMode,
      suggestedTemplate: bestTemplate,
      confidence,
      basedOn: relevant.length,
    };
  }

  /** One-time copy of legacy `task_trajectories` rows into `memory_items`. */
  private async migrateLegacy(): Promise<void> {
    const db = getDb();
    const exists = db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_trajectories'"
    );
    if (!exists) return;

    const migrated = db.all(
      `SELECT source_id FROM memory_items WHERE source_type = ?`,
      TRAJECTORY_SOURCE
    ) as Array<{ source_id: string }>;
    const done = new Set(migrated.map(r => r.source_id));

    const rows = db.all('SELECT * FROM task_trajectories') as any[];
    const pending = rows.filter(r => !done.has(r.id));
    if (pending.length === 0) return;

    let count = 0;
    for (const row of pending) {
      try {
        const embedding = Array.from(
          new Float32Array(row.embedding.buffer || row.embedding)
        );
        await this.store.add({
          type: 'episodic',
          content: row.task_input,
          importance: row.quality ?? 0.5,
          success: row.success ? 1 : 0,
          quality: row.quality ?? 0.5,
          sourceType: TRAJECTORY_SOURCE,
          sourceId: row.id,
          embedding: embedding.length > 0 ? embedding : undefined,
          metadata: {
            agentId: row.agent_id,
            mode: row.mode,
            templateId: row.template_id ?? null,
            durationMs: row.duration_ms ?? 0,
            success: !!row.success,
          },
        });
        count++;
      } catch (err: any) {
        logger.warn({ err: err.message, id: row.id }, 'Skipped legacy trajectory during migration');
      }
    }

    if (count > 0) {
      this.store.persist();
      logger.info({ migrated: count }, 'Migrated legacy task_trajectories into memory_items');
    }
  }
}

// ---------- Singleton ----------

let store: TrajectoryStore | null = null;

export function getTrajectoryStore(): TrajectoryStore {
  if (!store) {
    store = new TrajectoryStore();
  }
  return store;
}

export function resetTrajectoryStore(): void {
  store = null;
}
