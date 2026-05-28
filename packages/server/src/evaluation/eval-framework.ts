/**
 * Agent Evaluation & A/B Testing Framework (Task #15)
 *
 * Features:
 * - Create and run evaluation experiments
 * - LLM-as-Judge evaluator (stub)
 * - A/B experiment tracking with variant assignment
 * - Metric collection and result reporting
 */

import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';
import { Router } from 'express';
import { randomUUID } from 'crypto';

// ---------- Types ----------

export interface Experiment {
  id: string;
  name: string;
  description: string;
  variants: string[];
  trafficSplit: Record<string, number>; // variant → percentage
  status: 'draft' | 'running' | 'completed';
  createdAt: string;
}

export interface EvalRun {
  id: string;
  experimentId: string;
  variant: string;
  input: string;
  output: string;
  score: number | null;
  judgeReason: string | null;
  createdAt: string;
}

export interface EvalResult {
  experimentId: string;
  variant: string;
  avgScore: number;
  sampleCount: number;
}

// ---------- Schema ----------

export const EVAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS eval_experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  variants TEXT NOT NULL DEFAULT '["control","treatment"]',
  traffic_split TEXT NOT NULL DEFAULT '{"control":50,"treatment":50}',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  score REAL,
  judge_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (experiment_id) REFERENCES eval_experiments(id)
);
`;

// ---------- Service ----------

export class EvalFramework {
  constructor() {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    getDb().exec(EVAL_SCHEMA);
  }

  createExperiment(name: string, description: string, variants?: string[], trafficSplit?: Record<string, number>): Experiment {
    const id = randomUUID();
    const v = variants ?? ['control', 'treatment'];
    const split = trafficSplit ?? Object.fromEntries(v.map(vv => [vv, Math.floor(100 / v.length)]));
    const db = getDb();
    db.run(`
      INSERT INTO eval_experiments (id, name, description, variants, traffic_split)
      VALUES (?, ?, ?, ?, ?)
    `, id, name, description, JSON.stringify(v), JSON.stringify(split));
    logger.info({ id, name }, 'Experiment created');
    return { id, name, description, variants: v, trafficSplit: split, status: 'draft', createdAt: new Date().toISOString() };
  }

  assignVariant(experimentId: string): string {
    const db = getDb();
    const exp = db.get('SELECT variants, traffic_split FROM eval_experiments WHERE id = ?', experimentId) as { variants: string; traffic_split: string } | undefined;
    if (!exp) throw new Error(`Experiment ${experimentId} not found`);
    const split = JSON.parse(exp.traffic_split) as Record<string, number>;
    const rand = Math.random() * 100;
    let cumulative = 0;
    for (const [variant, pct] of Object.entries(split)) {
      cumulative += pct;
      if (rand <= cumulative) return variant;
    }
    return JSON.parse(exp.variants)[0];
  }

  async runEval(experimentId: string, variant: string, input: string, output: string): Promise<EvalRun> {
    const id = randomUUID();
    const { score, reason } = await this.llmJudge(input, output);
    const db = getDb();
    db.run(`
      INSERT INTO eval_runs (id, experiment_id, variant, input, output, score, judge_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, id, experimentId, variant, input, output, score, reason);
    return { id, experimentId, variant, input, output, score, judgeReason: reason, createdAt: new Date().toISOString() };
  }

  recordResult(experimentId: string, variant: string, input: string, output: string, score: number): void {
    const id = randomUUID();
    const db = getDb();
    db.run(`
      INSERT INTO eval_runs (id, experiment_id, variant, input, output, score)
      VALUES (?, ?, ?, ?, ?, ?)
    `, id, experimentId, variant, input, output, score);
  }

  getResults(experimentId: string): EvalResult[] {
    const db = getDb();
    const rows = db.all(`
      SELECT variant, AVG(score) as avg_score, COUNT(*) as sample_count
      FROM eval_runs WHERE experiment_id = ? AND score IS NOT NULL
      GROUP BY variant
    `, experimentId) as Array<{ variant: string; avg_score: number; sample_count: number }>;
    return rows.map(r => ({ experimentId, variant: r.variant, avgScore: r.avg_score, sampleCount: r.sample_count }));
  }

  // LLM-as-Judge stub
  private async llmJudge(input: string, output: string): Promise<{ score: number; reason: string }> {
    // In production, this calls an LLM to evaluate the output quality
    // Stub: score based on output length relative to input
    const ratio = output.length / Math.max(input.length, 1);
    const score = Math.min(1, Math.max(0, ratio / 5));
    return { score, reason: `Stub judge: output/input ratio = ${ratio.toFixed(2)}` };
  }
}

// ---------- Routes ----------

export function createEvalRoutes(): Router {
  const router = Router();
  const framework = new EvalFramework();

  router.post('/experiments', (req, res) => {
    const { name, description, variants, trafficSplit } = req.body;
    const exp = framework.createExperiment(name, description ?? '', variants, trafficSplit);
    res.status(201).json(exp);
  });

  router.get('/experiments/:id/results', (req, res) => {
    const results = framework.getResults(req.params.id);
    res.json({ experimentId: req.params.id, results });
  });

  router.post('/experiments/:id/run', async (req, res) => {
    const { input, output, variant } = req.body;
    const v = variant ?? framework.assignVariant(req.params.id);
    const run = await framework.runEval(req.params.id, v, input, output);
    res.status(201).json(run);
  });

  return router;
}
