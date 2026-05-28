/**
 * Trajectory Store — Task Execution Learning System
 *
 * Records every task execution as a trajectory (input + agent + outcome),
 * embeds task inputs into vectors, stores in HNSW for fast similarity search.
 * Enables semantic routing: "what agent/mode worked best for similar tasks?"
 */

import { v4 as uuid } from 'uuid';
import { HNSWIndex } from './hnsw.js';
import { getEmbeddingService, type EmbeddingService } from './embedding.js';
import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';

// ---------- Types ----------

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

// ---------- Schema ----------

export const TRAJECTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_trajectories (
  id TEXT PRIMARY KEY,
  task_input TEXT NOT NULL,
  embedding BLOB NOT NULL,
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  template_id TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  quality REAL NOT NULL DEFAULT 0.5,
  duration_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trajectories_agent ON task_trajectories(agent_id);
CREATE INDEX IF NOT EXISTS idx_trajectories_mode ON task_trajectories(mode);

CREATE TABLE IF NOT EXISTS hnsw_indexes (
  name TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// ---------- TrajectoryStore ----------

export class TrajectoryStore {
  private index: HNSWIndex | null = null;
  private embedding: EmbeddingService;
  private initialized = false;

  constructor(embeddingService?: EmbeddingService) {
    this.embedding = embeddingService || getEmbeddingService();
  }

  /** Initialize: create tables and load HNSW from SQLite */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = getDb();
    db.exec(TRAJECTORY_SCHEMA);

    // Try loading persisted HNSW index
    const saved = db.get(
      'SELECT data, dimensions FROM hnsw_indexes WHERE name = ?',
      'trajectories'
    ) as { data: Buffer; dimensions: number } | undefined;

    if (saved && saved.dimensions === this.embedding.dimensions) {
      try {
        this.index = HNSWIndex.deserialize(saved.data);
        logger.info({ entries: this.index.size() }, 'Loaded HNSW index from SQLite');
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Failed to deserialize HNSW, rebuilding');
        this.index = null;
      }
    }

    if (!this.index) {
      this.index = new HNSWIndex({ dimensions: this.embedding.dimensions });
      // Rebuild from stored trajectories
      await this.rebuildIndex();
    }

    this.initialized = true;
  }

  /** Record a completed task trajectory */
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

    const id = `traj_${uuid().slice(0, 12)}`;
    const embedding = await this.embedding.embed(data.taskInput);

    const db = getDb();
    db.run(
      `INSERT INTO task_trajectories (id, task_input, embedding, agent_id, mode, template_id, success, quality, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, data.taskInput, Buffer.from(new Float32Array(embedding).buffer),
      data.agentId, data.mode, data.templateId || null,
      data.success ? 1 : 0, data.quality, data.durationMs
    );

    // Add to HNSW
    this.index!.add(id, embedding);

    // Persist HNSW periodically (every 10 additions)
    if (this.index!.size() % 10 === 0) {
      this.persistIndex();
    }
  }

  /** Find similar historical trajectories */
  async findSimilar(input: string, topK = 5): Promise<SimilarTrajectory[]> {
    await this.initialize();

    if (this.index!.size() === 0) return [];

    const queryEmbedding = await this.embedding.embed(input);
    const results = this.index!.search(queryEmbedding, topK);

    const db = getDb();
    const trajectories: SimilarTrajectory[] = [];

    for (const result of results) {
      const row = db.get('SELECT * FROM task_trajectories WHERE id = ?', result.id) as any;
      if (!row) continue;

      const similarity = 1 - result.distance; // cosine distance → similarity
      trajectories.push({
        trajectory: {
          id: row.id,
          taskInput: row.task_input,
          embedding: Array.from(new Float32Array(row.embedding.buffer || row.embedding)),
          agentId: row.agent_id,
          mode: row.mode,
          templateId: row.template_id || undefined,
          success: !!row.success,
          quality: row.quality,
          durationMs: row.duration_ms,
          createdAt: row.created_at,
        },
        similarity,
      });
    }

    return trajectories;
  }

  /** Recommend a route based on historical success */
  async recommendRoute(input: string): Promise<RouteRecommendation | null> {
    const similar = await this.findSimilar(input, 5);

    // Filter by minimum similarity threshold
    const relevant = similar.filter(s => s.similarity >= 0.7);
    if (relevant.length === 0) return null;

    // Weighted voting: weight = similarity * quality
    const votes = new Map<string, { weight: number; mode: string; templateId?: string }>();

    for (const { trajectory, similarity } of relevant) {
      if (!trajectory.success) continue; // Only learn from successes

      const key = trajectory.agentId;
      const weight = similarity * trajectory.quality;
      const existing = votes.get(key);

      if (!existing || weight > existing.weight) {
        votes.set(key, { weight, mode: trajectory.mode, templateId: trajectory.templateId });
      }
    }

    if (votes.size === 0) return null;

    // Pick highest weighted vote
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

    // Confidence = highest similarity * average quality of relevant results
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

  /** Persist HNSW index to SQLite */
  persistIndex(): void {
    if (!this.index) return;

    const db = getDb();
    const data = this.index.serialize();

    db.run(
      `INSERT INTO hnsw_indexes (name, data, dimensions, entry_count, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(name) DO UPDATE SET data = ?, dimensions = ?, entry_count = ?, updated_at = CURRENT_TIMESTAMP`,
      'trajectories', data, this.embedding.dimensions, this.index.size(),
      data, this.embedding.dimensions, this.index.size()
    );
  }

  /** Rebuild HNSW from all stored trajectories */
  private async rebuildIndex(): Promise<void> {
    const db = getDb();
    const rows = db.all('SELECT id, embedding FROM task_trajectories') as any[];

    this.index = new HNSWIndex({ dimensions: this.embedding.dimensions });

    for (const row of rows) {
      try {
        const embedding = Array.from(new Float32Array(
          row.embedding.buffer || row.embedding
        ));
        if (embedding.length === this.embedding.dimensions) {
          this.index.add(row.id, embedding);
        }
      } catch {
        // Skip corrupted entries
      }
    }

    if (rows.length > 0) {
      logger.info({ rebuilt: this.index.size() }, 'Rebuilt HNSW index from trajectories');
      this.persistIndex();
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
