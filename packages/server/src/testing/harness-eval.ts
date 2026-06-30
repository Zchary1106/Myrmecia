/**
 * Harness Eval — a deterministic way to measure how well the agent harness does
 * a fixed set of tasks. It runs each scenario through a pluggable runner and
 * scores success plus the operational metrics that matter for an Agent Ops
 * platform: success rate, cost, duration, tool calls, turns, and how often a
 * human had to step in.
 *
 * The default runner is deterministic (no model calls), so this doubles as a
 * regression harness in CI. A live runner can wrap AgentRuntime to benchmark a
 * real model/runtime combination.
 */
import { Router } from 'express';

export interface HarnessScenario {
  id: string;
  title: string;
  category: string;
  prompt: string;
  /** Substrings that must all appear in the output for the scenario to pass. */
  expectSubstrings?: string[];
  /** Optional cost ceiling (USD). Exceeding it fails the scenario. */
  maxCostUSD?: number;
  /** Optional wall-clock ceiling (ms). Exceeding it fails the scenario. */
  maxDurationMs?: number;
}

export interface HarnessRunOutcome {
  output: string;
  costUSD: number;
  durationMs: number;
  toolCalls: number;
  numTurns: number;
  humanInterventions: number;
  error?: string;
}

export type HarnessRunner = (scenario: HarnessScenario) => Promise<HarnessRunOutcome>;

export interface HarnessScenarioResult {
  scenarioId: string;
  title: string;
  category: string;
  passed: boolean;
  failures: string[];
  outcome: HarnessRunOutcome;
}

export interface HarnessEvalReport {
  timestamp: string;
  runner: string;
  scenarioCount: number;
  passed: number;
  successRate: number;
  avgCostUSD: number;
  avgDurationMs: number;
  avgToolCalls: number;
  avgTurns: number;
  totalHumanInterventions: number;
  results: HarnessScenarioResult[];
}

// ---------- Default scenario set ----------

export const HARNESS_SCENARIOS: HarnessScenario[] = [
  {
    id: 'feature-spec',
    title: 'Write a feature spec',
    category: 'engineering',
    prompt: 'Write a brief product spec for adding CSV export to the reports dashboard.',
    expectSubstrings: ['spec'],
    maxCostUSD: 0.5,
  },
  {
    id: 'bug-triage',
    title: 'Triage a bug',
    category: 'engineering',
    prompt: 'Users cannot save settings when the workspace name contains spaces. Triage the root cause.',
    expectSubstrings: ['root cause'],
    maxCostUSD: 0.5,
  },
  {
    id: 'qa-report',
    title: 'Produce a QA report',
    category: 'quality',
    prompt: 'Validate the template gallery API and produce a test report.',
    expectSubstrings: ['test report'],
    maxCostUSD: 0.5,
  },
  {
    id: 'web-research',
    title: 'Summarize research with citations',
    category: 'research',
    prompt: 'Research the trade-offs of SQLite vs Postgres for a local-first app and cite sources.',
    expectSubstrings: ['sources'],
    maxCostUSD: 0.75,
  },
  {
    id: 'refactor-plan',
    title: 'Plan a refactor',
    category: 'engineering',
    prompt: 'Plan a refactor of the task queue to support durable retries with idempotency.',
    expectSubstrings: ['plan'],
    maxCostUSD: 0.5,
  },
];

// ---------- Scoring ----------

export function scoreScenario(scenario: HarnessScenario, outcome: HarnessRunOutcome): HarnessScenarioResult {
  const failures: string[] = [];
  if (outcome.error) failures.push(`error: ${outcome.error}`);
  const lower = (outcome.output || '').toLowerCase();
  for (const needle of scenario.expectSubstrings || []) {
    if (!lower.includes(needle.toLowerCase())) failures.push(`missing expected text: "${needle}"`);
  }
  if (scenario.maxCostUSD !== undefined && outcome.costUSD > scenario.maxCostUSD) {
    failures.push(`cost ${outcome.costUSD} exceeds max ${scenario.maxCostUSD}`);
  }
  if (scenario.maxDurationMs !== undefined && outcome.durationMs > scenario.maxDurationMs) {
    failures.push(`duration ${outcome.durationMs}ms exceeds max ${scenario.maxDurationMs}ms`);
  }
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    category: scenario.category,
    passed: failures.length === 0,
    failures,
    outcome,
  };
}

