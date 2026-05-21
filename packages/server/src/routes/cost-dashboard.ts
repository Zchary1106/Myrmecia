import { Router } from 'express';
import { getDb } from '../db/database.js';
import { getAgent } from '../db/models/agent.js';

function periodToDateTrunc(period: string): string {
  switch (period) {
    case 'day': return "strftime('%Y-%m-%d', created_at)";
    case 'week': return "strftime('%Y-W%W', created_at)";
    case 'month': return "strftime('%Y-%m', created_at)";
    default: return "strftime('%Y-%m-%d', created_at)";
  }
}

function sinceDefault(period: string): string {
  const now = new Date();
  switch (period) {
    case 'day': return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    case 'week': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case 'month': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    default: return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}

export function buildSummaryQuery(opts: { period: string; since?: string; until?: string }) {
  const dateTrunc = periodToDateTrunc(opts.period);
  const since = opts.since || sinceDefault(opts.period);
  const until = opts.until || new Date().toISOString();
  const sql = `
    SELECT ${dateTrunc} as date,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd,
      COUNT(*) as request_count
    FROM model_usage_stats
    WHERE created_at >= ? AND created_at < ?
    GROUP BY date ORDER BY date ASC
  `;
  return { sql, params: [since, until] };
}

export function buildByAgentQuery(opts: { period: string; since?: string; until?: string }) {
  const dateTrunc = periodToDateTrunc(opts.period);
  const since = opts.since || sinceDefault(opts.period);
  const until = opts.until || new Date().toISOString();
  const sql = `
    SELECT agent_id, ${dateTrunc} as date,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM model_usage_stats
    WHERE created_at >= ? AND created_at < ?
    GROUP BY agent_id, date ORDER BY agent_id, date ASC
  `;
  return { sql, params: [since, until] };
}

export function buildByModelQuery(opts: { period: string; since?: string; until?: string }) {
  const dateTrunc = periodToDateTrunc(opts.period);
  const since = opts.since || sinceDefault(opts.period);
  const until = opts.until || new Date().toISOString();
  const sql = `
    SELECT model_id, ${dateTrunc} as date,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM model_usage_stats
    WHERE created_at >= ? AND created_at < ?
    GROUP BY model_id, date ORDER BY model_id, date ASC
  `;
  return { sql, params: [since, until] };
}

export function createCostDashboardRoutes(): Router {
  const router = Router();

  router.get('/summary', (req, res) => {
    const period = (req.query.period as string) || 'day';
    const { sql, params } = buildSummaryQuery({ period, since: req.query.since as string, until: req.query.until as string });
    const db = getDb();
    const rows = db.all(sql, ...params);
    const totals = rows.reduce((acc, r: any) => ({
      totalInputTokens: acc.totalInputTokens + r.input_tokens,
      totalOutputTokens: acc.totalOutputTokens + r.output_tokens,
      totalCostUSD: acc.totalCostUSD + r.cost_usd,
      requestCount: acc.requestCount + r.request_count,
    }), { totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, requestCount: 0 });
    res.json({ period, ...totals, dataPoints: rows.map((r: any) => ({ date: r.date, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUSD: r.cost_usd, requestCount: r.request_count })) });
  });

  router.get('/by-agent', (req, res) => {
    const period = (req.query.period as string) || 'day';
    const { sql, params } = buildByAgentQuery({ period, since: req.query.since as string, until: req.query.until as string });
    const db = getDb();
    const rows = db.all(sql, ...params) as any[];
    const agentMap = new Map<string, { dataPoints: any[]; totalCostUSD: number }>();
    for (const r of rows) {
      if (!agentMap.has(r.agent_id)) agentMap.set(r.agent_id, { dataPoints: [], totalCostUSD: 0 });
      const entry = agentMap.get(r.agent_id)!;
      entry.dataPoints.push({ date: r.date, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUSD: r.cost_usd });
      entry.totalCostUSD += r.cost_usd;
    }
    const agents = Array.from(agentMap.entries()).map(([agentId, data]) => {
      const agent = getAgent(agentId);
      return { agentId, agentName: agent?.name || agentId, ...data };
    });
    res.json({ agents });
  });

  router.get('/by-task', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const db = getDb();
    const rows = db.all(`
      SELECT m.task_id, t.title, m.agent_id,
        COALESCE(SUM(m.input_tokens), 0) as input_tokens,
        COALESCE(SUM(m.output_tokens), 0) as output_tokens,
        COALESCE(SUM(m.cost_usd), 0) as cost_usd,
        MAX(m.created_at) as completed_at
      FROM model_usage_stats m
      LEFT JOIN tasks t ON t.id = m.task_id
      WHERE m.task_id IS NOT NULL
      GROUP BY m.task_id ORDER BY completed_at DESC LIMIT ?
    `, limit) as any[];
    res.json({ tasks: rows.map(r => ({ taskId: r.task_id, title: r.title || r.task_id, agentId: r.agent_id, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUSD: r.cost_usd, completedAt: r.completed_at })) });
  });

  router.get('/by-model', (req, res) => {
    const period = (req.query.period as string) || 'day';
    const { sql, params } = buildByModelQuery({ period, since: req.query.since as string, until: req.query.until as string });
    const db = getDb();
    const rows = db.all(sql, ...params) as any[];
    const modelMap = new Map<string, { dataPoints: any[]; totalCostUSD: number }>();
    let grandTotal = 0;
    for (const r of rows) {
      if (!modelMap.has(r.model_id)) modelMap.set(r.model_id, { dataPoints: [], totalCostUSD: 0 });
      const entry = modelMap.get(r.model_id)!;
      entry.dataPoints.push({ date: r.date, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUSD: r.cost_usd });
      entry.totalCostUSD += r.cost_usd;
      grandTotal += r.cost_usd;
    }
    const models = Array.from(modelMap.entries()).map(([modelId, data]) => ({
      modelId, ...data, percentOfTotal: grandTotal > 0 ? (data.totalCostUSD / grandTotal) * 100 : 0,
    }));
    res.json({ models });
  });

  return router;
}
