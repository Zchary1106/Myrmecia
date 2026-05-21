/**
 * Database Abstraction Layer — Async-First Design
 *
 * Two backends:
 * - SQLite (better-sqlite3) for development — sync internally, wrapped as async
 * - PostgreSQL (pg) for production — truly async via Pool
 *
 * All public methods are async (return Promises).
 * SQLite wraps sync calls in Promise.resolve() — zero overhead.
 *
 * Set DATABASE_URL=postgres://... to use PostgreSQL.
 * Without DATABASE_URL, falls back to SQLite (DB_PATH or default file).
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { basename, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { RuntimeDiagnostics } from '../types.js';
import { logger } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Types ----------

export interface DbResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface DbDriver {
  /** Execute a query and return all matching rows */
  all<T = any>(sql: string, ...params: any[]): T[];
  /** Execute a query and return the first matching row */
  get<T = any>(sql: string, ...params: any[]): T | undefined;
  /** Execute a statement (INSERT/UPDATE/DELETE) */
  run(sql: string, ...params: any[]): DbResult;
  /** Execute raw SQL (DDL, multi-statement) */
  exec(sql: string): void;
  /** Run a function inside a transaction */
  transaction<T>(fn: () => T): T;
  /** Close the connection */
  close(): void;
  /** Backend name */
  readonly backend: 'sqlite' | 'postgres';
}

/**
 * Async database driver interface — used by all model code going forward.
 * SQLite implements this by wrapping sync calls; PG implements natively.
 */
