import { describe, it, expect } from 'vitest';
import { guardrails } from '../src/agents/safety-guardrails.js';

describe('SafetyGuardrails', () => {
  it('should allow operations in autoApprove list', () => {
    const result = guardrails.checkOperation('install_npm_package');
    expect(result.allowed).toBe(true);
  });

  it('should block operations in requireApproval list', () => {
    const result = guardrails.checkOperation('deploy_to_production');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('supervisor approval');
  });

  it('should block deployment when disabled', () => {
    const result = guardrails.checkOperation('deploy');
    expect(result.allowed).toBe(false);
  });

  it('should block force push when git history modification disabled', () => {
    const result = guardrails.checkOperation('force_push');
    expect(result.allowed).toBe(false);
  });

  it('should allow unknown operations by default', () => {
    const result = guardrails.checkOperation('some_random_operation');
    expect(result.allowed).toBe(true);
  });

  it('should track and check budget', () => {
    const initial = guardrails.checkBudget();
    expect(initial.allowed).toBe(true);
    expect(initial.remaining).toBe(20); // default $20

    guardrails.trackCost('task1', 2.5);
    const after = guardrails.checkBudget();
    expect(after.remaining).toBe(17.5);
  });

  it('should reject when per-task cost exceeds limit', () => {
    const result = guardrails.checkBudget(10); // $10 > $5 limit
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('per-task limit');
  });

  it('should return cost summary', () => {
    const summary = guardrails.getCostSummary();
    expect(summary).toHaveProperty('dailyCost');
    expect(summary).toHaveProperty('dailyBudget');
    expect(summary).toHaveProperty('percentUsed');
  });

  it('should allow config updates', () => {
    guardrails.updateConfig({ maxCostPerDay: 50 });
    const config = guardrails.getConfig();
    expect(config.maxCostPerDay).toBe(50);

    // Reset for other tests
    guardrails.updateConfig({ maxCostPerDay: 20 });
  });
});
