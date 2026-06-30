import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';

let dbPath: string;

describe('database migrations', () => {
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'agent-factory-migrations-')), 'test.db');
    process.env.DB_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('tracks applied schema migrations', () => {
    const db = getDb();
    const rows = db.all('SELECT id FROM schema_migrations ORDER BY id') as { id: string }[];
    expect(rows.map(row => row.id)).toContain('202604260001_add_workspace_path_to_tasks');
    expect(rows.map(row => row.id)).toContain('202604270001_add_operator_preferences');
    expect(rows.map(row => row.id)).toContain('202605100001_expand_operator_action_targets');
    expect(rows.map(row => row.id)).toContain('202606230001_add_domain_id_to_tasks');
    expect(rows.map(row => row.id)).toContain('202606240001_add_domain_id_to_pipelines');
    expect(rows.map(row => row.id)).toContain('202606280001_allow_pipeline_awaiting_retry_status');
    expect(rows.map(row => row.id)).toContain('202606280002_add_workspace_id_to_platform_events');
    expect(rows.map(row => row.id)).toContain('202606300001_add_execution_ledger');

    const columns = db.all('PRAGMA table_info(tasks)') as { name: string }[];
    expect(columns.map(column => column.name)).toContain('workspace_path');
    expect(columns.map(column => column.name)).toContain('domain_id');
    const pipelineColumns = db.all('PRAGMA table_info(pipelines)') as { name: string }[];
    expect(pipelineColumns.map(column => column.name)).toContain('domain_id');
    expect(() => {
      db.run(`
        INSERT INTO pipelines (id, name, status, stages, input)
        VALUES ('pipeline-awaiting-retry', 'Awaiting Retry', 'awaiting_retry', '[]', 'input')
      `);
    }).not.toThrow();
    const preferenceTables = db.all(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operator_preferences'
    `);
    expect(preferenceTables).toHaveLength(1);
    const platformEventColumns = db.all('PRAGMA table_info(platform_events)') as { name: string }[];
    expect(platformEventColumns.map(column => column.name)).toContain('workspace_id');
    const ledgerTables = db.all(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_ledger'
    `);
    expect(ledgerTables).toHaveLength(1);
  });

  it('does not re-run tracked migrations on restart', () => {
    getDb();
    closeDb();
    process.env.DB_PATH = dbPath;

    const db = getDb();
    const rows = db.all('SELECT id FROM schema_migrations') as { id: string }[];
    const ids = rows.map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('202604260001_add_workspace_path_to_tasks');
    expect(ids).toContain('202604270001_add_operator_preferences');
    expect(ids).toContain('202605100001_expand_operator_action_targets');
  });
});
