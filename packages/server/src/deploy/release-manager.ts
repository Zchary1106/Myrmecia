/**
 * Release Manager — Canary Releases & Multi-Environment (Task #17)
 *
 * Features:
 * - Create, promote, and rollback releases
 * - Feature flag support with percentage-based rollout
 * - Environment configuration management
 */

import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

// ---------- Types ----------

export interface Release {
  id: string;
  version: string;
  environment: string;
  status: 'pending' | 'canary' | 'promoted' | 'rolled_back';
  createdAt: string;
  promotedAt: string | null;
}

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  rolloutPercent: number;
  environments: string[];
}

export interface EnvConfig {
  name: string;
  variables: Record<string, string>;
}

// ---------- Schema ----------

export const RELEASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'staging',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  promoted_at TEXT
);

CREATE TABLE IF NOT EXISTS feature_flags (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  rollout_percent INTEGER NOT NULL DEFAULT 100,
  environments TEXT NOT NULL DEFAULT '["production","staging"]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// ---------- Service ----------

export class ReleaseManager {
  constructor() {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    getDb().exec(RELEASE_SCHEMA);
  }

  createRelease(version: string, environment = 'staging'): Release {
    const id = randomUUID();
    const db = getDb();
    db.run(`INSERT INTO releases (id, version, environment) VALUES (?, ?, ?)`, id, version, environment);
    logger.info({ id, version, environment }, 'Release created');
    return { id, version, environment, status: 'pending', createdAt: new Date().toISOString(), promotedAt: null };
  }

  promote(releaseId: string, targetEnv = 'production'): Release {
    const db = getDb();
    db.run(`UPDATE releases SET status = 'promoted', environment = ?, promoted_at = datetime('now') WHERE id = ?`, targetEnv, releaseId);
    const row = db.get('SELECT * FROM releases WHERE id = ?', releaseId) as any;
    logger.info({ releaseId, targetEnv }, 'Release promoted');
    return { id: row.id, version: row.version, environment: row.environment, status: row.status, createdAt: row.created_at, promotedAt: row.promoted_at };
  }

  rollback(releaseId: string): void {
    const db = getDb();
    db.run(`UPDATE releases SET status = 'rolled_back' WHERE id = ?`, releaseId);
    logger.info({ releaseId }, 'Release rolled back');
  }

  listReleases(environment?: string): Release[] {
    const db = getDb();
    const query = environment
      ? db.all('SELECT * FROM releases WHERE environment = ? ORDER BY created_at DESC', environment)
      : db.all('SELECT * FROM releases ORDER BY created_at DESC');
    return (query as any[]).map(r => ({
      id: r.id, version: r.version, environment: r.environment,
      status: r.status, createdAt: r.created_at, promotedAt: r.promoted_at,
    }));
  }

  // Feature Flags

  isEnabled(flag: string, context?: { userId?: string; environment?: string }): boolean {
    const db = getDb();
    const row = db.get('SELECT enabled, rollout_percent, environments FROM feature_flags WHERE name = ?', flag) as { enabled: number; rollout_percent: number; environments: string } | undefined;
    if (!row || !row.enabled) return false;

    if (context?.environment) {
      const envs = JSON.parse(row.environments) as string[];
      if (!envs.includes(context.environment)) return false;
    }

    if (row.rollout_percent >= 100) return true;
    if (row.rollout_percent <= 0) return false;

    // Deterministic percentage based on userId
    const key = context?.userId ?? 'anonymous';
    const hash = createHash('md5').update(`${flag}:${key}`).digest();
    const bucket = hash.readUInt16BE(0) % 100;
    return bucket < row.rollout_percent;
  }

  // Environment Config

  getEnvConfig(env: string): EnvConfig {
    // In production, this would pull from a config store
    const defaults: Record<string, Record<string, string>> = {
      production: { LOG_LEVEL: 'info', NODE_ENV: 'production' },
      staging: { LOG_LEVEL: 'debug', NODE_ENV: 'staging' },
      development: { LOG_LEVEL: 'trace', NODE_ENV: 'development' },
    };
    return { name: env, variables: defaults[env] ?? defaults.development };
  }
}

// ---------- Routes ----------

export function createReleaseRoutes(): Router {
  const router = Router();
  const manager = new ReleaseManager();

  router.get('/', (req, res) => {
    const env = req.query.environment as string | undefined;
    res.json(manager.listReleases(env));
  });

  router.post('/', (req, res) => {
    const { version, environment } = req.body;
    const release = manager.createRelease(version, environment);
    res.status(201).json(release);
  });

  router.post('/:id/promote', (req, res) => {
    const { environment } = req.body ?? {};
    const release = manager.promote(req.params.id, environment);
    res.json(release);
  });

  router.post('/:id/rollback', (req, res) => {
    manager.rollback(req.params.id);
    res.json({ ok: true });
  });

  router.get('/flags/:name', (req, res) => {
    const context = { userId: req.query.userId as string, environment: req.query.env as string };
    res.json({ flag: req.params.name, enabled: manager.isEnabled(req.params.name, context) });
  });

  return router;
}
