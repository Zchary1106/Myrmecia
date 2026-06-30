import { describe, expect, it } from 'vitest';
import {
  HARNESS_SCENARIOS,
  scoreScenario,
  runHarnessEval,
  createDeterministicRunner,
  type HarnessScenario,
} from '../src/testing/harness-eval.js';

const scenario: HarnessScenario = {
  id: 's1',
  title: 'Demo',
  category: 'engineering',
  prompt: 'do a thing',
  expectSubstrings: ['plan'],
  maxCostUSD: 0.1,
  maxDurationMs: 5000,
};

describe('harness eval', () => {
  it('scores a passing outcome', () => {
    const result = scoreScenario(scenario, {
      output: 'Here is the plan.', costUSD: 0.02, durationMs: 800, toolCalls: 1, numTurns: 2, humanInterventions: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails on missing expected text, cost, duration, and error', () => {
    const missing = scoreScenario(scenario, { output: 'nope', costUSD: 0.02, durationMs: 100, toolCalls: 0, numTurns: 1, humanInterventions: 0 });
    expect(missing.passed).toBe(false);
    expect(missing.failures.join(' ')).toContain('missing expected text');

    const overCost = scoreScenario(scenario, { output: 'plan', costUSD: 1, durationMs: 100, toolCalls: 0, numTurns: 1, humanInterventions: 0 });
    expect(overCost.failures.join(' ')).toContain('exceeds max');

    const overTime = scoreScenario(scenario, { output: 'plan', costUSD: 0.01, durationMs: 999999, toolCalls: 0, numTurns: 1, humanInterventions: 0 });
    expect(overTime.failures.join(' ')).toContain('exceeds max');

    const errored = scoreScenario(scenario, { output: '', costUSD: 0, durationMs: 0, toolCalls: 0, numTurns: 0, humanInterventions: 0, error: 'boom' });
    expect(errored.failures.join(' ')).toContain('error: boom');
  });

  it('runs the deterministic baseline at 100% success with aggregate metrics', async () => {
    const report = await runHarnessEval(createDeterministicRunner(), HARNESS_SCENARIOS, 'deterministic');
    expect(report.scenarioCount).toBe(HARNESS_SCENARIOS.length);
    expect(report.passed).toBe(HARNESS_SCENARIOS.length);
    expect(report.successRate).toBe(1);
    expect(report.avgCostUSD).toBeGreaterThan(0);
    expect(report.avgDurationMs).toBeGreaterThan(0);
    expect(report.totalHumanInterventions).toBe(0);
  });

  it('reflects forced failures and human interventions in the report', async () => {
    const report = await runHarnessEval(
      createDeterministicRunner({ failScenarioIds: ['feature-spec', 'qa-report'] }),
      HARNESS_SCENARIOS,
      'deterministic',
    );
    expect(report.passed).toBe(HARNESS_SCENARIOS.length - 2);
    expect(report.successRate).toBeLessThan(1);
    expect(report.totalHumanInterventions).toBe(2);
    const failed = report.results.filter(r => !r.passed).map(r => r.scenarioId).sort();
    expect(failed).toEqual(['feature-spec', 'qa-report']);
  });

  it('captures a thrown runner error as a failed scenario', async () => {
    const report = await runHarnessEval(async () => { throw new Error('runner exploded'); }, [scenario], 'broken');
    expect(report.successRate).toBe(0);
    expect(report.results[0].failures.join(' ')).toContain('runner exploded');
  });
});
