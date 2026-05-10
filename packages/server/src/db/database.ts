import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { basename, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { RuntimeDiagnostics } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | undefined;
let activeDbPath: string | undefined;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DB_PATH || join(__dirname, '../../data/agent-factory.db');
    activeDbPath = dbPath;
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

export function listAppliedMigrations(): RuntimeDiagnostics['database']['migrations'] {
  const rows = getDb().prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all() as { id: string; applied_at: string }[];
  return rows.map(row => ({ id: row.id, appliedAt: row.applied_at }));
}

export function getDatabaseDiagnostics(): RuntimeDiagnostics['database'] {
  const pathHint = activeDbPath ? basename(activeDbPath) : 'agent-factory.db';
  return {
    pathSource: process.env.DB_PATH ? 'env' : 'default',
    pathHint,
    migrations: listAppliedMigrations(),
  };
}

interface Migration {
  id: string;
  sql: string;
}

function initSchema(db: Database.Database) {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  const { mainSchema, migrations } = splitSchema(schema);

  db.exec(mainSchema);
  applyMigrations(db, migrations);
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

function applyMigrations(db: Database.Database, migrations: Migration[]) {
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map(row => row.id),
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    const transaction = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id);
    });

    try {
      transaction();
    } catch (err: any) {
      if (err?.message?.includes('duplicate column name')) {
        console.warn(`  ⚠️ Migration ${migration.id} already appears applied; recording it.`);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(migration.id);
        continue;
      }
      throw err;
    }
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
    activeDbPath = undefined;
  }
}
