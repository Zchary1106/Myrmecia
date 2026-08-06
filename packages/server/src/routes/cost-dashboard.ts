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

const usageSums = `
  COALESCE(SUM(input_tokens), 0) as input_tokens,
  COALESCE(SUM(output_tokens), 0) as output_tokens,
  COALESCE(SUM(ai_units), 0) as ai_units,
  COALESCE(SUM(CASE WHEN cost_type IN ('exact','estimated') THEN cost_usd ELSE 0 END), 0) as cost_usd,
  SUM(CASE WHEN cost_type IN ('exact','estimated') THEN 1 ELSE 0 END) as usd_request_count,
  SUM(CASE WHEN cost_type = 'subscription' THEN 1 ELSE 0 END) as subscription_request_count,
  SUM(CASE WHEN cost_type = 'unavailable' THEN 1 ELSE 0 END) as unavailable_request_count,
  COUNT(*) as request_count
`;

export function buildSummaryQuery(opts: { period: string; since?: string; until?: string }) {
  const dateTrunc = periodToDateTrunc(opts.period);
  const since = opts.since || sinceDefault(opts.period);
  const until = opts.until || new Date().toISOString();
  return {
    sql: `
      SELECT ${dateTrunc} as date, ${usageSums}
      FROM model_usage_stats
      WHERE created_at >= ? AND created_at < ?
      GROUP BY date ORDER BY date ASC
    `,
    params: [since, until],
  };
}

export function buildByAgentQuery(opts: { period: string; since?: string; until?: string }) {
  const dateTrunc = periodToDateTrunc(opts.period);
  const since = opts.since || sinceDefault(opts.period);
  const until = opts.until || new Date().toISOString();
  return {
    sql: `
      SELECT agent_id, ${dateTrunc} as date, ${usageSums}
      FROM model_usage_stats
      WHERE created_at >= ? AND created_at < ?
      GROUP BY agent_id, date ORDER BY agent_id, date ASC
    `,
    params: [since, until],
  };
}

export function buildByModelQuery(opts: { period: string; since?: string; until?: string }) {
  const dateTrunc = periodToDateTrunc(opts.period);
  const since = opts.since || sinceDefault(opts.period);
  const until = opts.until || new Date().toISOString();
  return {
    sql: `
      SELECT model_id, actual_model_id, provider, ${dateTrunc} as date, ${usageSums}
      FROM model_usage_stats
      WHERE created_at >= ? AND created_at < ?
      GROUP BY model_id, actual_model_id, provider, date
      ORDER BY model_id, actual_model_id, date ASC
    `,
    params: [since, until],
  };
}

export function buildByStageQuery(opts: { since?: string; until?: string }) {
  const since = opts.since || sinceDefault('week');
  const until = opts.until || new Date().toISOString();
  return {
    sql: `
      SELECT pipeline_id, stage_index, agent_id, model_tier, model_id,
        actual_model_id, provider, ${usageSums}
      FROM model_usage_stats
      WHERE created_at >= ? AND created_at < ? AND pipeline_id IS NOT NULL
      GROUP BY pipeline_id, stage_index, agent_id, model_tier, model_id, actual_model_id, provider
      ORDER BY pipeline_id ASC, stage_index ASC
    `,
    params: [since, until],
  };
}

function costUSD(row: any): number | null {
  return Number(row.usd_request_count) > 0 ? Number(row.cost_usd) || 0 : null;
}

function costType(row: any): 'estimated' | 'subscription' | 'unavailable' {
  if (Number(row.usd_request_count) > 0) return 'estimated';
  if (Number(row.subscription_request_count) > 0) return 'subscription';
  return 'unavailable';
}

