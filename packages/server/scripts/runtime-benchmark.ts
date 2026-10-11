/**
 * Fixture mode runs assertion-backed production regression suites, not a fake
 * model success-rate experiment. Live mode is a separate small read-only smoke
 * matrix and requires explicit opt-in plus an already configured provider.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runRuntimeBenchmark, RUNTIME_V2_BENCHMARK_MATRIX, type RuntimeBenchmarkOutcome } from '../src/testing/runtime-benchmark.js';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = resolve(serverRoot, '../../artifacts/agent-runtime-v2/benchmarks');
const mode = process.argv.find(value => value.startsWith('--mode='))?.slice(7);
if (mode !== 'fixture' && mode !== 'live') throw new Error('Choose --mode=fixture or --mode=live explicitly');
if (mode === 'live' && process.env.MYRMECIA_RUNTIME_BENCHMARK_LIVE !== 'true') throw new Error('LIVE_BENCHMARK_NOT_AUTHORIZED');
mkdirSync(artifactRoot, { recursive: true });
const directory = mkdtempSync(join(artifactRoot, `${mode}-`));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let report;
if (mode === 'fixture') {
  const cases = RUNTIME_V2_BENCHMARK_MATRIX.map(entry => ({ ...entry, input: `${entry.input}\nsource-sha256=${sha(readFileSync(join(serverRoot, entry.input)))}` }));
  report = await runRuntimeBenchmark({ mode, model: 'scripted-transports-regression-matrix', providerVersion: 'fixture-v2',
    cases, runner: async entry => {
      const source = entry.input.split('\n')[0];
      if (!RUNTIME_V2_BENCHMARK_MATRIX.some(item => item.id === entry.id && item.input === source)) throw new Error('UNKNOWN_BENCHMARK_CASE');
      const evidence = join(directory, `${entry.id}.json`);
      const started = Date.now();
      const result = spawnSync('pnpm', ['exec', 'vitest', 'run', source, '--reporter=json', `--outputFile=${evidence}`], {
        cwd: serverRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 8_000_000,
        env: { ...process.env, DB_PATH: ':memory:', MYRMECIA_RUNTIME_BENCHMARK_LIVE: 'false', REDIS_URL: '', REDIS_HOST: '' },
      });
      writeFileSync(join(directory, `${entry.id}.log`), `${result.stdout || ''}\n${result.stderr || ''}`);
      const bytes = readFileSync(evidence);
      const tests = JSON.parse(bytes.toString());
      const passed = result.status === 0 && tests.numPassedTests > 0 && tests.numFailedTests === 0 && tests.success === true;
      console.log(`${entry.id}: ${passed ? 'passed' : 'failed'} (${tests.numPassedTests} assertions, ${tests.numPendingTests} skipped)`);
      return { stopReason: passed ? 'completed' : 'failed', criteria: [
        { criterionId: 'regression-assertions', verifier: 'test_command', required: true, scope: 'workspace', status: passed ? 'passed' : 'failed',
          message: 'Assertion-backed fixture regression suite; not a live model outcome score', evidence: [{ ref: evidence, sha256: sha(bytes) }] },
      ], metrics: null, costUSD: null, durationMs: Date.now() - started, humanInterventions: 0, evidenceRefs: [evidence] } as RuntimeBenchmarkOutcome;
    } });
} else {
  const model = process.argv.find(value => value.startsWith('--model='))?.slice(8);
  if (!model) throw new Error('Live mode requires --model=<existing model id>; no provider/account switching');
  Object.assign(process.env, {
    DB_PATH: join(directory, 'live.sqlite'), MYRMECIA_RUNTIME_V2: 'true', MCP_SERVERS: '[]', MCP_TOOLS_ENABLED: 'false',
    MYRMECIA_EXECUTION_WORLD: 'host_policy', AGENT_MAX_WALL_CLOCK_MS: '60000', AGENT_MAX_EXECUTION_TOKENS: '40000',
    AGENT_MAX_RESPONSE_TOKENS: '2000', AGENT_MAX_TOOL_CALLS: '3',
  });
  const { createAgent } = await import('../src/db/models/agent.js');
  const { createTask } = await import('../src/db/models/task.js');
  const { getExecution } = await import('../src/db/models/execution.js');
  const { listSessionEvents, agentSessionForTask } = await import('../src/db/models/agent-session-event.js');
  const { getModel, syncBuiltinModels } = await import('../src/models/model-registry.js');
  const { syncBuiltinTools } = await import('../src/tools/tool-registry.js');
  const { getModelGateway } = await import('../src/models/gateway.js');
  const { AgentRuntime } = await import('../src/agents/agent-runtime.js');
  syncBuiltinModels(); syncBuiltinTools();
  if (!getModel(model)) throw new Error('Live benchmark model is not registered');
  const agent = createAgent({ id: 'runtime-live-readonly', name: 'Runtime Live Read-only Smoke', role: 'analyst',
    config: { model, maxTurns: 5, allowedTools: ['file_read'] }, allowedTools: ['file_read'] });
  const runtime = new AgentRuntime();
  const marker = 'runtime-v2-live-readonly-ok';
  writeFileSync(join(directory, 'evidence.md'), `# Synthetic acceptance evidence\n${marker}\n`);
  const cases = [
    { id: 'live-chat', category: 'read-only-chat', input: `Hello. Reply with the exact text ${marker}. Do not call any tools.` },
    { id: 'live-read', category: 'scoped-file-read', input: 'Read evidence.md in the supplied workspace and return the marker from the file. No writes, publishing or network tools.' },
  ];
  const provider = getModelGateway().providerFor(model);
  const sdk = provider === 'copilot' ? '@github/copilot-sdk' : 'openai';
  const require = createRequire(import.meta.url);
  let sdkVersion = 'unavailable';
  try {
    let parent = dirname(require.resolve(sdk));
    for (let depth = 0; depth < 5; depth++, parent = dirname(parent)) {
      try {
        const pkg = JSON.parse(readFileSync(join(parent, 'package.json'), 'utf8'));
        if (pkg.name === sdk) { sdkVersion = pkg.version; break; }
      } catch { /* distribution entry may be nested */ }
    }
  } catch { /* explicit unavailable version; never infer remote provider API revision */ }
  report = await runRuntimeBenchmark({ mode, model, providerVersion: `${provider};${sdk}@${sdkVersion};remote-api-version=unavailable`,
    cases, runner: async entry => {
      const task = createTask({ title: entry.id, description: entry.input, input: entry.input, mode: 'direct', modelId: model,
        assigneeId: agent.id, workdir: directory, workspacePath: directory, maxRetries: 0,
        completionCriteria: [{ id: 'literal-marker', label: 'Synthetic marker returned', required: true, verifier: 'output_contains', text: marker }] });
      const started = Date.now();
      const result = await runtime.execute(agent, task);
      const execution = getExecution(result.executionId)!;
      const events = listSessionEvents({ workspaceId: 'default', sessionId: agentSessionForTask(task), limit: 1000 });
      const evidence = join(directory, `${entry.id}.json`);
      writeFileSync(evidence, JSON.stringify({ taskId: task.id, executionId: execution.id, runState: execution.runState,
        eventRefs: events.map(event => ({ id: event.eventId, sequence: event.sequence, type: event.type, hash: event.payloadHash })) }, null, 2) + '\n');
      return { stopReason: result.stopReason || execution.runState?.stopReason || 'unknown',
        criteria: execution.runState?.verification?.criteria || [], metrics: execution.runState?.metrics || null,
        costUSD: result.costUSD, costType: result.costType, provider: result.provider, actualModelId: result.actualModelId,
        durationMs: Date.now() - started, humanInterventions: 0, evidenceRefs: [evidence] };
    } });
  const { closeDb } = await import('../src/db/database.js');
  const { shutdownModelGateway } = await import('../src/models/gateway.js');
  await shutdownModelGateway();
  const { closeEnvironmentFetch } = await import('../src/lib/environment-fetch.js');
  await closeEnvironmentFetch();
  closeDb();
}
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`REPORT ${join(directory, 'report.json')}`);
console.log(`${mode}: ${report.passed}/${report.cases.length}; fixture and live scores are separate.`);
if (report.passed !== report.cases.length) process.exitCode = 1;
if (mode === 'live') {
  // All requests, durable evidence writes and known transports are already
  // settled/closed above. Non-authoritative library hooks must not turn this
  // standalone acceptance command into a long-lived server.
  await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
  process.exit(process.exitCode || 0);
}
