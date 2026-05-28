/**
 * Container Pool — Pre-warmed Docker containers for agent execution (#29)
 *
 * Maintains a pool of ready containers to minimize cold-start latency.
 * Falls back to on-demand creation when the pool is empty.
 */

import { execSync, exec } from 'child_process';
import { logger } from '../lib/logger.js';

// ---------- Types ----------

interface PooledContainer {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  status: 'idle' | 'acquired';
}

export interface ContainerPoolConfig {
  poolSize: number;
  image: string;
  idleTimeoutMs: number;
  healthCheckIntervalMs: number;
}

// ---------- Container Pool ----------

export class ContainerPool {
  private containers = new Map<string, PooledContainer>();
  private config: ContainerPoolConfig;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<ContainerPoolConfig>) {
    this.config = {
      poolSize: parseInt(process.env.CONTAINER_POOL_SIZE || '3', 10),
      image: process.env.CONTAINER_POOL_IMAGE || 'node:20-slim',
      idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
      healthCheckIntervalMs: 30_000,
      ...config,
    };
  }

  /** Start the pool: pre-warm containers and begin health monitoring */
  async warmUp(): Promise<void> {
    logger.info({ poolSize: this.config.poolSize, image: this.config.image }, 'Warming up container pool');

    const promises: Promise<void>[] = [];
    for (let i = this.idleCount(); i < this.config.poolSize; i++) {
      promises.push(this.createContainer());
    }
    await Promise.allSettled(promises);

    // Start health monitoring
    this.healthCheckTimer = setInterval(() => this.healthCheck(), this.config.healthCheckIntervalMs);
    // Start idle expiration
    this.idleCheckTimer = setInterval(() => this.expireIdle(), 60_000);

    logger.info({ ready: this.idleCount() }, 'Container pool warmed up');
  }

  /** Acquire a ready container from the pool. Falls back to cold start. */
  async acquire(): Promise<string> {
    // Try to get an idle container from pool
    for (const [id, container] of this.containers) {
      if (container.status === 'idle') {
        container.status = 'acquired';
        container.lastUsedAt = Date.now();
        logger.debug({ containerId: id }, 'Container acquired from pool');
        return id;
      }
    }

    // Pool empty — cold start
    logger.info('Container pool empty, cold-starting a new container');
    const id = await this.createContainerSync();
    if (id) {
      this.containers.set(id, {
        id,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        status: 'acquired',
      });
      return id;
    }
    throw new Error('Failed to create container');
  }

  /** Release a container back to the pool or destroy it */
  release(containerId: string): void {
    const container = this.containers.get(containerId);
    if (container) {
      container.status = 'idle';
      container.lastUsedAt = Date.now();
      logger.debug({ containerId }, 'Container released back to pool');

      // If over pool size, destroy instead
      if (this.idleCount() > this.config.poolSize) {
        this.destroyContainer(containerId);
      }
    }
  }

  /** Drain all containers and stop monitoring */
  async drain(): Promise<void> {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    if (this.idleCheckTimer) clearInterval(this.idleCheckTimer);
    this.healthCheckTimer = null;
    this.idleCheckTimer = null;

    const ids = [...this.containers.keys()];
    for (const id of ids) {
      this.destroyContainer(id);
    }
    logger.info('Container pool drained');
  }

  /** Current pool stats */
  stats(): { total: number; idle: number; acquired: number } {
    let idle = 0, acquired = 0;
    for (const c of this.containers.values()) {
      if (c.status === 'idle') idle++;
      else acquired++;
    }
    return { total: this.containers.size, idle, acquired };
  }

  // ---------- Internal ----------

  private idleCount(): number {
    let count = 0;
    for (const c of this.containers.values()) {
      if (c.status === 'idle') count++;
    }
    return count;
  }

  private async createContainer(): Promise<void> {
    try {
      const id = await this.createContainerSync();
      if (id) {
        this.containers.set(id, {
          id,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          status: 'idle',
        });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to create pooled container');
    }
  }

  private async createContainerSync(): Promise<string | null> {
    return new Promise((resolve) => {
      const cmd = `docker create --rm ${this.config.image} sleep infinity`;
      exec(cmd, (err, stdout) => {
        if (err) {
          logger.error({ err }, 'docker create failed');
          resolve(null);
          return;
        }
        const id = stdout.trim().slice(0, 12);
        // Start the container
        exec(`docker start ${id}`, (startErr) => {
          if (startErr) {
            logger.error({ err: startErr, containerId: id }, 'docker start failed');
            resolve(null);
            return;
          }
          logger.debug({ containerId: id }, 'Container created and started');
          resolve(id);
        });
      });
    });
  }

  private destroyContainer(containerId: string): void {
    this.containers.delete(containerId);
    exec(`docker rm -f ${containerId}`, (err) => {
      if (err) logger.debug({ err, containerId }, 'Failed to destroy container (may already be gone)');
    });
  }

  private healthCheck(): void {
    for (const [id, container] of this.containers) {
      exec(`docker inspect --format='{{.State.Running}}' ${id}`, (err, stdout) => {
        if (err || stdout.trim() !== 'true') {
          logger.warn({ containerId: id }, 'Unhealthy container detected, removing');
          this.containers.delete(id);
          // Replenish pool
          if (this.idleCount() < this.config.poolSize) {
            this.createContainer();
          }
        }
      });
    }
  }

  private expireIdle(): void {
    const now = Date.now();
    for (const [id, container] of this.containers) {
      if (container.status === 'idle' && (now - container.lastUsedAt) > this.config.idleTimeoutMs) {
        logger.debug({ containerId: id }, 'Expiring idle container');
        this.destroyContainer(id);
        // Replenish
        if (this.idleCount() < this.config.poolSize) {
          this.createContainer();
        }
      }
    }
  }
}

/** Singleton container pool */
export const containerPool = new ContainerPool();
