import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { markBudgetDispatched, reserveBudget, releaseUndispatchedBudget, setBudgetPolicy, settleUsage } from '../src/agents/budget-service.js';

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
    expect(rows.map(row => row.id)).toContain('202607300001_add_governed_publish_state');

    const columns = db.all('PRAGMA table_info(tasks)') as { name: string }[];
    expect(columns.map(column => column.name)).toContain('workspace_path');
    expect(columns.map(column => column.name)).toContain('domain_id');
    const pipelineColumns = db.all('PRAGMA table_info(pipelines)') as { name: string }[];
    expect(pipelineColumns.map(column => column.name)).toContain('domain_id');
    expect(pipelineColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'model_id', 'reasoning_effort', 'context_length',
    ]));
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
    const publishStateTables = db.all(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('publish_authorization_consumptions', 'wechat_draft_outputs')
      ORDER BY name
    `) as { name: string }[];
    expect(publishStateTables.map(row => row.name)).toEqual([
      'publish_authorization_consumptions',
      'wechat_draft_outputs',
    ]);
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

  it('upgrades an already-recorded workspace lifecycle without losing existing tasks or bindings', () => {
    const db = getDb();
    db.run(`INSERT INTO tasks(id,title,description,mode,input,status)
      VALUES ('upgrade-existing-task','Keep task','fixture','direct','fixture','done')`);
    db.run(`INSERT INTO workspace_execution_bindings
      (task_id,workspace_id,filesystem_workspace_id,execution_path,access_mode,baseline,created_at)
      VALUES ('upgrade-existing-task','default','existing-workspace','/fixture/source','shared_write','{}','fixture')`);
    const prior = db.get<{ applied_at: string }>(
      'SELECT applied_at FROM schema_migrations WHERE id=?', '202610110005_workspace_lifecycle',
    )!;
    // Only this test's temporary database: simulate the earlier installed schema.
    db.exec(`DROP TABLE workspace_preparation_requests;
      DELETE FROM schema_migrations WHERE id='202610130001_workspace_preparation_requests';`);
    closeDb();
    const upgraded = getDb();
    expect(upgraded.get("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_preparation_requests'")).toBeDefined();
    expect(upgraded.get('SELECT applied_at FROM schema_migrations WHERE id=?',
      '202610110005_workspace_lifecycle')).toEqual(prior);
    expect(upgraded.get('SELECT status FROM tasks WHERE id=?', 'upgrade-existing-task')).toEqual({ status: 'done' });
    expect(upgraded.get('SELECT execution_path FROM workspace_execution_bindings WHERE task_id=?',
      'upgrade-existing-task')).toEqual({ execution_path: '/fixture/source' });
    expect(upgraded.get('SELECT id FROM schema_migrations WHERE id=?',
      '202610130001_workspace_preparation_requests')).toBeDefined();
    upgraded.run('INSERT INTO workspace_preparation_requests(task_id,workspace_id,options) VALUES (?,?,?)',
      'upgrade-existing-task', 'default', '{"accessMode":"shared_write"}');
    closeDb();
    const reopened = getDb();
    expect(reopened.get('SELECT options FROM workspace_preparation_requests WHERE task_id=?',
      'upgrade-existing-task')).toEqual({ options: '{"accessMode":"shared_write"}' });
    expect(reopened.all('SELECT id FROM schema_migrations WHERE id=?',
      '202610130001_workspace_preparation_requests')).toHaveLength(1);
  });

  it('upgrades the recorded budget schema while preserving reservations, receipts and enforcement', () => {
    const db = getDb();
    setBudgetPolicy({ workspaceId: 'upgrade', scope: 'task', scopeId: 'task', period: 'lifetime', maxTokens: 400 });
    for (const key of ['reserved', 'settled', 'released']) {
      reserveBudget({ workspaceId: 'upgrade', taskId: 'task', agentId: 'dev', key, kind: 'model',
        tokens: 100, toolCalls: 0, runtimeMs: 0, costType: 'unavailable', costUSD: null });
    }
    settleUsage({ workspaceId: 'upgrade', key: 'settled', eventKey: 'receipt', tokens: 25,
      costType: 'unavailable', costUSD: null });
    releaseUndispatchedBudget('upgrade', 'released');
    const priorMigration = db.get('SELECT * FROM schema_migrations WHERE id=?', '202610070005_agent_persistent_budget');
    const reservations = db.all('SELECT * FROM agent_budget_reservations ORDER BY reservation_key');
    const receipts = db.all('SELECT * FROM agent_budget_receipts');
    const policies = db.all('SELECT * FROM agent_budget_policies');
    const currentSql = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_budget_reservations'",
    )!.sql;
    // Only this explicitly temporary database: reproduce the installed old CHECK.
    db.transaction(() => {
      db.exec(`ALTER TABLE agent_budget_reservations RENAME TO budget_fixture_old;
        ${currentSql.replace("'reserved','dispatched','settled','released'", "'reserved','settled','released'")};
        INSERT INTO agent_budget_reservations SELECT * FROM budget_fixture_old;
        DROP TABLE budget_fixture_old;
        CREATE INDEX idx_agent_budget_scope ON agent_budget_reservations(workspace_id, task_id, agent_id, period);
        DELETE FROM schema_migrations WHERE id='202610130002_budget_dispatch_status';`);
    });
    expect(() => markBudgetDispatched('upgrade', 'reserved')).toThrow('CHECK constraint failed');
    closeDb();
    const upgraded = getDb();
    expect(upgraded.all('SELECT * FROM agent_budget_reservations ORDER BY reservation_key')).toEqual(reservations);
    expect(upgraded.all('SELECT * FROM agent_budget_receipts')).toEqual(receipts);
    expect(upgraded.all('SELECT * FROM agent_budget_policies')).toEqual(policies);
    expect(upgraded.get('SELECT * FROM schema_migrations WHERE id=?',
      '202610070005_agent_persistent_budget')).toEqual(priorMigration);
    expect(() => markBudgetDispatched('upgrade', 'reserved')).not.toThrow();
    releaseUndispatchedBudget('upgrade', 'reserved');
    expect(upgraded.get('SELECT status FROM agent_budget_reservations WHERE reservation_key=?',
      'reserved')).toEqual({ status: 'dispatched' });
    expect(upgraded.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_budget_scope'")).toBeDefined();
    expect(() => upgraded.run("UPDATE agent_budget_reservations SET status='unknown'")).toThrow('CHECK constraint failed');
    closeDb();
    const reopened = getDb();
    expect(reopened.all('SELECT id FROM schema_migrations WHERE id=?',
      '202610130002_budget_dispatch_status')).toHaveLength(1);
    expect(reopened.get('SELECT status FROM agent_budget_reservations WHERE reservation_key=?',
      'reserved')).toEqual({ status: 'dispatched' });
    settleUsage({ workspaceId: 'upgrade', key: 'reserved', eventKey: 'post-upgrade', tokens: 35,
      costType: 'unavailable', costUSD: null });
    expect(reopened.get('SELECT status,observed_tokens FROM agent_budget_reservations WHERE reservation_key=?',
      'reserved')).toEqual({ status: 'settled', observed_tokens: 35 });
  });

  it('adds governed publish tables to databases that already applied the execution ledger migration', () => {
    const db = getDb();
    db.exec(`
      DROP TABLE publish_authorization_consumptions;
      DROP TABLE wechat_draft_outputs;
      DELETE FROM schema_migrations WHERE id = '202607300001_add_governed_publish_state';
    `);
    expect(
      (db.all(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('publish_authorization_consumptions', 'wechat_draft_outputs')
      `) as { name: string }[]),
    ).toHaveLength(0);

    closeDb();
    process.env.DB_PATH = dbPath;
    const upgraded = getDb();
    const migrationIds = upgraded.all('SELECT id FROM schema_migrations') as { id: string }[];
    expect(migrationIds.map(row => row.id)).toContain('202607300001_add_governed_publish_state');
    expect(migrationIds.map(row => row.id)).toContain('202606300001_add_execution_ledger');
    const tables = upgraded.all(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('publish_authorization_consumptions', 'wechat_draft_outputs')
    `) as { name: string }[];
    expect(tables).toHaveLength(2);
  });
});
