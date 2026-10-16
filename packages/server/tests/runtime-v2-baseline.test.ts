import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TsAgentLoop } from '../src/agents/ts-agent-loop.js';
import { updateAgentRun } from '../src/agents/run-state.js';
import { CopilotProvider } from '../src/models/copilot-provider.js';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask, getTask } from '../src/db/models/task.js';
import { createExecution, getExecution, listExecutions, updateExecution } from '../src/db/models/execution.js';
import { createRunTrace, createTraceSpan } from '../src/db/models/trace.js';
import { syncBuiltinModels } from '../src/models/model-registry.js';
import { syncBuiltinTools } from '../src/tools/tool-registry.js';
import { getMcpManager } from '../src/tools/mcp-manager.js';
import { llmCache } from '../src/cache/llm-cache.js';
import { createScriptedProvider, createScriptedCopilot, fixtureCompletion } from './fixtures/runtime-providers.js';
import { defaultRuntimeCapabilities } from '@myrmecia/shared';
import * as contextCompactor from '../src/agents/context-compactor.js';
import { persistExecutionContext } from '../src/agents/execution-context.js';
import { listExecutionArtifacts } from '../src/db/models/execution-artifact.js';
import { messageBus } from '../src/agents/message-bus.js';
import { clearPauseControl, setPauseControl, UserPauseReached } from '../src/agents/pause-control.js';
import { attachFailedRequestUsage } from '../src/models/failed-request-usage.js';
import { AgentRunStopped } from '../src/agents/run-state.js';
import { listLedgerEntries } from '../src/db/models/execution-ledger.js';
import { budgetUsage, setBudgetPolicy } from '../src/agents/budget-service.js';
import { writeDesignFixtures } from './fixtures/development-design.js';

const transport = vi.hoisted(() => ({ complete: vi.fn(), mode: 'host_loop' as 'host_loop' | 'provider_loop' }));
const verifier = vi.hoisted(() => ({ run: vi.fn() }));
const matcher = vi.hoisted(() => ({ match: vi.fn(async () => ({ skillId: null, confidence: 0 })) }));
vi.mock('../src/testing/task-test-authorization.js', () => ({
  runAuthorizedDevelopmentTest: verifier.run,
}));
vi.mock('../src/models/gateway.js', () => ({
  getModelGateway: () => ({
    completeForModel: transport.complete, supportsTools: () => true,
    providerFor: () => transport.mode === 'provider_loop' ? 'copilot' : 'default',
    runtimeCapabilitiesFor: () => defaultRuntimeCapabilities(transport.mode),
  }),
}));
vi.mock('../src/skills/skill-matcher.js', () => ({
  matchSkillForTask: matcher.match,
}));

