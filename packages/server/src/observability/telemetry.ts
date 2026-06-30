import { logger } from '../lib/logger.js';

// ---------- Types ----------

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
  recordException(err: Error): void;
}

export interface Tracer {
  startSpan(name: string, options?: { attributes?: Record<string, string | number> }): Span;
}

export interface Counter {
  add(value: number, attributes?: Record<string, string>): void;
}

export interface Histogram {
  record(value: number, attributes?: Record<string, string>): void;
}

// ---------- No-op implementations ----------

function noopSpan(): Span {
  return { setAttribute() {}, setStatus() {}, end() {}, recordException() {} };
}

const noopTracer: Tracer = {
  startSpan() { return noopSpan(); },
};

const noopCounter: Counter = { add() {} };
const noopHistogram: Histogram = { record() {} };

// ---------- Metrics ----------

export const metrics = {
  httpRequests: noopCounter as Counter,
  httpDuration: noopHistogram as Histogram,
  taskExecutions: noopCounter as Counter,
  taskDuration: noopHistogram as Histogram,
  agentExecutions: noopCounter as Counter,
  agentSuccessRate: noopCounter as Counter,
  queueDepth: noopCounter as Counter,
  tokenUsage: noopCounter as Counter,
  cacheHitRate: noopCounter as Counter,
  costMicrodollars: noopCounter as Counter,
};

// ---------- Tracer ----------

export let tracer: Tracer = noopTracer;

// ---------- Helpers for mapping DB trace writes to OTel ----------

export function otelSpanFromTrace(
  name: string,
  attributes?: Record<string, string | number>,
): Span {
  return tracer.startSpan(name, { attributes });
}

export function emitMetric(
  name: keyof typeof metrics,
  value: number,
  attributes?: Record<string, string>,
): void {
  const metric = metrics[name] as Counter | Histogram;
  if ('record' in metric) {
    metric.record(value, attributes);
  } else {
    metric.add(value, attributes);
  }
}

// ---------- Initialization ----------

let initialized = false;
let _otelShutdown: (() => Promise<void>) | undefined;

export async function initTelemetry(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const enabled = process.env.OTEL_ENABLED === 'true';
  if (!enabled) {
    logger.info('OpenTelemetry disabled (set OTEL_ENABLED=true to enable)');
    return;
  }

  try {
    const { initRealTelemetry } = await import('./otel-config.js');
    const { tracer: otelTracer, meter, shutdown } = initRealTelemetry();
    _otelShutdown = shutdown;

    tracer = {
      startSpan(name, options) {
        const span = otelTracer.startSpan(name);
        if (options?.attributes) {
          for (const [k, v] of Object.entries(options.attributes)) {
            span.setAttribute(k, v);
          }
        }
        return {
          setAttribute(k, v) { span.setAttribute(k, v); },
          setStatus(s) { span.setStatus(s); },
          end() { span.end(); },
          recordException(err) { span.recordException(err); },
        };
      },
    };

    const makeCounter = (name: string, desc: string): Counter => {
      const c = meter.createCounter(name, { description: desc });
      return { add(v, attrs) { c.add(v, attrs); } };
    };

    const makeHistogram = (name: string, desc: string): Histogram => {
      const h = meter.createHistogram(name, { description: desc });
      return { record(v, attrs) { h.record(v, attrs); } };
    };

    metrics.httpRequests = makeCounter('http.requests', 'Total HTTP requests');
    metrics.httpDuration = makeHistogram('http.duration_ms', 'HTTP request duration');
    metrics.taskExecutions = makeCounter('task.executions', 'Task executions by status');
    metrics.taskDuration = makeHistogram('task.duration_ms', 'Task execution duration');
    metrics.agentExecutions = makeCounter('agent.executions', 'Agent executions');
    metrics.agentSuccessRate = makeCounter('agent.success_rate', 'Agent success/failure count');
    metrics.queueDepth = makeCounter('queue.depth', 'Queue depth changes');
    metrics.tokenUsage = makeCounter('llm.tokens', 'LLM token usage');
    metrics.cacheHitRate = makeCounter('llm_cache.hit_rate', 'Cache hit/miss count');
    metrics.costMicrodollars = makeCounter('llm.cost_microdollars', 'LLM cost in microdollars');

    logger.info('OpenTelemetry initialized');
  } catch (err: any) {
    logger.warn({ error: err.message }, 'OpenTelemetry initialization failed');
  }
}

/** Flush and shutdown OTel — call during graceful shutdown. Safe no-op when OTel is disabled. */
export async function shutdownTelemetry(): Promise<void> {
  if (_otelShutdown) {
    await _otelShutdown();
    _otelShutdown = undefined;
  }
}

// ---------- Express Middleware ----------

import type { RequestHandler } from 'express';

export const telemetryMiddleware: RequestHandler = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const route = req.route?.path || req.path;
    const method = req.method;
    const status = String(res.statusCode);
    metrics.httpRequests.add(1, { method, route, status });
    metrics.httpDuration.record(duration, { method, route, status });
  });
  next();
};

// ---------- Metrics endpoint (Prometheus format) ----------

export const metricsHandler: RequestHandler = async (_req, res) => {
  try {
    const { getDb } = await import('../db/database.js');
    const db = getDb();
    const taskStats = db.get(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM tasks
    `) as any;

    const execStats = db.get(`
      SELECT
        COUNT(*) as total,
        SUM(cost_usd) as totalCost,
        SUM(token_count) as totalTokens
      FROM task_executions
    `) as any;

    const queueStats = db.get(`
      SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'queued')
    `) as any;

    const agentStats = db.get(`
      SELECT
        (SELECT COUNT(*) FROM agents) as total,
        (SELECT COUNT(DISTINCT agent_def_id) FROM task_executions WHERE status = 'running') as active
    `) as any;

    // Prometheus text format
    const accept = _req.header('Accept') || '';
    if (accept.includes('text/plain') || _req.query.format === 'prometheus') {
      const lines: string[] = [];
      lines.push('# HELP agent_factory_tasks_total Total tasks.');
      lines.push('# TYPE agent_factory_tasks_total gauge');
      lines.push(`agent_factory_tasks_total{status="running"} ${taskStats?.running || 0}`);
      lines.push(`agent_factory_tasks_total{status="done"} ${taskStats?.done || 0}`);
      lines.push(`agent_factory_tasks_total{status="failed"} ${taskStats?.failed || 0}`);
      lines.push('');
      lines.push('# HELP agent_factory_queue_depth Tasks waiting in queue.');
      lines.push('# TYPE agent_factory_queue_depth gauge');
      lines.push(`agent_factory_queue_depth ${queueStats?.count || 0}`);
      lines.push('');
      lines.push('# HELP agent_factory_agents_active Active agent count.');
      lines.push('# TYPE agent_factory_agents_active gauge');
      lines.push(`agent_factory_agents_active ${agentStats?.active || 0}`);
      lines.push('');
      lines.push('# HELP agent_factory_uptime_seconds Process uptime.');
      lines.push('# TYPE agent_factory_uptime_seconds gauge');
      lines.push(`agent_factory_uptime_seconds ${Math.round(process.uptime())}`);
      lines.push('');

      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.send(lines.join('\n'));
      return;
    }

    res.json({
      tasks: taskStats || {},
      executions: execStats || {},
      queue: queueStats || {},
      agents: agentStats || {},
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
  } catch {
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
};
