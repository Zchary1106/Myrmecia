import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRuntimeBenchmark, RUNTIME_V2_BENCHMARK_MATRIX, type RuntimeBenchmarkOutcome } from '../src/testing/runtime-benchmark.js';
const outcome = (): RuntimeBenchmarkOutcome => ({
  stopReason: 'completed', costUSD: null, durationMs: 1, humanInterventions: 0, evidenceRefs: ['artifact://fixture'],
  metrics: { requestCount: 1, modelTurnCount: null, toolCallCount: 0, inputTokens: null, outputTokens: null },
  criteria: [{ criterionId: 'outcome', verifier: 'artifact', required: true, scope: 'artifact', status: 'passed',
    message: 'Fixture proof', evidence: [{ ref: 'artifact://fixture', sha256: 'a'.repeat(64) }] }],
});
afterEach(() => delete process.env.MYRMECIA_RUNTIME_BENCHMARK_LIVE);
describe('separate fixture/live benchmark evidence', () => {
  it('preserves unknown costs and metrics, immutable inputs and explicit runner version', async () => {
    const report = await runRuntimeBenchmark({ mode: 'fixture', model: 'scripted', providerVersion: 'fixture-v1',
      cases: RUNTIME_V2_BENCHMARK_MATRIX, runner: async entry => { expect(Object.isFrozen(entry)).toBe(true); return outcome(); } });
    expect(report.passed).toBe(12);
    expect(report.cases[0].outcome.costUSD).toBeNull();
    expect(report.cases[0].outcome.metrics?.inputTokens).toBeNull();
    expect(report.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects model prose/completed stops without linked mandatory evidence', async () => {
    const report = await runRuntimeBenchmark({ mode: 'fixture', model: 'scripted', providerVersion: 'v1',
      cases: [RUNTIME_V2_BENCHMARK_MATRIX[0]], runner: async () => ({ ...outcome(), criteria: [], evidenceRefs: [] }) });
    expect(report.passed).toBe(0);
  });
  it('does not execute a live runner without explicit opt-in', async () => {
    const runner = vi.fn();
    await expect(runRuntimeBenchmark({ mode: 'live', model: 'configured', providerVersion: 'v1', cases: RUNTIME_V2_BENCHMARK_MATRIX, runner }))
      .rejects.toThrow('NOT_AUTHORIZED');
    expect(runner).not.toHaveBeenCalled();
  });
  it('records runner failure without pretending it cost zero and continues collecting the remaining cases', async () => {
    const report = await runRuntimeBenchmark({ mode: 'fixture', model: 'scripted', providerVersion: 'v2',
      cases: RUNTIME_V2_BENCHMARK_MATRIX.slice(0, 2),
      runner: async entry => { if (entry.id === 'long-context') throw new Error('fixture crash'); return outcome(); } });
    expect(report.passed).toBe(1);
    expect(report.cases[0].outcome).toMatchObject({ stopReason: 'failed', costUSD: null });
  });
});
