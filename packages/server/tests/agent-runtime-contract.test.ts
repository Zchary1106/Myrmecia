import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime } from '../src/agents/agent-runtime.js';
import { AgentRunStopped } from '../src/agents/run-state.js';
import { closeDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask, getTask, updateTask } from '../src/db/models/task.js';
import { listExecutions } from '../src/db/models/execution.js';
import { listExecutionArtifacts } from '../src/db/models/execution-artifact.js';
import { readArtifactSnapshot } from '../src/artifacts/artifact-snapshot-store.js';
import { tsAgentLoop } from '../src/agents/ts-agent-loop.js';
import type { RuntimeAdapterResult } from '../src/agents/runtime-adapter.js';

let directory: string;
const originalExecutor = process.env.AGENT_EXECUTOR;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'myrmecia-run-contract-'));
  process.env.DB_PATH = join(directory, 'test.db');
  process.env.AGENT_EXECUTOR = 'contract-fixture';
});
afterEach(() => {
  closeDb(); delete process.env.DB_PATH;
  if (originalExecutor === undefined) delete process.env.AGENT_EXECUTOR;
  else process.env.AGENT_EXECUTOR = originalExecutor;
  vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true });
});

const result = (output = 'Final answer'): RuntimeAdapterResult => ({
  output, costUSD: null, inputTokens: 10, outputTokens: 10, numTurns: 1, durationMs: 10,
});

async function execute(adapter: (taskId: string) => Promise<RuntimeAdapterResult>) {
  const runtime = new AgentRuntime();
  vi.spyOn(runtime as any, 'recordTrajectory').mockImplementation(() => {});
  const agent = createAgent({ id: 'contract-agent', name: 'Fixture', role: 'dev' });
  const task = createTask({ title: 'fixture', description: 'fixture', mode: 'direct', input: 'fixture',
    workspaceId: 'default', workspacePath: directory, workdir: directory, assigneeId: agent.id });
  runtime.registerRuntimeAdapter({ name: 'contract-fixture', canHandle: () => true, execute: ctx => adapter(ctx.task.id) });
  return { task, promise: runtime.execute(agent, task) };
}

