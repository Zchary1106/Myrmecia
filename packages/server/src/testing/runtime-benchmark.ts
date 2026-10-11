import { createHash } from 'node:crypto';
import type { CompletionCriterionResult, AgentStopReason, TurnMetrics, ModelCostType } from '@myrmecia/shared';
export interface RuntimeBenchmarkCase {
  id: string; category: string; input: string;
}
export interface RuntimeBenchmarkOutcome {
  stopReason: AgentStopReason; criteria: CompletionCriterionResult[]; metrics: TurnMetrics | null;
  costUSD: number | null; durationMs: number; humanInterventions: number; evidenceRefs: string[];
  provider?: string; actualModelId?: string; costType?: ModelCostType;
}
export interface RuntimeBenchmarkReport {
  schemaVersion: 1; mode: 'fixture' | 'live'; model: string; providerVersion: string;
  inputFingerprint: string; passed: number; cases: Array<{ id: string; category: string; passed: boolean; outcome: RuntimeBenchmarkOutcome }>;
}
/** Runner identity is mandatory. Fixture scores are never included in live success rates. */
export async function runRuntimeBenchmark(options: {
  mode: 'fixture' | 'live'; model: string; providerVersion: string;
  cases: RuntimeBenchmarkCase[]; runner: (entry: RuntimeBenchmarkCase) => Promise<RuntimeBenchmarkOutcome>;
}): Promise<RuntimeBenchmarkReport> {
  if (options.mode === 'live' && process.env.MYRMECIA_RUNTIME_BENCHMARK_LIVE !== 'true') throw new Error('LIVE_BENCHMARK_NOT_AUTHORIZED');
  if (!options.model || !options.providerVersion || !options.cases.length
    || new Set(options.cases.map(item => item.id)).size !== options.cases.length) throw new Error('BENCHMARK_CONFIG_INVALID');
  const cases = [];
  for (const entry of options.cases) {
    let outcome: RuntimeBenchmarkOutcome;
    try { outcome = await options.runner(Object.freeze({ ...entry })); }
    catch {
      outcome = { stopReason: 'failed', criteria: [], costUSD: null, durationMs: 0, humanInterventions: 0, evidenceRefs: [],
        metrics: null };
    }
    const required = outcome.criteria.filter(item => item.required);
    const passed = outcome.stopReason === 'completed' && required.length > 0
      && required.every(item => item.status === 'passed' && item.evidence.length > 0)
      && outcome.evidenceRefs.length > 0;
    cases.push({ id: entry.id, category: entry.category, passed, outcome });
  }
  return { schemaVersion: 1, mode: options.mode, model: options.model, providerVersion: options.providerVersion,
    inputFingerprint: createHash('sha256').update(JSON.stringify(options.cases)).digest('hex'),
    passed: cases.filter(item => item.passed).length, cases };
}

export const RUNTIME_V2_BENCHMARK_MATRIX = [
  ['long-context', 'context', 'tests/runtime-v2-baseline.test.ts'],
  ['multi-tool-conflicts', 'scheduler', 'tests/tool-scheduler.test.ts'],
  ['steering', 'inbox', 'tests/session-harness.test.ts'],
  ['follow-up', 'continuation', 'tests/session-harness.test.ts'],
  ['crash-recovery', 'ownership', 'tests/runtime-owner-process.test.ts'],
  ['persistent-budget', 'budget', 'tests/budget-service.test.ts'],
  ['unknown-writes', 'replay', 'tests/loop-checkpoint.test.ts'],
  ['mcp-timeout', 'mcp', 'tests/runtime-v2-baseline.test.ts'],
  ['attachments', 'knowledge', 'tests/session-documents.test.ts'],
  ['cross-workspace', 'scope', 'tests/agent-session-event.test.ts'],
  ['artifact-verification', 'completion', 'tests/completion-gate.test.ts'],
  ['acceptance-rejection', 'acceptance', 'tests/execution-acceptance.test.ts'],
].map(([id, category, input]) => ({ id, category, input }));