export function createCostDashboardRoutes(): Router {
  const router = Router();

  router.get('/summary', (req, res) => {
    const period = (req.query.period as string) || 'day';
    const { sql, params } = buildSummaryQuery({ period, since: req.query.since as string, until: req.query.until as string });
    const rows = getDb().all(sql, ...params) as any[];
    const totals = rows.reduce((acc, row) => ({
      totalInputTokens: acc.totalInputTokens + Number(row.input_tokens || 0),
      totalOutputTokens: acc.totalOutputTokens + Number(row.output_tokens || 0),
      totalAiUnits: acc.totalAiUnits + Number(row.ai_units || 0),
      totalCostUSD: acc.totalCostUSD + Number(row.cost_usd || 0),
      usdRequestCount: acc.usdRequestCount + Number(row.usd_request_count || 0),
      subscriptionRequestCount: acc.subscriptionRequestCount + Number(row.subscription_request_count || 0),
      unavailableRequestCount: acc.unavailableRequestCount + Number(row.unavailable_request_count || 0),
      requestCount: acc.requestCount + Number(row.request_count || 0),
    }), {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalAiUnits: 0,
      totalCostUSD: 0,
      usdRequestCount: 0,
      subscriptionRequestCount: 0,
      unavailableRequestCount: 0,
      requestCount: 0,
    });
    res.json({
      period,
      ...totals,
      totalCostUSD: totals.usdRequestCount > 0 ? totals.totalCostUSD : null,
      dataPoints: rows.map(row => ({
        date: row.date,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        aiUnits: row.ai_units,
        costUSD: costUSD(row),
        costType: costType(row),
        requestCount: row.request_count,
      })),
    });
  });

  router.get('/by-agent', (req, res) => {
    const period = (req.query.period as string) || 'day';
    const { sql, params } = buildByAgentQuery({ period, since: req.query.since as string, until: req.query.until as string });
    const rows = getDb().all(sql, ...params) as any[];
    const agentMap = new Map<string, { dataPoints: any[]; totalCostUSD: number; usdRequestCount: number; totalAiUnits: number }>();
    for (const row of rows) {
      const agentId = row.agent_id || 'unknown';
      if (!agentMap.has(agentId)) agentMap.set(agentId, { dataPoints: [], totalCostUSD: 0, usdRequestCount: 0, totalAiUnits: 0 });
      const entry = agentMap.get(agentId)!;
      entry.dataPoints.push({
        date: row.date,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        aiUnits: Number(row.ai_units) || 0,
        costUSD: costUSD(row),
      });
      entry.totalCostUSD += Number(row.cost_usd) || 0;
      entry.usdRequestCount += Number(row.usd_request_count) || 0;
      entry.totalAiUnits += Number(row.ai_units) || 0;
    }
    const agents = Array.from(agentMap.entries())
      .filter(([, data]) => data.totalAiUnits > 0 || data.usdRequestCount > 0
        || data.dataPoints.some(point => Number(point.inputTokens) + Number(point.outputTokens) > 0))
      .map(([agentId, data]) => ({
        agentId,
        agentName: getAgent(agentId)?.name || agentId,
        ...data,
        totalCostUSD: data.usdRequestCount > 0 ? data.totalCostUSD : null,
      }));
    res.json({ agents });
  });

  router.get('/by-task', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const rows = getDb().all(`
      SELECT m.task_id, t.title, m.agent_id, MAX(m.provider) as provider,
        MAX(m.actual_model_id) as actual_model_id, ${usageSums},
        MAX(m.created_at) as completed_at
      FROM model_usage_stats m
      LEFT JOIN tasks t ON t.id = m.task_id
      WHERE m.task_id IS NOT NULL
      GROUP BY m.task_id ORDER BY completed_at DESC LIMIT ?
    `, limit) as any[];
    res.json({
      tasks: rows.map(row => ({
        taskId: row.task_id,
        title: row.title || row.task_id,
        agentId: row.agent_id,
        provider: row.provider,
        actualModelId: row.actual_model_id,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        aiUnits: Number(row.ai_units) || 0,
        costUSD: costUSD(row),
        costType: costType(row),
        completedAt: row.completed_at,
      })),
    });
  });

  router.get('/by-model', (req, res) => {
    const period = (req.query.period as string) || 'day';
    const { sql, params } = buildByModelQuery({ period, since: req.query.since as string, until: req.query.until as string });
    const rows = getDb().all(sql, ...params) as any[];
    const modelMap = new Map<string, {
      requestedModelId: string;
      actualModelId?: string;
      provider?: string;
      dataPoints: any[];
      totalCostUSD: number;
      usdRequestCount: number;
      totalAiUnits: number;
    }>();
    for (const row of rows) {
      const modelId = row.actual_model_id || row.model_id;
      if (!modelMap.has(modelId)) {
        modelMap.set(modelId, {
          requestedModelId: row.model_id,
          actualModelId: row.actual_model_id || undefined,
          provider: row.provider || undefined,
          dataPoints: [],
          totalCostUSD: 0,
          usdRequestCount: 0,
          totalAiUnits: 0,
        });
      }
      const entry = modelMap.get(modelId)!;
      entry.dataPoints.push({
        date: row.date,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        aiUnits: Number(row.ai_units) || 0,
        costUSD: costUSD(row),
      });
      entry.totalCostUSD += Number(row.cost_usd) || 0;
      entry.usdRequestCount += Number(row.usd_request_count) || 0;
      entry.totalAiUnits += Number(row.ai_units) || 0;
    }
    const grandAiUnits = Array.from(modelMap.values()).reduce((sum, item) => sum + item.totalAiUnits, 0);
    const grandCostUSD = Array.from(modelMap.values()).reduce((sum, item) => sum + item.totalCostUSD, 0);
    const models = Array.from(modelMap.entries())
      .filter(([, data]) => data.totalAiUnits > 0 || data.usdRequestCount > 0
        || data.dataPoints.some(point => Number(point.inputTokens) + Number(point.outputTokens) > 0))
      .map(([modelId, data]) => ({
        modelId,
        ...data,
        totalCostUSD: data.usdRequestCount > 0 ? data.totalCostUSD : null,
        percentOfTotal: grandAiUnits > 0
          ? (data.totalAiUnits / grandAiUnits) * 100
          : grandCostUSD > 0 ? (data.totalCostUSD / grandCostUSD) * 100 : 0,
      }));
    res.json({ models });
  });

  router.get('/by-stage', (req, res) => {
    const { sql, params } = buildByStageQuery({ since: req.query.since as string, until: req.query.until as string });
    const rows = getDb().all(sql, ...params) as any[];
    res.json({
      stages: rows.map(row => ({
        pipelineId: row.pipeline_id,
        stageIndex: row.stage_index,
        agentId: row.agent_id,
        modelTier: row.model_tier,
        requestedModelId: row.model_id,
        actualModelId: row.actual_model_id,
        provider: row.provider,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        aiUnits: Number(row.ai_units) || 0,
        costUSD: costUSD(row),
        costType: costType(row),
        requestCount: row.request_count,
      })),
    });
  });

  return router;
}