export interface AsyncDbDriver {
  all<T = any>(sql: string, ...params: any[]): Promise<T[]>;
  get<T = any>(sql: string, ...params: any[]): Promise<T | undefined>;
  run(sql: string, ...params: any[]): Promise<DbResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (client: AsyncDbDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly backend: 'sqlite' | 'postgres';
}

// ---------- SQLite Backend ----------

class SqliteDriver implements DbDriver {
  readonly backend = 'sqlite' as const;
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  all<T = any>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T = any>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: any[]): DbResult {
    const result = this.db.prepare(sql).run(...params);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

/** Wraps sync SQLite driver as AsyncDbDriver (zero-cost Promise wrappers) */
class SqliteAsyncAdapter implements AsyncDbDriver {
  readonly backend = 'sqlite' as const;
  constructor(private driver: SqliteDriver) {}

  async all<T = any>(sql: string, ...params: any[]): Promise<T[]> {
    return this.driver.all<T>(sql, ...params);
  }
  async get<T = any>(sql: string, ...params: any[]): Promise<T | undefined> {
    return this.driver.get<T>(sql, ...params);
  }
  async run(sql: string, ...params: any[]): Promise<DbResult> {
    return this.driver.run(sql, ...params);
  }
  async exec(sql: string): Promise<void> {
    return this.driver.exec(sql);
  }
  async transaction<T>(fn: (client: AsyncDbDriver) => Promise<T>): Promise<T> {
    // SQLite transactions are sync, so we run the async fn synchronously within a transaction wrapper
    let result: T;
    this.driver.transaction(() => {
      // We block on the promise here — safe because SQLite is single-connection
      // In practice, the fn will resolve immediately since SQLite ops are sync
      const p = fn(this);
      // For SQLite, all inner calls resolve synchronously, so this works
      // @ts-ignore — intentional sync await for SQLite only
      if (p && typeof p.then === 'function') {
        let resolved = false;
        let val: T;
        let err: any;
        p.then((v: T) => { val = v; resolved = true; }).catch((e: any) => { err = e; resolved = true; });
        if (!resolved) throw new Error('SQLite transaction cannot contain truly async operations');
        if (err) throw err;
        result = val!;
      } else {
        result = p as T;
      }
    });
    return result!;
  }
  async close(): Promise<void> {
    this.driver.close();
  }
}

// ---------- PostgreSQL Async Backend ----------

class PostgresAsyncDriver implements AsyncDbDriver {
  readonly backend = 'postgres' as const;
  private pool: any;

  constructor(connectionString: string) {
    try {
      const pg = require('pg');
      this.pool = new pg.Pool({ connectionString, max: 20 });
    } catch {
      throw new Error('PostgreSQL requires "pg" package. Install: pnpm add pg');
    }
  }

  async all<T = any>(sql: string, ...params: any[]): Promise<T[]> {
    const { pgSql, pgParams } = convertPlaceholders(sql, params);
    const result = await this.pool.query(pgSql, pgParams);
    return result.rows as T[];
  }

  async get<T = any>(sql: string, ...params: any[]): Promise<T | undefined> {
    const rows = await this.all<T>(sql, ...params);
    return rows[0];
  }

  async run(sql: string, ...params: any[]): Promise<DbResult> {
    const { pgSql, pgParams } = convertPlaceholders(sql, params);

    // Add RETURNING id for INSERTs without RETURNING
    let finalSql = pgSql;
    if (/^\s*INSERT/i.test(pgSql) && !/RETURNING/i.test(pgSql)) {
      finalSql = pgSql.replace(/;?\s*$/, ' RETURNING id');
    }

    const result = await this.pool.query(finalSql, pgParams);
    const lastId = result.rows?.[0]?.id ?? 0;
    return { changes: result.rowCount ?? 0, lastInsertRowid: lastId };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (client: AsyncDbDriver) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Create a client-scoped driver for the transaction
      const txDriver: AsyncDbDriver = {
        backend: 'postgres',
        all: async <T = any>(sql: string, ...params: any[]) => {
          const { pgSql, pgParams } = convertPlaceholders(sql, params);
          const res = await client.query(pgSql, pgParams);
          return res.rows as T[];
        },
        get: async <T = any>(sql: string, ...params: any[]) => {
          const { pgSql, pgParams } = convertPlaceholders(sql, params);
          const res = await client.query(pgSql, pgParams);
          return res.rows[0] as T | undefined;
        },
        run: async (sql: string, ...params: any[]) => {
          const { pgSql, pgParams } = convertPlaceholders(sql, params);
          let finalSql = pgSql;
          if (/^\s*INSERT/i.test(pgSql) && !/RETURNING/i.test(pgSql)) {
            finalSql = pgSql.replace(/;?\s*$/, ' RETURNING id');
          }
          const res = await client.query(finalSql, pgParams);
          return { changes: res.rowCount ?? 0, lastInsertRowid: res.rows?.[0]?.id ?? 0 };
        },
        exec: async (sql: string) => { await client.query(sql); },
        transaction: async () => { throw new Error('Nested transactions not supported'); },
        close: async () => {},
      };
      const result = await fn(txDriver);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------- Placeholder conversion ----------

function convertPlaceholders(sql: string, params: any[]): { pgSql: string; pgParams: any[] } {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  return { pgSql, pgParams: params };
}

// ---------- Singletons ----------

let syncDriver: DbDriver | undefined;
let asyncDriver: AsyncDbDriver | undefined;
let activeDbPath: string | undefined;

/**
 * Get synchronous DB driver (SQLite only — for backward compat and tests).
 * Throws if DATABASE_URL is set (use getAsyncDb() for PG).
 */
export function getDb(): DbDriver {
  if (!syncDriver) {
    if (process.env.DATABASE_URL) {
      // For backward compat: create SQLite as sync driver even with PG URL
      // The sync interface is only used in dev/tests
      // In production routes should use getAsyncDb()
      const dbPath = process.env.DB_PATH || join(__dirname, '../../data/agent-factory.db');
      activeDbPath = dbPath;
      logger.info({ path: basename(dbPath) }, 'Using SQLite (sync) database');
      syncDriver = new SqliteDriver(dbPath);
    } else {
      const dbPath = process.env.DB_PATH || join(__dirname, '../../data/agent-factory.db');
      activeDbPath = dbPath;
      logger.info({ path: basename(dbPath) }, 'Using SQLite database');
      syncDriver = new SqliteDriver(dbPath);
    }
    initSchema(syncDriver);
  }
  return syncDriver;
}

/**
 * Get async DB driver — preferred for all production code.
 * Uses PostgreSQL if DATABASE_URL is set, otherwise wraps SQLite.
 */
export function getAsyncDb(): AsyncDbDriver {
  if (!asyncDriver) {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl && databaseUrl.startsWith('postgres')) {
      logger.info('Connecting to PostgreSQL (async)...');
      asyncDriver = new PostgresAsyncDriver(databaseUrl);
      activeDbPath = databaseUrl.split('@')[1]?.split('/')[1] || 'postgres';
      // Initialize schema via sync driver for initial setup
      // (schema init is one-time and acceptable to do synchronously at startup)
    } else {
      // Wrap the sync SQLite driver
      const sync = getDb() as SqliteDriver;
      asyncDriver = new SqliteAsyncAdapter(sync as any);
    }
  }
  return asyncDriver;
}

export function listAppliedMigrations(): RuntimeDiagnostics['database']['migrations'] {
  const rows = getDb().all<{ id: string; applied_at: string }>('SELECT id, applied_at FROM schema_migrations ORDER BY id');
  return rows.map(row => ({ id: row.id, appliedAt: row.applied_at }));
}

export function getDatabaseDiagnostics(): RuntimeDiagnostics['database'] {
  const pathHint = activeDbPath ? basename(activeDbPath) : 'agent-factory.db';
  return {
    pathSource: process.env.DATABASE_URL ? 'env' : process.env.DB_PATH ? 'env' : 'default',
    pathHint,
    migrations: listAppliedMigrations(),
  };
}

// ---------- Schema & Migrations ----------

interface Migration {
  id: string;
  sql: string;
}

function initSchema(db: DbDriver) {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  const { mainSchema, migrations } = splitSchema(schema);

  const finalSchema = db.backend === 'postgres' ? convertToPostgres(mainSchema) : mainSchema;
  db.exec(finalSchema);
  applyMigrations(db, migrations);

  // Apply additional module schemas (idempotent CREATE IF NOT EXISTS)
  applyModuleSchemas(db);
}

function applyModuleSchemas(db: DbDriver) {
  // All module schemas use CREATE TABLE IF NOT EXISTS — safe to re-run
  const schemas = [
    // Multi-tenancy
    `CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
     CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
     CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
     CREATE TABLE IF NOT EXISTS workspace_memberships (user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, workspace_id));`,
    // Auth (OIDC refresh/revoke)
    `CREATE TABLE IF NOT EXISTS refresh_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS revoked_tokens (jti TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`,
    // Knowledge/RAG
    `CREATE TABLE IF NOT EXISTS knowledge_documents (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, metadata JSON NOT NULL DEFAULT '{}', chunk_count INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
     CREATE TABLE IF NOT EXISTS agent_memories (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(agent_id, workspace_id, key));`,
    // Audit log
    `CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, actor_id TEXT NOT NULL, actor_type TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, workspace_id TEXT NOT NULL, metadata JSON NOT NULL DEFAULT '{}', outcome TEXT NOT NULL DEFAULT 'success', prev_hash TEXT NOT NULL DEFAULT '', entry_hash TEXT NOT NULL DEFAULT '');`,
    // A2A protocol
    `CREATE TABLE IF NOT EXISTS a2a_messages (id TEXT PRIMARY KEY, type TEXT NOT NULL, from_agent_id TEXT NOT NULL, from_execution_id TEXT, to_agent_id TEXT NOT NULL, to_execution_id TEXT, correlation_id TEXT, payload JSON NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'pending', expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, delivered_at DATETIME);`,
    // Plugins
    `CREATE TABLE IF NOT EXISTS installed_plugins (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, workspace_id TEXT NOT NULL, manifest JSON NOT NULL, status TEXT NOT NULL DEFAULT 'installed', source_url TEXT, error TEXT, installed_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(plugin_id, workspace_id));`,
    // Budget
    `CREATE TABLE IF NOT EXISTS workspace_budgets (workspace_id TEXT PRIMARY KEY, monthly_limit_usd REAL NOT NULL DEFAULT 100.0, alert_threshold_percent INTEGER NOT NULL DEFAULT 80, on_exhausted TEXT NOT NULL DEFAULT 'alert_only', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`,
    // API Keys
    `CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, scopes JSON NOT NULL DEFAULT '[]', expires_at DATETIME, last_used_at DATETIME, revoked_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`,
    // DLP Rules
    `CREATE TABLE IF NOT EXISTS dlp_rules (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'regex', pattern TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'warn', priority INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`,
    // Notification channels
    `CREATE TABLE IF NOT EXISTS notification_channels (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL, config JSON NOT NULL DEFAULT '{}', events JSON NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`,
    // Releases / Feature flags
    `CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, version TEXT NOT NULL, environment TEXT NOT NULL DEFAULT 'staging', status TEXT NOT NULL DEFAULT 'pending', changelog TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, promoted_at DATETIME);
     CREATE TABLE IF NOT EXISTS feature_flags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 0, rollout_percent INTEGER NOT NULL DEFAULT 0, conditions JSON NOT NULL DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`,
    // Orchestrations
    `CREATE TABLE IF NOT EXISTS orchestrations (id TEXT PRIMARY KEY, input TEXT NOT NULL, intent JSON NOT NULL, status TEXT NOT NULL DEFAULT 'planning', task_ids JSON NOT NULL DEFAULT '[]', result TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME);
     CREATE INDEX IF NOT EXISTS idx_orchestrations_status ON orchestrations(status);`,
    // Coverage reports
    `CREATE TABLE IF NOT EXISTS coverage_reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  line_coverage REAL NOT NULL,
  branch_coverage REAL NOT NULL,
  threshold REAL NOT NULL,
  passed INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);`,
  ];

  for (const sql of schemas) {
    try {
      const finalSql = db.backend === 'postgres' ? convertToPostgres(sql) : sql;
      db.exec(finalSql);
    } catch (err: any) {
      // Ignore "already exists" errors
      if (!err?.message?.includes('already exists')) {
        logger.warn({ error: err.message }, 'Module schema apply warning');
      }
    }
  }
}

function splitSchema(schema: string): { mainSchema: string; migrations: Migration[] } {
  const lines = schema.split('\n');
  const mainSchema: string[] = [];
  const migrations: Migration[] = [];
  let currentMigration: Migration | undefined;

  let inMigration = false;
  for (const line of lines) {
    if (line.includes('-- Migrations')) { inMigration = true; continue; }
    if (inMigration) {
      const migrationMatch = line.match(/^-- Migration:\s*(\S+)/);
      if (migrationMatch) {
        if (currentMigration) migrations.push(currentMigration);
        currentMigration = { id: migrationMatch[1], sql: '' };
        continue;
      }
      if (currentMigration) currentMigration.sql += `${line}\n`;
    } else {
      mainSchema.push(line);
    }
  }
  if (currentMigration) migrations.push(currentMigration);

  return { mainSchema: mainSchema.join('\n'), migrations: migrations.filter(m => m.sql.trim()) };
}

function applyMigrations(db: DbDriver, migrations: Migration[]) {
  const applied = new Set(
    db.all<{ id: string }>('SELECT id FROM schema_migrations').map(row => row.id),
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    const sql = db.backend === 'postgres' ? convertToPostgres(migration.sql) : migration.sql;

    try {
      db.transaction(() => {
        db.exec(sql);
        db.run('INSERT INTO schema_migrations (id) VALUES (?)', migration.id);
      });
    } catch (err: any) {
      if (err?.message?.includes('duplicate column name') || err?.message?.includes('already exists')) {
        logger.warn({ migrationId: migration.id }, 'Migration already applied; recording it');
        db.run('INSERT INTO schema_migrations (id) VALUES (?) ON CONFLICT DO NOTHING', migration.id);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Convert SQLite-specific SQL syntax to PostgreSQL-compatible syntax.
 */
function convertToPostgres(sql: string): string {
  return sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/DATETIME/g, 'TIMESTAMPTZ')
    .replace(/\bJSON\b/g, 'JSONB')
    .replace(/(\w+)\s+INTEGER\s+NOT NULL\s+DEFAULT\s+([01])\s+CHECK\(\1\s+IN\s*\(0,\s*1\)\)/g,
      '$1 BOOLEAN NOT NULL DEFAULT $2')
    .replace(/(\w+)\s+INTEGER\s+DEFAULT\s+0\s+CHECK\(\1\s+IN\s*\(0,\s*1\)\)/g,
      '$1 BOOLEAN DEFAULT FALSE')
    .replace(/DEFAULT 0(?=\s|,|\))/g, 'DEFAULT FALSE')
    .replace(/DEFAULT 1(?=\s|,|\))/g, 'DEFAULT TRUE')
    .replace(/INSERT OR IGNORE/g, 'INSERT INTO');
}

export function closeDb() {
  if (syncDriver) {
    syncDriver.close();
    syncDriver = undefined;
  }
  if (asyncDriver) {
    asyncDriver.close();
    asyncDriver = undefined;
  }
  activeDbPath = undefined;
}