describe('Agent Runtime completion contract', () => {
  it('requests a required scoped document before calling the model/adapter', async () => {
    const runtime = new AgentRuntime();
    vi.spyOn(runtime as any, 'recordTrajectory').mockImplementation(() => {});
    const adapter = vi.fn(async () => result());
    runtime.registerRuntimeAdapter({ name: 'contract-fixture', canHandle: () => true, execute: adapter });
    const agent = createAgent({ name: 'Inputs', role: 'analyst', config: {
      contract: { schemaVersion: '1.0', agentId: 'input-agent', role: 'analyst',
        responsibility: { summary: 'Analyze', owns: ['analysis'], doesNotOwn: [] },
        inputs: [{ name: 'brief.md', kind: 'document', required: true }],
        outputs: [{ name: 'Answer', kind: 'markdown', required: true }], skills: [], tools: [],
        quality: { definitionOfDone: ['Answer grounded in brief'] } },
    } });
    const task = createTask({ title: 'Analyze', description: 'Analyze', input: 'Analyze the brief', mode: 'direct',
      assigneeId: agent.id, workspacePath: directory, workdir: directory });
    const answer = await runtime.execute(agent, task);
    expect(adapter).not.toHaveBeenCalled();
    expect(answer.stopReason).toBe('needs_input');
    expect(getTask(task.id)?.status).toBe('review');
    expect(answer.output).toContain('brief.md');
  });
  it.each([[], ['shell_exec'], ['browser.query'], ['mcp__fixture__search']].map(allowedTools => ({ allowedTools })))('routes built-in tools $allowedTools to the TS adapter', async ({ allowedTools }) => {
    delete process.env.AGENT_EXECUTOR;
    const loop = vi.spyOn(tsAgentLoop, 'execute').mockResolvedValue({ ...result(), costType: 'unavailable', provider: 'openai', aiUnits: 0, executionId: 'fixture' });
    const runtime = new AgentRuntime();
    vi.spyOn(runtime as any, 'recordTrajectory').mockImplementation(() => {});
    const agent = createAgent({ id: 'ts-fixture', name: 'Fixture', role: 'dev', allowedTools });
    const task = createTask({ title: 'fixture', description: 'fixture', mode: 'direct', input: 'fixture',
      workspaceId: 'default', workspacePath: directory, workdir: directory, assigneeId: agent.id });
    await runtime.execute(agent, task);
    expect(loop).toHaveBeenCalledOnce();
    expect(listExecutions({ taskId: task.id })[0].runState?.runtime).toBe('ts-agent-loop');
  });

  it('keeps registered adapters ahead of the universal TS fallback without an override', async () => {
    delete process.env.AGENT_EXECUTOR;
    const loop = vi.spyOn(tsAgentLoop, 'execute');
    const { promise } = await execute(async () => result());
    await promise;
    expect(loop).not.toHaveBeenCalled();
  });

  it('records a removed Python override as a failed execution without calling a model', async () => {
    process.env.AGENT_EXECUTOR = 'python';
    const loop = vi.spyOn(tsAgentLoop, 'execute');
    const { task, promise } = await execute(async () => result());
    await expect(promise).rejects.toThrow('Python/CrewAI runtime has been removed');
    expect(getTask(task.id)?.status).toBe('failed');
    expect(loop).not.toHaveBeenCalled();
  });

  it('validates the output without automatically accepting it', async () => {
    const { task, promise } = await execute(async () => result());
    await promise;
    expect(getTask(task.id)?.status).toBe('done');
    expect(listExecutions({ taskId: task.id })[0]).toMatchObject({
      status: 'done', runState: { phase: 'completed', stopReason: 'completed', acceptance: 'pending', validation: { status: 'passed' } },
    });
  });

  it('rejects an empty adapter result instead of completing the task', async () => {
    const { task, promise } = await execute(async () => result('  '));
    await expect(promise).rejects.toThrow('AGENT_EMPTY_OUTPUT');
    expect(getTask(task.id)?.status).toBe('failed');
    expect(listExecutions({ taskId: task.id })[0].runState?.stopReason).toBe('empty_output');
  });

  it('preserves partial output and the max-turn stop reason', async () => {
    const { task, promise } = await execute(async () => { throw new AgentRunStopped('max_turns', 'AGENT_MAX_TURNS: limit', 'Partial findings'); });
    await expect(promise).rejects.toThrow('AGENT_MAX_TURNS');
    expect(getTask(task.id)).toMatchObject({ status: 'failed', output: 'Partial findings' });
    expect(listExecutions({ taskId: task.id })[0].runState?.stopReason).toBe('max_turns');
  });

  it('does not publish a late successful result after user cancellation', async () => {
    const { task, promise } = await execute(async taskId => {
      updateTask(taskId, { status: 'cancelled' });
      return result('Late answer');
    });
    await expect(promise).rejects.toThrow('cancelled');
    expect(getTask(task.id)?.status).toBe('cancelled');
    expect(getTask(task.id)?.output).not.toBe('Late answer');
    expect(listExecutions({ taskId: task.id })[0]).toMatchObject({ status: 'cancelled', runState: { stopReason: 'cancelled' } });
  });

  it('treats an explicit clarification as waiting, not completed work', async () => {
    const { task, promise } = await execute(async () => result('{"kind":"myrmecia.request_input","question":"请提供目标工作区"}'));
    const output = await promise;
    expect(output).toMatchObject({ output: '请提供目标工作区', stopReason: 'needs_input' });
    expect(getTask(task.id)).toMatchObject({ status: 'review', output: '请提供目标工作区' });
    expect(listExecutions({ taskId: task.id })[0].runState).toMatchObject({ phase: 'waiting_for_user', acceptance: 'pending' });
    const question = listExecutionArtifacts({ taskId: task.id }).find(artifact => artifact.source === 'result');
    expect(question?.metadata).toMatchObject({ immutable: true, captureState: 'partial' });
    expect(readArtifactSnapshot(question!)?.toString()).toContain('请提供目标工作区');
  });
});
