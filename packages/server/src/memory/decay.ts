/**
 * Memory Decay & Forgetting (P4).
 *
 * Long-term value = importance × recency. This maintenance pass enforces TTLs,
 * expires ephemeral memories, and prunes low-value, stale, rarely-accessed
 * episodes so the store stays relevant. Durable semantic/procedural memories
 * are retained.
 */

import { getMemoryStore, type SqliteMemoryStore } from './memory-store.js';
import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';

export interface DecayResult {
  expired: number;
  prunedWorking: number;
  prunedEpisodic: number;
}

function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) ? n : fallback;
}

export class MemoryMaintenance {
  private store: SqliteMemoryStore;

  constructor(store?: SqliteMemoryStore) {
    this.store = store || getMemoryStore();
  }

  /** Run a single decay/forgetting pass. Safe to call repeatedly. */
  async runDecay(): Promise<DecayResult> {
    await this.store.initialize();
    const db = getDb();

    const workingTtl = num(process.env.MEMORY_DECAY_WORKING_TTL_DAYS, 1);
    const episodicTtl = num(process.env.MEMORY_DECAY_EPISODIC_TTL_DAYS, 30);
    const minImportance = num(process.env.MEMORY_DECAY_MIN_IMPORTANCE, 0.3);
    const minAccess = num(process.env.MEMORY_DECAY_MIN_ACCESS, 1);

    const collect = (sql: string, ...params: any[]): string[] =>
      (db.all(sql, ...params) as Array<{ id: string }>).map(r => r.id);

    // 1. Hard-expire anything past its TTL.
    const expiredIds = collect(
      "SELECT id FROM memory_items WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
    );

    // 2. Working memory is ephemeral by nature.
    const workingIds = collect(
      "SELECT id FROM memory_items WHERE type = 'working' AND created_at < datetime('now', ?)",
      `-${workingTtl} days`
    );

    // 3. Stale, low-value, rarely-accessed episodes.
    const episodicIds = collect(
      `SELECT id FROM memory_items
        WHERE type = 'episodic'
          AND created_at < datetime('now', ?)
          AND importance < ?
          AND access_count < ?`,
      `-${episodicTtl} days`,
      minImportance,
      minAccess
    );

    const all = new Set<string>([...expiredIds, ...workingIds, ...episodicIds]);
    for (const id of all) {
      try { this.store.forget(id); } catch { /* best-effort */ }
    }

    const result: DecayResult = {
      expired: expiredIds.length,
      prunedWorking: workingIds.length,
      prunedEpisodic: episodicIds.length,
    };
    if (all.size > 0) logger.info(result, 'Memory decay pass complete');
    return result;
  }
}

// ---------- Singleton ----------

let maintenance: MemoryMaintenance | null = null;

export function getMemoryMaintenance(): MemoryMaintenance {
  if (!maintenance) maintenance = new MemoryMaintenance();
  return maintenance;
}

export function resetMemoryMaintenance(): void {
  maintenance = null;
}
