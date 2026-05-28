/**
 * Token Usage Tracking & Budget Management
 *
 * Features:
 * - Per-workspace/agent/task token usage aggregation
 * - Budget thresholds with alerts and auto-actions
 * - Model downgrade on budget exhaustion
 * - Usage dashboard API
 *
 * Relies on existing model_usage_stats table for raw data.
 */

import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';
import { eventBus } from '../events/event-bus.js';
import { Router } from 'express';

// ---------- Types ----------

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  requestCount: number;
  period: string;
}

export interface BudgetConfig {
  workspaceId: string;
  monthlyLimitUSD: number;
  alertThresholdPercent: number;  // e.g., 80 = alert at 80% usage
  onExhausted: 'block' | 'downgrade' | 'alert_only';
}

export interface BudgetStatus {
  workspaceId: string;
  currentMonthUSD: number;
  limitUSD: number;
  percentUsed: number;
  isExhausted: boolean;
  action: BudgetConfig['onExhausted'];
}

// ---------- Schema ----------

export const BUDGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_budgets (
  workspace_id TEXT PRIMARY KEY,
  monthly_limit_usd REAL NOT NULL DEFAULT 100.0,
  alert_threshold_percent INTEGER NOT NULL DEFAULT 80,
  on_exhausted TEXT NOT NULL DEFAULT 'alert_only' CHECK(on_exhausted IN ('block','downgrade','alert_only')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// ---------- Usage Aggregation ----------

export function getUsageSummary(filter: {
  workspaceId?: string;
  agentId?: string;
  modelId?: string;
  since?: string;
  until?: string;
}): UsageSummary {
  const db = getDb();
  let sql = `SELECT
    COALESCE(SUM(input_tokens), 0) as total_input,
    COALESCE(SUM(output_tokens), 0) as total_output,
    COALESCE(SUM(cost_usd), 0) as total_cost,
    COUNT(*) as request_count
    FROM model_usage_stats WHERE 1=1`;
  const params: any[] = [];

  if (filter.agentId) { sql += ' AND agent_id = ?'; params.push(filter.agentId); }
  if (filter.modelId) { sql += ' AND model_id = ?'; params.push(filter.modelId); }
  if (filter.since) { sql += ' AND created_at >= ?'; params.push(filter.since); }
  if (filter.until) { sql += ' AND created_at < ?'; params.push(filter.until); }

  const row = db.get(sql, ...params) as any;
  return {
    totalInputTokens: row?.total_input || 0,
    totalOutputTokens: row?.total_output || 0,
    totalCostUSD: row?.total_cost || 0,
    requestCount: row?.request_count || 0,
    period: `${filter.since || 'all'} → ${filter.until || 'now'}`,
  };
}

export function getUsageByAgent(since?: string): Array<{ agentId: string; totalCostUSD: number; requestCount: number }> {
  const db = getDb();
  let sql = `SELECT agent_id, SUM(cost_usd) as total_cost, COUNT(*) as count FROM model_usage_stats`;
  const params: any[] = [];
  if (since) { sql += ' WHERE created_at >= ?'; params.push(since); }
  sql += ' GROUP BY agent_id ORDER BY total_cost DESC';
  return db.all(sql, ...params).map((row: any) => ({
    agentId: row.agent_id,
    totalCostUSD: row.total_cost,
    requestCount: row.count,
  }));
}

export function getUsageByModel(since?: string): Array<{ modelId: string; totalCostUSD: number; totalTokens: number }> {
  const db = getDb();
  let sql = `SELECT model_id, SUM(cost_usd) as total_cost, SUM(input_tokens + output_tokens) as total_tokens FROM model_usage_stats`;
  const params: any[] = [];
  if (since) { sql += ' WHERE created_at >= ?'; params.push(since); }
  sql += ' GROUP BY model_id ORDER BY total_cost DESC';
  return db.all(sql, ...params).map((row: any) => ({
    modelId: row.model_id,
    totalCostUSD: row.total_cost,
    totalTokens: row.total_tokens,
  }));
}

// ---------- Budget Management ----------

export function setBudget(config: BudgetConfig): void {
  const db = getDb();
  db.run(
    `INSERT INTO workspace_budgets (workspace_id, monthly_limit_usd, alert_threshold_percent, on_exhausted)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET monthly_limit_usd = ?, alert_threshold_percent = ?, on_exhausted = ?, updated_at = CURRENT_TIMESTAMP`,
    config.workspaceId, config.monthlyLimitUSD, config.alertThresholdPercent, config.onExhausted,
    config.monthlyLimitUSD, config.alertThresholdPercent, config.onExhausted
  );
}

export function getBudgetStatus(workspaceId: string): BudgetStatus {
  const db = getDb();
  const budget = db.get('SELECT * FROM workspace_budgets WHERE workspace_id = ?', workspaceId) as any;

  // Get current month's usage
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const usage = getUsageSummary({ since: monthStart.toISOString() });
  const limitUSD = budget?.monthly_limit_usd || 100;
  const percentUsed = (usage.totalCostUSD / limitUSD) * 100;

  return {
    workspaceId,
    currentMonthUSD: usage.totalCostUSD,
    limitUSD,
    percentUsed: Math.round(percentUsed * 100) / 100,
    isExhausted: percentUsed >= 100,
    action: budget?.on_exhausted || 'alert_only',
  };
}

/**
 * Check budget before executing an agent task.
 * Returns whether execution should proceed and any actions to take.
 */
export function checkBudgetForExecution(workspaceId: string): { allowed: boolean; reason?: string; downgrade?: boolean } {
  const status = getBudgetStatus(workspaceId);

  if (status.percentUsed >= status.percentUsed && status.percentUsed >= 80) {
    eventBus.emit('notification' as any, {
      type: 'budget_warning',
      title: 'Budget Alert',
      message: `Workspace ${workspaceId} has used ${status.percentUsed.toFixed(1)}% of monthly budget`,
    });
  }

  if (status.isExhausted) {
    switch (status.action) {
      case 'block':
        return { allowed: false, reason: `Monthly budget exhausted ($${status.currentMonthUSD.toFixed(2)} / $${status.limitUSD})` };
      case 'downgrade':
        logger.warn({ workspaceId }, 'Budget exhausted — downgrading model');
        return { allowed: true, downgrade: true };
      case 'alert_only':
      default:
        return { allowed: true };
    }
  }

  return { allowed: true };
}

// ---------- Routes ----------

export function createUsageRoutes(): Router {
  const router = Router();

  // GET /usage/summary — aggregated usage
  router.get('/summary', (req, res) => {
    const summary = getUsageSummary({
      agentId: req.query.agentId as string,
      modelId: req.query.modelId as string,
      since: req.query.since as string,
      until: req.query.until as string,
    });
    res.json(summary);
  });

  // GET /usage/by-agent — breakdown by agent
  router.get('/by-agent', (req, res) => {
    res.json(getUsageByAgent(req.query.since as string));
  });

  // GET /usage/by-model — breakdown by model
  router.get('/by-model', (req, res) => {
    res.json(getUsageByModel(req.query.since as string));
  });

  // GET /usage/budget — current budget status
  router.get('/budget', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || 'default';
    res.json(getBudgetStatus(workspaceId));
  });

  // PUT /usage/budget — set budget configuration
  router.put('/budget', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || 'default';
    const { monthlyLimitUSD, alertThresholdPercent, onExhausted } = req.body;
    setBudget({
      workspaceId,
      monthlyLimitUSD: monthlyLimitUSD || 100,
      alertThresholdPercent: alertThresholdPercent || 80,
      onExhausted: onExhausted || 'alert_only',
    });
    res.json(getBudgetStatus(workspaceId));
  });

  return router;
}
