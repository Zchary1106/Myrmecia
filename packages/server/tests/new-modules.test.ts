import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Test DB Setup ----------

let db: Database.Database;

function initTestDb(): Database.Database {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf-8');
  db.exec(schema);
  return db;
}

/** Creates a DbDriver-compatible wrapper around a raw Database */
function wrapDb(raw: Database.Database) {
  return {
    backend: 'sqlite' as const,
    all: (sql: string, ...params: any[]) => raw.prepare(sql).all(...params),
    get: (sql: string, ...params: any[]) => raw.prepare(sql).get(...params),
    run: (sql: string, ...params: any[]) => {
      const r = raw.prepare(sql).run(...params);
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    exec: (sql: string) => raw.exec(sql),
    transaction: (fn: () => any) => raw.transaction(fn)(),
    close: () => raw.close(),
  };
}

// ========== DLP Tests (pure functions, no DB needed) ==========

describe('DLP — scanForPII', () => {
  let scanForPII: typeof import('../src/security/dlp.js').scanForPII;

  beforeEach(async () => {
    const mod = await import('../src/security/dlp.js');
    scanForPII = mod.scanForPII;
  });

  it('should detect email addresses', () => {
    const result = scanForPII('Contact us at user@example.com');
    expect(result.clean).toBe(false);
    expect(result.violations.some(v => v.type === 'email')).toBe(true);
  });

  it('should detect US phone numbers', () => {
    const result = scanForPII('Call me at 555-123-4567');
    expect(result.clean).toBe(false);
    expect(result.violations.some(v => v.type === 'phone_us')).toBe(true);
  });

  it('should detect SSN and redact it', () => {
    const result = scanForPII('My SSN is 123-45-6789');
    expect(result.clean).toBe(false);
    expect(result.violations.some(v => v.type === 'ssn')).toBe(true);
    expect(result.redactedContent).toContain('[REDACTED:ssn]');
    expect(result.redactedContent).not.toContain('123-45-6789');
  });

  it('should detect credit card numbers', () => {
    const result = scanForPII('Card: 4111-1111-1111-1111');
    expect(result.clean).toBe(false);
    expect(result.violations.some(v => v.type === 'credit_card')).toBe(true);
  });

  it('should detect API keys and block', () => {
    const result = scanForPII('Use key sk_abcdefghijklmnopqrstuvwxyz1234');
    expect(result.clean).toBe(false);
    const apiViolation = result.violations.find(v => v.type === 'api_key');
    expect(apiViolation).toBeDefined();
    expect(apiViolation!.action).toBe('block');
    expect(result.redactedContent).toBeUndefined();
  });

  it('should return clean for safe content', () => {
    const result = scanForPII('This is perfectly safe content with no PII.');
    expect(result.clean).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ========== Audit Tests ==========

describe('Audit — recordAudit + chain integrity', () => {
  let recordAudit: typeof import('../src/security/dlp.js').recordAudit;
  let queryAuditLog: typeof import('../src/security/dlp.js').queryAuditLog;

  beforeEach(async () => {
    db = initTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        actor_id TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        metadata JSON NOT NULL DEFAULT '{}',
        outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success','failure','blocked')),
        prev_hash TEXT NOT NULL DEFAULT '',
        entry_hash TEXT NOT NULL DEFAULT ''
      );
    `);
    const wrapped = wrapDb(db);
    vi.resetModules();
    vi.doMock('../src/db/database.js', () => ({ getDb: () => wrapped }));
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
    const mod = await import('../src/security/dlp.js');
    recordAudit = mod.recordAudit;
    queryAuditLog = mod.queryAuditLog;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (db) db.close();
  });

  it('should record an audit entry and retrieve it', () => {
    const entry = recordAudit({
      actorId: 'user1', actorType: 'user', action: 'task.create',
      resourceType: 'task', resourceId: 'task_001', workspaceId: 'ws_test',
      metadata: { title: 'Test' }, outcome: 'success',
    });
    expect(entry.id).toMatch(/^audit_/);
    const entries = queryAuditLog({ workspaceId: 'ws_test' });
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('should maintain hash chain integrity', () => {
    recordAudit({ actorId: 'u1', actorType: 'user', action: 'a1', resourceType: 'r', resourceId: 'r1', workspaceId: 'ws', metadata: {}, outcome: 'success' });
    recordAudit({ actorId: 'u2', actorType: 'agent', action: 'a2', resourceType: 'r', resourceId: 'r2', workspaceId: 'ws', metadata: {}, outcome: 'success' });

    const rows = db.prepare('SELECT * FROM audit_log ORDER BY rowid ASC').all() as any[];
    expect(rows.length).toBe(2);
    const zeroHash = '0000000000000000000000000000000000000000000000000000000000000000';
    expect(rows[0].prev_hash).toBe(zeroHash);
    expect(rows[1].prev_hash).toBe(rows[0].entry_hash);

    const payload = `${rows[0].prev_hash}|${rows[0].id}|${rows[0].timestamp}|${rows[0].action}|${rows[0].actor_id}|${rows[0].resource_type}:${rows[0].resource_id}|${rows[0].outcome}`;
    const computed = createHash('sha256').update(payload).digest('hex');
    expect(rows[0].entry_hash).toBe(computed);
  });

  it('should filter audit entries by action', () => {
    recordAudit({ actorId: 'u1', actorType: 'user', action: 'task.create', resourceType: 'task', resourceId: 't1', workspaceId: 'ws', metadata: {}, outcome: 'success' });
    recordAudit({ actorId: 'u1', actorType: 'user', action: 'task.delete', resourceType: 'task', resourceId: 't2', workspaceId: 'ws', metadata: {}, outcome: 'success' });
    const creates = queryAuditLog({ action: 'task.create' });
    expect(creates.length).toBe(1);
  });
});

// ========== Plugin Registry Tests ==========

describe('Plugin Registry', () => {
  let PluginRegistry: typeof import('../src/plugins/registry.js').PluginRegistry;

  beforeEach(async () => {
    db = initTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS installed_plugins (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        manifest JSON NOT NULL, status TEXT NOT NULL DEFAULT 'installed' CHECK(status IN ('installed','enabled','disabled','error')),
        source_url TEXT, error TEXT, installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(plugin_id, workspace_id)
      );
    `);
    const wrapped = wrapDb(db);
    vi.doMock('../src/db/database.js', () => ({ getDb: () => wrapped }));
    const mod = await import('../src/plugins/registry.js');
    PluginRegistry = mod.PluginRegistry;
  });

  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); if (db) db.close(); });

  const manifest = { id: 'test-plugin', name: 'Test Plugin', version: '1.0.0', capabilities: ['tools' as const], entry: './index.js' };

  it('should install a plugin', () => {
    const reg = new PluginRegistry();
    const p = reg.install('ws1', manifest);
    expect(p.pluginId).toBe('test-plugin');
    expect(p.status).toBe('installed');
  });

  it('should enable a plugin', () => {
    const reg = new PluginRegistry();
    reg.install('ws1', manifest);
    expect(reg.enable('ws1', 'test-plugin')?.status).toBe('enabled');
  });

  it('should disable a plugin', () => {
    const reg = new PluginRegistry();
    reg.install('ws1', manifest);
    reg.enable('ws1', 'test-plugin');
    expect(reg.disable('ws1', 'test-plugin')?.status).toBe('disabled');
  });

  it('should uninstall a plugin', () => {
    const reg = new PluginRegistry();
    reg.install('ws1', manifest);
    expect(reg.uninstall('ws1', 'test-plugin')).toBe(true);
    expect(reg.get('ws1', 'test-plugin')).toBeUndefined();
  });
});

