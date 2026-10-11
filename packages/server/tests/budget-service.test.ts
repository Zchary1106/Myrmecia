import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/db/database.js';
import { markBudgetDispatched, reserveBudget, releaseUndispatchedBudget, setBudgetPolicy, settleUsage, type BudgetReservation } from '../src/agents/budget-service.js';
beforeEach(() => { process.env.DB_PATH = ':memory:'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; });
const reserve = (key: string, extra: Partial<BudgetReservation> = {}, now?: number) => reserveBudget({
  workspaceId: 'w', taskId: 't', agentId: 'a', key, kind: 'model', tokens: 100, toolCalls: 0, runtimeMs: 0,
  costType: 'unavailable', costUSD: null, ...extra,
}, now);
describe('persistent atomic budget authority', () => {
  it('deduplicates reservations, rolls back rejected dispatches and prevents concurrent oversubscription', () => {
    setBudgetPolicy({ workspaceId: 'w', scope: 'task', scopeId: 't', period: 'lifetime', maxTokens: 150 });
    reserve('1'); reserve('1');
    expect(() => reserve('2')).toThrow('EXHAUSTED');
    expect(getDb().all('SELECT * FROM agent_budget_reservations')).toHaveLength(1);
    expect(() => reserve('1', { tokens: 1 })).toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('reports unknown tokens/cost as null while retaining conservative allowance, never as free usage', () => {
    reserve('1');
    settleUsage({ workspaceId: 'w', key: '1', eventKey: 'receipt', tokens: null, costUSD: null, costType: 'subscription' });
    expect(getDb().get<any>('SELECT * FROM agent_budget_reservations')).toMatchObject({ observed_tokens: null, observed_cost_usd: null, tokens: 100 });
    setBudgetPolicy({ workspaceId: 'w', scope: 'task', scopeId: 't', period: 'lifetime', maxTokens: 150 });
    expect(() => reserve('2')).toThrow('EXHAUSTED');
  });
  it('settles duplicate, delta and cumulative receipts without charging cumulative usage twice', () => {
    reserve('1');
    const receipt = { workspaceId: 'w', key: '1', eventKey: 'receipt1', mode: 'cumulative' as const, tokens: 20, costUSD: null, costType: 'unavailable' as const };
    settleUsage(receipt); settleUsage(receipt);
    settleUsage({ ...receipt, eventKey: 'receipt2', tokens: 30 });
    settleUsage({ ...receipt, eventKey: 'receipt3', mode: 'delta', tokens: 5 });
    expect(getDb().get<any>('SELECT observed_tokens FROM agent_budget_reservations').observed_tokens).toBe(35);
    expect(() => settleUsage({ ...receipt, tokens: 40 })).toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('blocks a hard USD cap for unpriced usage, subscription or unknown billing without forcing credentials', () => {
    setBudgetPolicy({ workspaceId: 'w', scope: 'workspace', scopeId: 'w', period: 'utc_day', maxCostUSD: 1 });
    expect(() => reserve('unpriced')).toThrow('UNCERTAIN');
    expect(() => reserve('subscription', { costType: 'subscription' })).toThrow('UNCERTAIN');
    reserve('priced', { costType: 'estimated', costUSD: 0.5 });
    expect(() => reserve('over', { costType: 'estimated', costUSD: 0.6 })).toThrow('EXHAUSTED');
  });
  it('keeps task totals across UTC day transitions while workspace daily budgets reset only by period', () => {
    setBudgetPolicy({ workspaceId: 'w', scope: 'workspace', scopeId: 'w', period: 'utc_day', maxTokens: 100 });
    reserve('1', {}, Date.parse('2026-10-07T23:59:59Z'));
    reserve('2', {}, Date.parse('2026-10-08T00:00:01Z'));
    setBudgetPolicy({ workspaceId: 'w', scope: 'task', scopeId: 't', period: 'lifetime', maxTokens: 200 });
    expect(() => reserve('3', {}, Date.parse('2026-10-08T00:00:02Z'))).toThrow('EXHAUSTED');
  });
  it('does not release an in-flight unknown outcome and preserves budgets after DB reconnect', () => {
    closeDb();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-budget-test-')), 'test.sqlite');
    setBudgetPolicy({ workspaceId: 'w', scope: 'agent', scopeId: 'a', period: 'lifetime', maxTokens: 150 });
    reserve('1'); markBudgetDispatched('w', '1');
    releaseUndispatchedBudget('w', '1');
    closeDb();
    expect(() => reserve('2')).toThrow('EXHAUSTED');
    expect(getDb().get<any>('SELECT status FROM agent_budget_reservations').status).toBe('dispatched');
  });
});
