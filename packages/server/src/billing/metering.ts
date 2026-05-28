/**
 * Billing Metering & Quota Management (Task #13)
 *
 * Features:
 * - Usage event recording
 * - Usage reports by workspace and period
 * - Quota checking with hard_limit and soft_limit modes
 */

import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';
import { Router } from 'express';

// ---------- Types ----------

export interface UsageEvent {
  workspaceId: string;
  resourceType: string;
  quantity: number;
  metadata?: Record<string, unknown>;
}

export interface UsageReport {
  workspaceId: string;
  period: string;
  breakdown: Array<{ resourceType: string; total: number; limit: number | null }>;
  totalCost: number;
}

export interface QuotaEntry {
  workspaceId: string;
  resourceType: string;
  limit: number;
  currentUsage: number;
  mode: 'hard_limit' | 'soft_limit';
}

export interface QuotaCheckResult {
  allowed: boolean;
  remaining: number;
  mode: 'hard_limit' | 'soft_limit';
  percentUsed: number;
}

// ---------- Schema ----------

export const QUOTA_SCHEMA = `
CREATE TABLE IF NOT EXISTS quotas (
  workspace_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  "limit" INTEGER NOT NULL DEFAULT 1000,
  current_usage INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'soft_limit',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, resource_type)
);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  metadata TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// ---------- Service ----------

export class MeteringService {
  constructor() {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const db = getDb();
    db.exec(QUOTA_SCHEMA);
  }

  recordUsage(event: UsageEvent): void {
    const db = getDb();
    db.run(`
      INSERT INTO usage_events (workspace_id, resource_type, quantity, metadata)
      VALUES (?, ?, ?, ?)
    `, event.workspaceId, event.resourceType, event.quantity, JSON.stringify(event.metadata ?? {}));

    db.run(`
      INSERT INTO quotas (workspace_id, resource_type, current_usage, "limit", mode)
      VALUES (?, ?, ?, 1000, 'soft_limit')
      ON CONFLICT(workspace_id, resource_type) DO UPDATE SET
        current_usage = current_usage + ?,
        updated_at = datetime('now')
    `, event.workspaceId, event.resourceType, event.quantity, event.quantity);

    logger.debug({ event }, 'Usage event recorded');
  }

  getUsageReport(workspaceId: string, period: string): UsageReport {
    const db = getDb();
    const rows = db.all(`
      SELECT resource_type, SUM(quantity) as total
      FROM usage_events
      WHERE workspace_id = ? AND recorded_at >= ?
      GROUP BY resource_type
    `, workspaceId, period) as Array<{ resource_type: string; total: number }>;

    const quotas = db.all(`
      SELECT resource_type, "limit" FROM quotas WHERE workspace_id = ?
    `, workspaceId) as Array<{ resource_type: string; limit: number }>;

    const limitMap = new Map(quotas.map(q => [q.resource_type, q.limit]));

    return {
      workspaceId,
      period,
      breakdown: rows.map(r => ({
        resourceType: r.resource_type,
        total: r.total,
        limit: limitMap.get(r.resource_type) ?? null,
      })),
      totalCost: rows.reduce((sum, r) => sum + r.total * 0.001, 0),
    };
  }

  checkQuota(workspaceId: string, resourceType?: string): QuotaCheckResult {
    const db = getDb();
    const row = db.get(`
      SELECT "limit", current_usage, mode FROM quotas
      WHERE workspace_id = ? AND resource_type = ?
    `, workspaceId, resourceType ?? 'default') as { limit: number; current_usage: number; mode: string } | undefined;

    if (!row) {
      return { allowed: true, remaining: 1000, mode: 'soft_limit', percentUsed: 0 };
    }

    const remaining = row.limit - row.current_usage;
    const percentUsed = (row.current_usage / row.limit) * 100;
    const mode = row.mode as 'hard_limit' | 'soft_limit';
    const allowed = mode === 'soft_limit' || remaining > 0;

    return { allowed, remaining: Math.max(0, remaining), mode, percentUsed };
  }
}

// ---------- Routes ----------

export function createBillingRoutes(): Router {
  const router = Router();
  const metering = new MeteringService();

  router.get('/report', (req, res) => {
    const workspaceId = (req.headers['x-workspace-id'] as string) || 'default';
    const period = (req.query.period as string) || new Date().toISOString().slice(0, 10);
    const report = metering.getUsageReport(workspaceId, period);
    res.json(report);
  });

  router.get('/quota', (req, res) => {
    const workspaceId = (req.headers['x-workspace-id'] as string) || 'default';
    const resourceType = req.query.resource_type as string | undefined;
    const result = metering.checkQuota(workspaceId, resourceType);
    res.json(result);
  });

  router.put('/quota', (req, res) => {
    const { workspaceId, resourceType, limit, mode } = req.body as {
      workspaceId: string; resourceType: string; limit: number; mode: 'hard_limit' | 'soft_limit';
    };
    const db = getDb();
    db.run(`
      INSERT INTO quotas (workspace_id, resource_type, "limit", mode, current_usage)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(workspace_id, resource_type) DO UPDATE SET
        "limit" = ?, mode = ?, updated_at = datetime('now')
    `, workspaceId, resourceType, limit, mode, limit, mode);
    res.json({ ok: true });
  });

  return router;
}