// ========== API Keys Tests ==========

describe('API Keys', () => {
  let createApiKey: typeof import('../src/auth/api-keys.js').createApiKey;
  let validateApiKey: typeof import('../src/auth/api-keys.js').validateApiKey;
  let revokeApiKey: typeof import('../src/auth/api-keys.js').revokeApiKey;

  beforeEach(async () => {
    db = initTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT '[]',
        expires_at DATETIME, last_used_at DATETIME, revoked_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const wrapped = wrapDb(db);
    vi.doMock('../src/db/database.js', () => ({ getDb: () => wrapped }));
    const mod = await import('../src/auth/api-keys.js');
    createApiKey = mod.createApiKey;
    validateApiKey = mod.validateApiKey;
    revokeApiKey = mod.revokeApiKey;
  });

  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); if (db) db.close(); });

  it('should create an API key with plaintext', () => {
    const key = createApiKey({ workspaceId: 'ws1', name: 'test-key', scopes: ['read:tasks'] });
    expect(key.plaintext).toMatch(/^af_/);
    expect(key.scopes).toContain('read:tasks');
  });

  it('should validate a valid API key', () => {
    const key = createApiKey({ workspaceId: 'ws1', name: 'val-test' });
    const v = validateApiKey(key.plaintext);
    expect(v).not.toBeNull();
    expect(v!.name).toBe('val-test');
  });

  it('should reject a revoked API key', () => {
    const key = createApiKey({ workspaceId: 'ws1', name: 'rev-test' });
    revokeApiKey(key.id, 'ws1');
    expect(validateApiKey(key.plaintext)).toBeNull();
  });
});

// ========== Usage & Budget Tests ==========

