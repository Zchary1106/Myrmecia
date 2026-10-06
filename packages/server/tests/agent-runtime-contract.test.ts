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
  });
});
