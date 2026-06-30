import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { recordLedgerEntry, listLedgerEntries } from '../src/db/models/execution-ledger.js';

describe('execution ledger', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-ledger-')), 'test.db');
    getDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('records ordered ledger entries per execution', () => {
    recordLedgerEntry({ executionId: 'exec-1', taskId: 't1', agentId: 'dev', type: 'runtime.selected', decision: 'ts-agent-loop', summary: 'Selected TS loop' });
    recordLedgerEntry({ executionId: 'exec-1', taskId: 't1', agentId: 'dev', type: 'model.selected', decision: 'claude-haiku-4.5', summary: 'Model selected' });
    recordLedgerEntry({ executionId: 'exec-1', taskId: 't1', agentId: 'dev', type: 'execution.completed', decision: 'done', summary: 'Completed', metadata: { costUSD: 0.01 } });

    const entries = listLedgerEntries({ executionId: 'exec-1' });
    expect(entries).toHaveLength(3);
    expect(entries.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(entries.map(e => e.type)).toEqual(['runtime.selected', 'model.selected', 'execution.completed']);
    expect(entries[2].metadata.costUSD).toBe(0.01);
  });

  it('keeps sequences independent across executions', () => {
    recordLedgerEntry({ executionId: 'exec-a', type: 'runtime.selected', summary: 'a1' });
    recordLedgerEntry({ executionId: 'exec-b', type: 'runtime.selected', summary: 'b1' });
    recordLedgerEntry({ executionId: 'exec-a', type: 'model.selected', summary: 'a2' });

    expect(listLedgerEntries({ executionId: 'exec-a' }).map(e => e.seq)).toEqual([1, 2]);
    expect(listLedgerEntries({ executionId: 'exec-b' }).map(e => e.seq)).toEqual([1]);
  });

  it('filters by task and workspace', () => {
    recordLedgerEntry({ executionId: 'exec-1', taskId: 't1', workspaceId: 'ws-a', type: 'tool.executed', summary: 'x' });
    recordLedgerEntry({ executionId: 'exec-2', taskId: 't2', workspaceId: 'ws-b', type: 'tool.executed', summary: 'y' });

    expect(listLedgerEntries({ taskId: 't1' })).toHaveLength(1);
    expect(listLedgerEntries({ workspaceId: 'ws-b' })).toHaveLength(1);
    expect(listLedgerEntries({ workspaceId: 'ws-b' })[0].executionId).toBe('exec-2');
  });

  it('never throws on best-effort writes for unknown columns', () => {
    expect(() => recordLedgerEntry({ executionId: 'exec-9', type: 'retry', summary: 'ok' })).not.toThrow();
    expect(listLedgerEntries({ executionId: 'exec-9' })).toHaveLength(1);
  });
});