describe('Usage & Budget', () => {
  let getUsageSummary: typeof import('../src/billing/usage.js').getUsageSummary;
  let setBudget: typeof import('../src/billing/usage.js').setBudget;
  let getBudgetStatus: typeof import('../src/billing/usage.js').getBudgetStatus;

  beforeEach(async () => {
    db = initTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_budgets (
        workspace_id TEXT PRIMARY KEY, monthly_limit_usd REAL NOT NULL DEFAULT 100.0,
        alert_threshold_percent INTEGER NOT NULL DEFAULT 80,
        on_exhausted TEXT NOT NULL DEFAULT 'alert_only' CHECK(on_exhausted IN ('block','downgrade','alert_only')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const wrapped = wrapDb(db);
    vi.doMock('../src/db/database.js', () => ({ getDb: () => wrapped }));
    // Mock eventBus
    vi.doMock('../src/events/event-bus.js', () => ({ eventBus: { emit: () => {}, on: () => {}, off: () => {} } }));
    const mod = await import('../src/billing/usage.js');
    getUsageSummary = mod.getUsageSummary;
    setBudget = mod.setBudget;
    getBudgetStatus = mod.getBudgetStatus;
  });

  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); if (db) db.close(); });

  it('should return zero usage when no data exists', () => {
    const summary = getUsageSummary({});
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalCostUSD).toBe(0);
  });

  it('should return usage after inserting stats', () => {
    // Insert a model so FK is satisfied, then insert usage
    db.exec(`INSERT OR IGNORE INTO model_registry (id, display_name, provider) VALUES ('gpt-4o', 'GPT-4o', 'openai')`);
    db.exec(`INSERT INTO model_usage_stats (model_id, status, input_tokens, output_tokens, cost_usd, created_at) VALUES ('gpt-4o', 'success', 100, 50, 0.01, datetime('now'))`);
    const summary = getUsageSummary({});
    expect(summary.totalInputTokens).toBe(100);
    expect(summary.totalOutputTokens).toBe(50);
  });

  it('should set and get budget status', () => {
    setBudget({ workspaceId: 'ws_test', monthlyLimitUSD: 50, alertThresholdPercent: 80, onExhausted: 'block' });
    const status = getBudgetStatus('ws_test');
    expect(status.limitUSD).toBe(50);
    expect(status.action).toBe('block');
  });
});

// ========== Smart Router Test ==========

describe('Smart Router', () => {
  it('should route to a model based on complexity', async () => {
    const { SmartRouter } = await import('../src/models/smart-router.js');
    const router = new SmartRouter();
    const result = router.route({ prompt: 'Hello', priority: 'low' });
    expect(result.modelId).toBeDefined();
    expect(result.estimatedCostUSD).toBeGreaterThanOrEqual(0);
    expect(result.reason).toContain('complexity=');
  });
});

// ========== A2A Protocol Test ==========

describe('A2A Protocol', () => {
  let A2AProtocol: typeof import('../src/agents/a2a-protocol.js').A2AProtocol;

  beforeEach(async () => {
    db = initTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS a2a_messages (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, from_agent_id TEXT NOT NULL,
        from_execution_id TEXT, to_agent_id TEXT NOT NULL, to_execution_id TEXT,
        correlation_id TEXT, payload JSON NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'pending', expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, delivered_at DATETIME
      );
    `);
    const wrapped = wrapDb(db);
    vi.doMock('../src/db/database.js', () => ({ getDb: () => wrapped }));
    vi.doMock('../src/events/event-bus.js', () => ({ eventBus: { emit: () => {}, on: () => {}, off: () => {} } }));
    const mod = await import('../src/agents/a2a-protocol.js');
    A2AProtocol = mod.A2AProtocol;
  });

  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); if (db) db.close(); });

  it('should send and receive a delegation message', () => {
    const protocol = new A2AProtocol();
    const msg = protocol.delegate('agent_a', 'agent_b', 'Do some work');
    expect(msg.id).toMatch(/^a2a_/);
    expect(msg.type).toBe('delegate');
    const received = protocol.receive('agent_b');
    expect(received.length).toBeGreaterThanOrEqual(1);
  });
});

// ========== Benchmark Test ==========

describe('Benchmark', () => {
  it('should run benchmarks and return a report', async () => {
    const { runBenchmarks } = await import('../src/testing/benchmark.js');
    const report = await runBenchmarks();
    expect(report.results.length).toBeGreaterThanOrEqual(3);
    for (const r of report.results) {
      expect(r.opsPerSec).toBeGreaterThan(0);
      expect(r.p50Ms).toBeGreaterThanOrEqual(0);
    }
  });
});

// ========== Test Utilities ==========

describe('Test Utilities', () => {
  it('should create a test db with schema', async () => {
    const { createTestDb } = await import('../src/testing/module-tests.js');
    const testDb = createTestDb();
    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    expect(tables.map((t: any) => t.name)).toContain('agents');
    testDb.close();
  });

  it('should create mock tenant context', async () => {
    const { createMockTenantContext } = await import('../src/testing/module-tests.js');
    const ctx = createMockTenantContext('viewer');
    expect(ctx.tenantContext.role).toBe('viewer');
    expect(ctx.tenantContext.workspaceId).toMatch(/^ws_/);
  });

  it('should seed test data', async () => {
    const { createTestDb, seedTestData } = await import('../src/testing/module-tests.js');
    const testDb = createTestDb();
    const data = seedTestData(testDb);
    expect(data.agents.length).toBe(3);
    expect(data.tasks.length).toBe(5);
    expect(data.executions.length).toBe(3);
    testDb.close();
  });
});