// ---------- Runner ----------

export async function runHarnessEval(
  runner: HarnessRunner,
  scenarios: HarnessScenario[] = HARNESS_SCENARIOS,
  runnerName = 'custom',
): Promise<HarnessEvalReport> {
  const results: HarnessScenarioResult[] = [];
  for (const scenario of scenarios) {
    let outcome: HarnessRunOutcome;
    try {
      outcome = await runner(scenario);
    } catch (err: any) {
      outcome = { output: '', costUSD: 0, durationMs: 0, toolCalls: 0, numTurns: 0, humanInterventions: 0, error: err?.message || String(err) };
    }
    results.push(scoreScenario(scenario, outcome));
  }

  const n = results.length || 1;
  const sum = (pick: (r: HarnessScenarioResult) => number) => results.reduce((acc, r) => acc + pick(r), 0);
  const passed = results.filter(r => r.passed).length;

  return {
    timestamp: new Date().toISOString(),
    runner: runnerName,
    scenarioCount: results.length,
    passed,
    successRate: results.length ? passed / results.length : 0,
    avgCostUSD: round(sum(r => r.outcome.costUSD) / n, 6),
    avgDurationMs: Math.round(sum(r => r.outcome.durationMs) / n),
    avgToolCalls: round(sum(r => r.outcome.toolCalls) / n, 2),
    avgTurns: round(sum(r => r.outcome.numTurns) / n, 2),
    totalHumanInterventions: sum(r => r.outcome.humanInterventions),
    results,
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * A deterministic, model-free runner. It echoes the scenario's expected
 * substrings so passing scenarios stay green, and produces stable cost/duration
 * metrics. Pass `failScenarioIds` to force specific scenarios to fail (used to
 * exercise scoring and regression detection).
 */
export function createDeterministicRunner(options?: {
  failScenarioIds?: string[];
  baseCostUSD?: number;
  baseDurationMs?: number;
}): HarnessRunner {
  const failSet = new Set(options?.failScenarioIds || []);
  const baseCost = options?.baseCostUSD ?? 0.012;
  const baseDuration = options?.baseDurationMs ?? 800;
  return async (scenario) => {
    if (failSet.has(scenario.id)) {
      return { output: 'incomplete', costUSD: baseCost, durationMs: baseDuration, toolCalls: 1, numTurns: 1, humanInterventions: 1 };
    }
    const output = [
      `Deterministic harness output for "${scenario.title}".`,
      ...(scenario.expectSubstrings || []),
    ].join(' ');
    return {
      output,
      costUSD: baseCost,
      durationMs: baseDuration,
      toolCalls: scenario.category === 'research' ? 2 : 1,
      numTurns: 2,
      humanInterventions: 0,
    };
  };
}

// ---------- Routes ----------

export function createHarnessRoutes(): Router {
  const router = Router();

  // GET /harness/scenarios — list the built-in scenario set
  router.get('/scenarios', (_req, res) => {
    res.json(HARNESS_SCENARIOS);
  });

  // POST /harness/eval — run the deterministic baseline eval (no model calls)
  router.post('/eval', async (_req, res) => {
    try {
      const report = await runHarnessEval(createDeterministicRunner(), HARNESS_SCENARIOS, 'deterministic');
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  return router;
}

// ---------- CLI ----------

const isMainModule = process.argv[1]?.includes('harness-eval');
if (isMainModule) {
  runHarnessEval(createDeterministicRunner(), HARNESS_SCENARIOS, 'deterministic')
    .then(report => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.successRate === 1 ? 0 : 1);
    })
    .catch(err => {
      console.error('Harness eval failed:', err);
      process.exit(1);
    });
}
