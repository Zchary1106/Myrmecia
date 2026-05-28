import { Router, Request, Response } from 'express';
import { execSync } from 'child_process';
import { statfsSync } from 'fs';
import { EventEmitter } from 'events';
import { getDb } from '../db/database.js';

// ─── Circuit Breaker ───────────────────────────────────────────────────────────

export class CircuitOpenError extends Error {
  constructor(message = 'Circuit breaker is OPEN') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;

  constructor(
    private readonly failureThreshold = 5,
    private readonly resetTimeout = 30_000,
    private readonly halfOpenRequests = 2,
  ) {
    super();
  }

  getState(): CircuitState {
    if (this.state === CircuitState.OPEN && Date.now() - this.lastFailureTime >= this.resetTimeout) {
      this.state = CircuitState.HALF_OPEN;
      this.halfOpenAttempts = 0;
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      throw new CircuitOpenError('Circuit breaker is OPEN — use degraded response');
    }

    if (currentState === CircuitState.HALF_OPEN && this.halfOpenAttempts >= this.halfOpenRequests) {
      throw new CircuitOpenError('Circuit breaker HALF_OPEN limit reached');
    }

    if (currentState === CircuitState.HALF_OPEN) {
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.halfOpenRequests) {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        this.emit('close');
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.successCount = 0;
      this.emit('open');
    }
  }
}

export const llmCircuitBreaker = new CircuitBreaker();

// ─── Health Checks ─────────────────────────────────────────────────────────────

interface CheckResult {
  status: 'pass' | 'warn' | 'fail';
  message?: string;
}

async function checkDb(): Promise<CheckResult> {
  try {
    const db = getDb();
    const row = db.get<{ ok: number }>('SELECT 1 as ok');
    return row?.ok === 1 ? { status: 'pass' } : { status: 'fail', message: 'SELECT 1 failed' };
  } catch (err: unknown) {
    return { status: 'fail', message: (err as Error).message };
  }
}

async function checkRedis(): Promise<CheckResult> {
  if (!process.env.REDIS_URL) {
    return { status: 'pass', message: 'skipped (no REDIS_URL)' };
  }
  try {
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, connectTimeout: 3000 });
    const pong = await redis.ping();
    await redis.quit();
    return pong === 'PONG' ? { status: 'pass' } : { status: 'fail', message: `ping returned: ${pong}` };
  } catch (err: unknown) {
    return { status: 'fail', message: (err as Error).message };
  }
}

async function checkDocker(): Promise<CheckResult> {
  if (process.env.EXECUTOR_MODE !== 'docker') {
    return { status: 'pass', message: 'skipped (not docker mode)' };
  }
  try {
    execSync('docker info', { timeout: 3000, stdio: 'pipe' });
    return { status: 'pass' };
  } catch (err: unknown) {
    return { status: 'fail', message: (err as Error).message };
  }
}

function checkDiskSpace(): CheckResult {
  try {
    const stats = statfsSync('/');
    const freeBytes = stats.bfree * stats.bsize;
    const freeGB = freeBytes / (1024 ** 3);
    if (freeGB < 1) {
      return { status: 'warn', message: `Low disk space: ${freeGB.toFixed(2)} GB free` };
    }
    return { status: 'pass', message: `${freeGB.toFixed(2)} GB free` };
  } catch {
    return { status: 'warn', message: 'Unable to check disk space' };
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────────

export function createHealthRoutes(): Router {
  const router = Router();

  router.get('/live', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req: Request, res: Response) => {
    const checks: Record<string, CheckResult> = {};

    const [db, redis, docker] = await Promise.all([checkDb(), checkRedis(), checkDocker()]);
    checks.db = db;
    checks.redis = redis;
    checks.docker = docker;
    checks.disk = checkDiskSpace();

    const hasFail = Object.values(checks).some(c => c.status === 'fail');
    const hasWarn = Object.values(checks).some(c => c.status === 'warn');

    const status = hasFail ? 'unhealthy' : hasWarn ? 'degraded' : 'healthy';
    const httpStatus = hasFail ? 503 : 200;

    res.status(httpStatus).json({ status, checks });
  });

  router.get('/circuit', (_req: Request, res: Response) => {
    res.json({
      state: llmCircuitBreaker.getState(),
    });
  });

  return router;
}