let directory: string;
const envKeys = ['DB_PATH', 'AGENT_MAX_EXECUTION_TOKENS', 'AGENT_MAX_CONTEXT_TOKENS', 'AGENT_MAX_RESPONSE_TOKENS', 'AGENT_TOOL_TIMEOUT_MS', 'MYRMECIA_MODEL_PROVIDER', 'MCP_TOOLS_ENABLED', 'MYRMECIA_RUNTIME_V2', 'MYRMECIA_BOUNDED_CONTINUATION', 'MYRMECIA_RUNTIME_SLICE_MS'] as const;
let original: Record<string, string | undefined>;
beforeEach(() => {
  original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  directory = mkdtempSync(join(tmpdir(), 'myrmecia-loop-v2-'));
  process.env.DB_PATH = ':memory:';
  delete process.env.MYRMECIA_MODEL_PROVIDER;
  delete process.env.AGENT_MAX_EXECUTION_TOKENS;
  delete process.env.AGENT_MAX_CONTEXT_TOKENS;
  delete process.env.AGENT_MAX_RESPONSE_TOKENS;
  process.env.MCP_TOOLS_ENABLED = 'true';
  process.env.MYRMECIA_RUNTIME_V2 = 'true';
  transport.complete.mockReset();
  verifier.run.mockReset();
  matcher.match.mockClear();
  transport.mode = 'host_loop';
  llmCache.clear();
  syncBuiltinModels();
  syncBuiltinTools();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('LIVE_NETWORK_FORBIDDEN_IN_BASELINE'); }));
});
afterEach(() => {
  closeDb();
  for (const key of envKeys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

function start(input: string, allowedTools: string[] = [], skill?: Parameters<TsAgentLoop['execute']>[7], controller = new AbortController(), maxTurns = 3) {
  const agent = createAgent({ id: crypto.randomUUID(), name: 'Baseline Agent', role: 'dev', allowedTools, config: { maxTurns } });
  const task = createTask({ title: input, description: '', input, mode: 'direct', workdir: directory, workspacePath: directory });
  const execution = createExecution({ taskId: task.id, agentDefId: agent.id });
  const trace = createRunTrace({ taskId: task.id, executionId: execution.id, agentId: agent.id });
  const span = createTraceSpan({ traceId: trace.id, type: 'agent.start', name: 'baseline' });
  const promise = new TsAgentLoop().execute(agent, task, controller, execution.id, trace.id, span.id,
    { toolUseCount: 0, latestInputTokens: 0, cumulativeOutputTokens: 0, recentActivities: [] }, skill);
  return { promise, execution, controller, task, agent };
}

describe('Runtime V2 baseline against production entry points', () => {
  it.each([['false', 'host_loop'], ['true', 'host_loop'], ['false', 'provider_loop'], ['true', 'provider_loop']] as const)('separates development requests, host verification and bounded repair with a shared budget, V2=%s mode=%s', async (enabled, mode) => {
    process.env.MYRMECIA_RUNTIME_V2 = enabled;
    transport.mode = mode;
    process.env.AGENT_TOOL_TIMEOUT_MS = '1000';
    const phases: string[] = [];
    const allowances: number[] = [];
    const deadlines: number[] = [];
    let index = 0;
    transport.complete.mockImplementation(async (_model, params, options) => {
      const phase = String(params.messages[0].content).match(/development stage v1: (\w+)/)?.[1];
      phases.push(phase!);
      allowances.push(options.contextBudget.inputTokens + options.contextBudget.outputTokens);
      deadlines.push(Date.now() + options.timeoutMs);
      if (index++ === 0) {
        const task = listExecutions()[0].taskId;
        writeDesignFixtures(directory, task);
        writeFileSync(join(directory, 'package.json'), '{"scripts":{"test":"node --test test/*.test.mjs"}}');
        messageBus.send(null, listExecutions()[0].id, 'text', 'Retain user chosen storage format');
      }
      if (phase === 'delivery') expect(JSON.stringify(params.messages)).toContain('Retain user chosen storage format');
      return fixtureCompletion(`Finished ${phase}.`);
    });
    verifier.run.mockResolvedValueOnce({ command: 'npm test', cwd: directory, exitCode: 1,
      stdout: 'AssertionError: incomplete PATCH', stderr: '', receiptId: 'tr-failed' });
    verifier.run.mockResolvedValueOnce({ command: 'npm test', cwd: directory, exitCode: 0,
      stdout: '# tests 4\n# pass 4\n# fail 0\n', stderr: '', receiptId: 'tr-passed' });
    const f = start('Build a complete application with frontend UI', [], undefined, new AbortController(), 8);
    const result = await f.promise;
    expect(phases).toEqual(['design', 'core', 'ui', 'repair', 'delivery']);
    expect(allowances).toEqual([0, 20, 40, 60, 80]);
    expect(Math.max(...deadlines) - Math.min(...deadlines)).toBeLessThan(150);
    expect(result).toMatchObject({ numTurns: 5, inputTokens: 50, outputTokens: 50, output: 'Finished delivery.' });
    expect(verifier.run).toHaveBeenCalledTimes(2);
    expect(matcher.match).not.toHaveBeenCalled(); // no unbudgeted matching request outside the phase loop
    for (const [task, options] of verifier.run.mock.calls) {
      expect(task.id).toBe(f.task.id);
      expect(options.signal).toBe(f.controller.signal);
      expect(options.deadline).toBeGreaterThan(Date.now());
      expect(options.deadline).toBeLessThanOrEqual(Date.now() + 1000);
    }
    expect(getExecution(f.execution.id)?.runState?.developmentStage).toMatchObject({
      phase: 'complete', repairAttempts: 1, receiptId: 'tr-passed', browserAcceptance: 'unverified',
    });
    const checkpoints = getDb().all<any>("SELECT payload FROM agent_session_events WHERE event_key LIKE 'checkpoint:%'");
    if (enabled === 'true') expect(checkpoints.some(row => JSON.parse(row.payload).developmentStage?.phase === 'repair')).toBe(true);
  });
  it.each(['false', 'true'])('never completes a complete-system request on an unsupported model claim, V2=%s', async enabled => {
    process.env.MYRMECIA_RUNTIME_V2 = enabled;
    transport.complete.mockResolvedValue(fixtureCompletion('The full application is done and tested.'));
    await expect(start('Build a complete application with frontend UI', [], undefined, new AbortController(), 8).promise)
      .rejects.toThrow('DEVELOPMENT_STAGE_INCOMPLETE');
    expect(transport.complete).toHaveBeenCalledOnce();
    expect(verifier.run).not.toHaveBeenCalled();
  });
  it.each(['false', 'true'])('retains observed failed SDK usage without settling its unknown tail, V2=%s', async enabled => {
    process.env.MYRMECIA_RUNTIME_V2 = enabled;
    transport.mode = 'provider_loop';
    const error = new AgentRunStopped('token_budget', 'COPILOT_TOKEN_BUDGET: test allowance exceeded');
    transport.complete.mockImplementationOnce(async () => {
      attachFailedRequestUsage(error, {
        prompt_tokens: 200000, completion_tokens: 10000, total_tokens: 210000,
        provider: 'copilot', actual_model_id: 'fixture-actual',
        input_tokens_observed: true, output_tokens_observed: true,
        cost_type: 'subscription', cost_usd: null,
      });
      throw error;
    });
    const run = start('Fix a single file. Only modify note.txt', []);
    // The production AgentRuntime installs this cap; direct loop fixtures must do it explicitly.
    setBudgetPolicy({ workspaceId: 'default', scope: 'task', scopeId: run.task.id,
      period: 'lifetime', maxTokens: 200000 });
    await expect(run.promise).rejects.toBe(error);
    expect(getExecution(run.execution.id)?.progress.tokenCount).toBe(210000);
    expect(listLedgerEntries({ executionId: run.execution.id })
      .find(entry => entry.type === 'model.partial_usage')?.metadata).toMatchObject({
      inputTokensLowerBound: 200000, outputTokensLowerBound: 10000, complete: false,
    });
    const usage = budgetUsage('default', run.agent.id, run.task.id).find(summary => summary.scope === 'task');
    expect(usage).toMatchObject({ reserved: { tokens: 210000 }, remaining: { tokens: 0 }, unknownTokens: 1 });
    expect(getDb().get<any>('SELECT status FROM agent_budget_reservations WHERE kind=?', 'model')?.status).toBe('dispatched');
  });
  it.each(['false', 'true'])('keeps streaming pause requested until a complete observed turn, V2=%s', async enabled => {
    process.env.MYRMECIA_RUNTIME_V2 = enabled;
    writeFileSync(join(directory, 'stream-evidence.txt'), 'complete retained observation');
    let settle!: (reply: ReturnType<typeof fixtureCompletion>) => void;
    let requestParams: any;
    transport.complete.mockImplementation(async (_model: string, params: any, options: any) => {
      requestParams = params;
      options.onDelta?.('Checking scoped evidence…');
      return new Promise(resolve => { settle = resolve; });
    });
    const f = start('Read evidence before reporting.', ['file_read']);
    // Observe rejection immediately so an intentional pause is not unhandled.
    const outcome = f.promise.catch(error => error);
    await vi.waitFor(() => expect(settle).toBeTypeOf('function'));
    setPauseControl('task', f.task.id, 'requested', 'running');
    expect(getTask(f.task.id)?.pauseControl?.state).toBe('requested');
    expect(f.controller.signal.aborted).toBe(false);
    settle(fixtureCompletion('', 'tool_calls', [{ id: 'stream-read', type: 'function',
      function: { name: requestParams.tools[0].function.name, arguments: '{"path":"stream-evidence.txt"}' } }]));
    expect(await outcome).toBeInstanceOf(UserPauseReached);
    // The loop signals the boundary; AgentRuntime persists the paused state.
    // This direct loop fixture must not pretend it ran that outer transition.
    const checkpoint = getDb().get<{ snapshot: string }>('SELECT snapshot FROM agent_loop_checkpoints WHERE execution_id = ?', f.execution.id)!;
    expect(JSON.parse(checkpoint.snapshot)).toMatchObject({ boundary: 'stable', toolCallCount: 1 });
    expect(getTask(f.task.id)?.pauseControl?.state).toBe('requested');
    expect(transport.complete).toHaveBeenCalledOnce();
  });
  it.each(['false', 'true'])('pauses the real TS loop at an observed tool boundary and resumes without repeating the read, V2=%s', async enabled => {
    process.env.MYRMECIA_RUNTIME_V2 = enabled;
    writeFileSync(join(directory, 'pause-evidence.txt'), 'retained fixture observation');
    const scripted = createScriptedProvider([
      params => {
        // A verification request need not await skill matching before transport dispatch.
        // Read the already-persisted execution instead of relying on start() having returned.
        const execution = listExecutions()[0];
        expect(execution?.taskId).toBeTruthy();
        setPauseControl('task', execution.taskId, 'requested', 'running');
        return fixtureCompletion('', 'tool_calls', [{ id: 'pause-read-1', type: 'function',
          function: { name: params.tools[0].function.name, arguments: '{"path":"pause-evidence.txt"}' } }]);
      },
      params => {
        expect(params.messages.filter((message: any) => message.role === 'tool')).toHaveLength(1);
        expect(JSON.stringify(params.messages)).toContain('retained fixture observation');
        return fixtureCompletion('Resumed using the original observation.');
      },
    ]);
    transport.complete.mockImplementation(scripted.completeForModel);
    const f = start('Inspect the fixture evidence, then report.', ['file_read']);
    await expect(f.promise).rejects.toThrow(UserPauseReached);
    expect(scripted.requests).toHaveLength(1);
    updateExecution(f.execution.id, { status: 'failed', runState: {
      ...getExecution(f.execution.id)!.runState!, phase: 'interrupted', stopReason: 'interrupted', userPaused: true,
    } });
    clearPauseControl('task', f.task.id);
    const next = createExecution({ taskId: f.task.id, agentDefId: f.agent.id });
    const trace = createRunTrace({ taskId: f.task.id, executionId: next.id, agentId: f.agent.id });
    const span = createTraceSpan({ traceId: trace.id, type: 'agent.start', name: 'resumed user pause' });
    const result = await new TsAgentLoop().execute(f.agent, f.task, new AbortController(), next.id, trace.id, span.id,
      { toolUseCount: 0, latestInputTokens: 0, cumulativeOutputTokens: 0, recentActivities: [] });
    expect(result.output).toBe('Resumed using the original observation.');
    expect(result.numTurns).toBe(2);
    expect(scripted.requests).toHaveLength(2);
    expect(getExecution(next.id)?.runState?.resumedFromExecutionId).toBe(f.execution.id);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['false', 'true'])('preserves actual conversation behavior with V2 switch %s', async enabled => {
    process.env.MYRMECIA_RUNTIME_V2 = enabled;
    const scripted = createScriptedProvider([fixtureCompletion('Equivalent answer')]);
    transport.complete.mockImplementation(scripted.completeForModel);
    const { promise, execution } = start('hello');
    await expect(promise).resolves.toMatchObject({ output: 'Equivalent answer', stopReason: 'completed', numTurns: 1 });
    expect(scripted.requests).toHaveLength(1);
    if (enabled === 'true') expect(getExecution(execution.id)?.runState?.metrics).toMatchObject({ requestCount: 1, modelTurnCount: 1 });
    else expect(getExecution(execution.id)?.runState?.metrics).toBeUndefined();
  });
  it('returns streaming Markdown from a tool-free actual TS conversation', async () => {
    const deltas: string[] = [];
    const scripted = createScriptedProvider([(params, options) => {
      expect(params.tools).toBeUndefined();
      options.onDelta?.('## Answer\n');
      deltas.push('## Answer\n');
      return fixtureCompletion('## Answer\n\nReady.');
    }]);
    transport.complete.mockImplementation(scripted.completeForModel);
    await expect(start('hello').promise).resolves.toMatchObject({ output: '## Answer\n\nReady.', stopReason: 'completed' });
    expect(scripted.requests).toHaveLength(1);
    expect(scripted.remaining()).toBe(0);
    expect(deltas).toEqual(['## Answer\n']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('executes a real host file tool then supplies its result to the next model request', async () => {
    writeFileSync(join(directory, 'evidence.txt'), 'fixture evidence');
    const scripted = createScriptedProvider([
      params => fixtureCompletion('', 'tool_calls', [{ id: 'read-1', type: 'function',
        function: { name: params.tools[0].function.name, arguments: '{"path":"evidence.txt"}' } }]),
      params => {
        expect(params.messages.find((message: any) => message.role === 'tool').content).toContain('fixture evidence');
        return fixtureCompletion('Read verified.');
      },
    ]);
    transport.complete.mockImplementation(scripted.completeForModel);
    await expect(start('Inspect the file and report its contents.', ['file_read']).promise).resolves.toMatchObject({ output: 'Read verified.', numTurns: 2 });
    expect(scripted.requests).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs SDK-owned tool callbacks through the production Copilot provider without host-loop double dispatch', async () => {
    const sdk = createScriptedCopilot([
      { type: 'tool', name: 'read', input: { path: 'evidence.txt' } },
      { type: 'tool', name: 'read', input: { path: 'more.txt' } },
      { type: 'usage', input: 14, output: 7 },
      { type: 'delta', text: 'Verified' }, { type: 'result', text: 'Verified.' },
    ]);
    const provider = new CopilotProvider({}, () => sdk.client);
    const handler = vi.fn(async () => 'tool evidence');
    const delta = vi.fn();
    const result = await provider.complete({ model: 'fixture', messages: [{ role: 'user', content: 'Read.' }],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    }, { onToolCall: handler, onDelta: delta });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(sdk.observed.requests).toBe(1);
    expect(result.choices[0].message.tool_calls).toBeUndefined();
    expect(result.usage).toMatchObject({ prompt_tokens: 14, completion_tokens: 7, cost_type: 'subscription' });
    expect(delta).toHaveBeenCalledWith('Verified');
    expect(sdk.observed.disconnects).toBe(1);
    expect(sdk.callbacks.size).toBe(0);
  });

  it('bridges the real SDK provider through the actual governed TS loop with honest internal-turn metrics', async () => {
    writeFileSync(join(directory, 'evidence.txt'), 'SDK fixture evidence');
    transport.mode = 'provider_loop';
    const sdk = createScriptedCopilot([
      { type: 'tool', name: 'tool_0_file_read', input: { path: 'evidence.txt' } },
      { type: 'tool', name: 'tool_0_file_read', input: { path: 'evidence.txt' } },
      { type: 'usage', input: 18, output: 9 },
      { type: 'result', text: 'SDK answer' },
    ]);
    const provider = new CopilotProvider({}, () => sdk.client);
    transport.complete.mockImplementation((_id, params, options) => provider.complete(params, options));
    const { promise, execution } = start('Read the fixture evidence and report.', ['file_read']);
    await expect(promise).resolves.toMatchObject({ output: 'SDK answer', numTurns: 1, costType: 'subscription' });
    expect(sdk.observed.toolResults).toHaveLength(2);
    expect(sdk.observed.toolResults.every(output => output.includes('SDK fixture evidence'))).toBe(true);
    expect(getExecution(execution.id)?.runState?.metrics).toMatchObject({ requestCount: 1, modelTurnCount: null, toolCallCount: 2 });
    expect(transport.complete).toHaveBeenCalledOnce();
  });

  it('does not turn an absent SDK usage event into measured zero tokens', async () => {
    transport.mode = 'provider_loop';
    const sdk = createScriptedCopilot([{ type: 'result', text: 'SDK answer without usage' }]);
    const provider = new CopilotProvider({}, () => sdk.client);
    transport.complete.mockImplementation((_id, params, options) => provider.complete(params, options));
    const { promise, execution } = start('hello');
    await expect(promise).resolves.toMatchObject({ output: 'SDK answer without usage', costUSD: null });
    expect(getExecution(execution.id)?.runState?.metrics).toMatchObject({ requestCount: 1, modelTurnCount: null, inputTokens: null, outputTokens: null });
  });
  it('uses the real structured Skill executor for two ordered model-backed steps', async () => {
    const budgetCall = vi.spyOn(contextCompactor, 'buildRequestContext');
    const scripted = createScriptedProvider([fixtureCompletion('First evidence'), fixtureCompletion('Final artifact description')]);
    transport.complete.mockImplementation(scripted.completeForModel);
    const skill = { skill: { id: 'baseline' }, version: { id: 'baseline-v1', content:
      '---\nexecutor: step-driven\nsteps:\n  - name: inspect\n    instruction: Inspect input\n  - name: summarize\n    instruction: Summarize previous results\n---\nPreserve the evidence.' },
      source: 'skillPath' } as NonNullable<Parameters<TsAgentLoop['execute']>[7]>;
    const result = await start('Inspect the supplied specification and summarize it.', [], skill).promise;
    expect(result.output).toContain('Final artifact description');
    expect(result.numTurns).toBe(2);
    expect(scripted.requests).toHaveLength(2);
    expect(JSON.stringify(scripted.requests[1].messages)).toContain('First evidence');
    expect(budgetCall).toHaveBeenCalled();
  });
  it('continues a read-only structured Skill from a canonical completed-step boundary without repeating its first request', async () => {
    process.env.MYRMECIA_BOUNDED_CONTINUATION = 'true';
    process.env.MYRMECIA_RUNTIME_SLICE_MS = '100';
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const scripted = createScriptedProvider([
      () => { clock += 200; return fixtureCompletion('First step evidence'); },
      fixtureCompletion('Second step report'),
    ]);
    transport.complete.mockImplementation(scripted.completeForModel);
    const skill = { skill: { id: 'slice' }, version: { id: 'slice-v1', content:
      '---\nexecutor: step-driven\nsteps:\n  - name: inspect\n    instruction: Inspect input\n  - name: summarize\n    instruction: Summarize previous results\n---\nPreserve evidence.' },
      source: 'skillPath' } as NonNullable<Parameters<TsAgentLoop['execute']>[7]>;
    const f = start('Inspect the specification and summarize.', [], skill);
    await expect(f.promise).rejects.toThrow('RUNTIME_SLICE_YIELD');
    updateExecution(f.execution.id, { status: 'failed', runState: {
      ...getExecution(f.execution.id)!.runState!, phase: 'interrupted', stopReason: 'interrupted',
    } });
    const next = createExecution({ taskId: f.task.id, agentDefId: f.agent.id });
    const trace = createRunTrace({ taskId: f.task.id, executionId: next.id, agentId: f.agent.id });
    const span = createTraceSpan({ traceId: trace.id, type: 'agent.start', name: 'resumed Skill' });
    const result = await new TsAgentLoop().execute(f.agent, f.task, new AbortController(), next.id, trace.id, span.id,
      { toolUseCount: 0, latestInputTokens: 0, cumulativeOutputTokens: 0, recentActivities: [] }, skill);
    expect(result.output).toContain('First step evidence');
    expect(result.output).toContain('Second step report');
    expect(scripted.requests).toHaveLength(2);
    expect(JSON.stringify(scripted.requests[1].messages)).toContain('First step evidence');
    expect(getExecution(next.id)?.runState).toMatchObject({ resumedFromExecutionId: f.execution.id, metrics: { requestCount: 2 } });
  });
  it('records a cache hit as zero new model usage and still journals its visible assistant output', async () => {
    const scripted = createScriptedProvider([fixtureCompletion('Cached answer')]);
    transport.complete.mockImplementation(scripted.completeForModel);
    await start('hello').promise;
    const f = start('hello');
    const result = await f.promise;
    expect(result).toMatchObject({ output: 'Cached answer', costUSD: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 });
    expect(scripted.requests).toHaveLength(1);
    expect(getExecution(f.execution.id)?.runState?.metrics).toMatchObject({ requestCount: 0, inputTokens: 0, outputTokens: 0 });
  });

  it('uses layered budgeting on the actual Skill summary request as well as its step request', async () => {
    const budgetCall = vi.spyOn(contextCompactor, 'buildRequestContext');
    const scripted = createScriptedProvider([fixtureCompletion(''), fixtureCompletion('Concrete step result')]);
    transport.complete.mockImplementation(scripted.completeForModel);
    const skill = { skill: { id: 'summary' }, version: { id: 'summary-v1', content:
      '---\nexecutor: step-driven\nsteps:\n  - name: inspect\n    instruction: Inspect input\n---\nPreserve evidence.' },
      source: 'skillPath' } as NonNullable<Parameters<TsAgentLoop['execute']>[7]>;
    await expect(start('Inspect this specification.', [], skill).promise).resolves.toMatchObject({ output: expect.stringContaining('Concrete step result') });
    expect(scripted.requests).toHaveLength(2);
    expect(JSON.stringify(scripted.requests[1].messages)).toContain('Provide the result of this step');
    expect(budgetCall.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('preserves approved constraints and a user follow-up across 50 actual governed model/tool turns', async () => {
    process.env.AGENT_MAX_CONTEXT_TOKENS = '3000';
    process.env.AGENT_MAX_RESPONSE_TOKENS = '200';
    writeFileSync(join(directory, 'evidence.txt'), 'Observed evidence. '.repeat(60));
    let executionId: string;
    const scripted = createScriptedProvider(Array.from({ length: 50 }, (_, index) => (params: any) => {
      const text = JSON.stringify(params.messages);
      expect(text).toContain('Never publish external content.');
      if (index > 2) expect(text).toContain('Keep the current public API unchanged.');
      if (index === 2) messageBus.send(null, executionId, 'text', 'Keep the current public API unchanged.');
      return index === 49 ? fixtureCompletion('Verified long fixture.')
        : fixtureCompletion(`Observed step ${index}. ${'verified record '.repeat(20)}`, 'tool_calls', [{
          id: `read-${index}`, type: 'function',
          function: { name: params.tools[0].function.name, arguments: '{"path":"evidence.txt"}' },
        }]);
    }));
    transport.complete.mockImplementation(scripted.completeForModel);
    const { promise, task, execution } = start('Inspect the file evidence across multiple iterations.', ['file_read'], undefined, undefined, 50);
    executionId = execution.id;
    persistExecutionContext(task, { constraints: ['Never publish external content.'] });
    await expect(promise).resolves.toMatchObject({ output: 'Verified long fixture.', numTurns: 50 });
    expect(scripted.requests).toHaveLength(50);
    expect(JSON.stringify(scripted.requests)).not.toContain('myrmeciaContextFacts');
    const summaries = listExecutionArtifacts({ taskId: task.id }).filter(artifact => artifact.metadata?.contextCompaction);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.some(artifact => JSON.stringify(artifact.metadata?.contextFacts).includes('Keep the current public API unchanged.'))).toBe(true);
  });
  it('surfaces a fake MCP transport timeout to the actual model tool loop without a live server', async () => {
    const manager = getMcpManager();
    vi.spyOn(manager, 'listTools').mockReturnValue([{ qualifiedName: 'mcp__fixture__lookup', name: 'lookup', server: 'fixture',
      description: 'Read fixture evidence', inputSchema: { type: 'object', properties: {} } }] as any);
    const call = vi.spyOn(manager, 'callTool').mockRejectedValue(new Error('TIMED_OUT: fixture transport'));
    const scripted = createScriptedProvider([
      params => fixtureCompletion('', 'tool_calls', [{ id: 'mcp-1', type: 'function',
        function: { name: params.tools[0].function.name, arguments: '{}' } }]),
      params => {
        expect(params.messages.find((message: any) => message.role === 'tool').content).toContain('TIMED_OUT');
        return fixtureCompletion('The evidence could not be retrieved.');
      },
    ]);
    transport.complete.mockImplementation(scripted.completeForModel);
    await expect(start('Look up the fixture evidence.', ['mcp__fixture__lookup']).promise).resolves.toMatchObject({ output: 'The evidence could not be retrieved.' });
    expect(call).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never dispatches a model when cancellation is already requested', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(start('Inspect this request.', [], undefined, controller).promise).rejects.toThrow(/abort/i);
    expect(transport.complete).not.toHaveBeenCalled();
  });

  it('enforces actual execution token budget after measured model usage', async () => {
    process.env.AGENT_MAX_EXECUTION_TOKENS = '4096';
    process.env.AGENT_MAX_RESPONSE_TOKENS = '512';
    const reply = fixtureCompletion('Budget fixture');
    reply.usage = { prompt_tokens: 4096, completion_tokens: 1 };
    transport.complete.mockImplementation(createScriptedProvider([reply]).completeForModel);
    await expect(start('hello').promise).rejects.toThrow(/token budget/);
  });

  it('rejects truncated actual model output instead of reporting completion', async () => {
    transport.complete.mockImplementation(createScriptedProvider([fixtureCompletion('Partial only', 'length')]).completeForModel);
    await expect(start('hello').promise).rejects.toMatchObject({ reason: 'model_truncated' });
  });

  it('rejects empty output from the production loop', async () => {
    transport.complete.mockImplementation(createScriptedProvider([fixtureCompletion('')]).completeForModel);
    await expect(start('hello').promise).rejects.toMatchObject({ reason: 'empty_output' });
  });
  it('does not report completion for an unknown provider stop reason', async () => {
    transport.complete.mockImplementation(createScriptedProvider([fixtureCompletion('Unverified', 'unknown-vendor-state')]).completeForModel);
    await expect(start('hello').promise).rejects.toMatchObject({ reason: 'failed' });
  });

  it('retains persisted cancellation when a model returns a late result', async () => {
    let settle!: (reply: ReturnType<typeof fixtureCompletion>) => void;
    transport.complete.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const { promise, execution, controller } = start('hello');
    await vi.waitFor(() => expect(transport.complete).toHaveBeenCalledOnce());
    updateAgentRun(execution.id, 'cancelled', { stopReason: 'cancelled' });
    controller.abort();
    settle(fixtureCompletion('Late answer'));
    await expect(promise).rejects.toThrow(/abort/i);
    expect(getExecution(execution.id)?.runState).toMatchObject({ phase: 'cancelled', stopReason: 'cancelled' });
  });

  it('cleans up a silent SDK request on its actual deadline', async () => {
    vi.useFakeTimers();
    const sdk = createScriptedCopilot([{ type: 'wait' }]);
    const provider = new CopilotProvider({}, () => sdk.client);
    const pending = provider.complete({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }] }, { timeoutMs: 100, idleTimeoutMs: 1000 });
    const rejected = expect(pending).rejects.toThrow('EXECUTION_WALL_TIMEOUT');
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(sdk.observed.aborts).toBe(1);
    expect(sdk.observed.disconnects).toBe(1);
    expect(sdk.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
