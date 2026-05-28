/**
 * Performance Benchmarks (#31)
 *
 * Self-contained benchmark script for measuring platform performance.
 * Run: tsx src/testing/benchmark.ts
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import { Router } from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Types ----------

export interface BenchmarkResult {
  name: string;
  opsPerSec: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  totalMs: number;
  iterations: number;
}

export interface BenchmarkReport {
  timestamp: string;
  results: BenchmarkResult[];
  summary: {
    totalDurationMs: number;
    scenarioCount: number;
  };
}

// ---------- Helpers ----------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(latencies: number[], totalMs: number, iterations: number): BenchmarkResult {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    name: '',
    opsPerSec: iterations / (totalMs / 1000),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    totalMs,
    iterations,
  };
}

// ---------- Benchmark Scenarios ----------

function createTempDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schemaPath = join(__dirname, '../db/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  return db;
}

function benchTaskCreation(db: Database.Database, iterations = 1000): BenchmarkResult {
  const stmt = db.prepare(
    `INSERT INTO tasks (id, title, description, mode, status, priority, input, created_at)
     VALUES (?, ?, ?, 'direct', 'pending', 'normal', '', datetime('now'))`
  );

  const latencies: number[] = [];
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    stmt.run(`bench_task_${i}`, `Benchmark task ${i}`, `Description for task ${i}`);
    latencies.push(performance.now() - t0);
  }

  const totalMs = performance.now() - start;
  const result = computeStats(latencies, totalMs, iterations);
  result.name = 'task_creation';
  return result;
}

function benchTaskListQuery(db: Database.Database, iterations = 500): BenchmarkResult {
  // Ensure some data exists
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tasks (id, title, description, mode, status, priority, input, created_at)
     VALUES (?, ?, ?, 'direct', 'pending', 'normal', '', datetime('now'))`
  );
  for (let i = 0; i < 100; i++) {
    insert.run(`list_task_${i}`, `Task ${i}`, `Desc ${i}`);
  }

  const query = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50');
  const latencies: number[] = [];
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    query.all();
    latencies.push(performance.now() - t0);
  }

  const totalMs = performance.now() - start;
  const result = computeStats(latencies, totalMs, iterations);
  result.name = 'task_list_query';
  return result;
}

function benchConcurrentOps(db: Database.Database, iterations = 500): BenchmarkResult {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO tasks (id, title, description, mode, status, priority, input, created_at)
     VALUES (?, ?, ?, 'direct', 'pending', 'normal', '', datetime('now'))`
  );
  const selectStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const updateStmt = db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?");

  const latencies: number[] = [];
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    const id = `conc_${i}`;
    const t0 = performance.now();
    // Simulate concurrent mixed operations
    insertStmt.run(id, `Concurrent task ${i}`, `Desc ${i}`);
    selectStmt.get(id);
    updateStmt.run(id);
    latencies.push(performance.now() - t0);
  }

  const totalMs = performance.now() - start;
  const result = computeStats(latencies, totalMs, iterations);
  result.name = 'concurrent_ops';
  return result;
}

function benchAgentCreation(db: Database.Database, iterations = 500): BenchmarkResult {
  const stmt = db.prepare(
    `INSERT INTO agents (id, name, role, config, capabilities, triggers, created_at, updated_at)
     VALUES (?, ?, ?, '{}', '[]', '[]', datetime('now'), datetime('now'))`
  );

  const latencies: number[] = [];
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    stmt.run(`bench_agent_${i}`, `Agent ${i}`, 'worker');
    latencies.push(performance.now() - t0);
  }

  const totalMs = performance.now() - start;
  const result = computeStats(latencies, totalMs, iterations);
  result.name = 'agent_creation';
  return result;
}

// ---------- Runner ----------

export async function runBenchmarks(): Promise<BenchmarkReport> {
  const overallStart = performance.now();
  const db = createTempDb();

  const results: BenchmarkResult[] = [
    benchTaskCreation(db),
    benchTaskListQuery(db),
    benchConcurrentOps(db),
    benchAgentCreation(db),
  ];

  db.close();
  const totalDurationMs = performance.now() - overallStart;

  return {
    timestamp: new Date().toISOString(),
    results,
    summary: {
      totalDurationMs: Math.round(totalDurationMs),
      scenarioCount: results.length,
    },
  };
}

// ---------- Routes ----------

export function createBenchmarkRoutes(): Router {
  const router = Router();

  router.get('/run', async (_req, res) => {
    try {
      const report = await runBenchmarks();
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  return router;
}

// ---------- CLI ----------

const isMainModule = process.argv[1]?.includes('benchmark');
if (isMainModule) {
  runBenchmarks().then(report => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }).catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
