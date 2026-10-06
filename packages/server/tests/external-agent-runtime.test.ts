import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalAgentAdapter } from '@myrmecia/shared';
import { closeDb } from '../src/db/database.js';
import { createExternalAgent, listExternalAgentRuns } from '../src/db/models/external-agent.js';
import { ExternalAgentRuntime } from '../src/agents/external-agent-runtime.js';
import { getTask } from '../src/db/models/task.js';
import { getExecution, listExecutionMessages } from '../src/db/models/execution.js';

beforeEach(() => { process.env.DB_PATH = ':memory:'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; delete process.env.MYRMECIA_EXTERNAL_CALLBACK_TIMEOUT_MS; vi.useRealTimers(); });
function fixture(execute: ExternalAgentAdapter['execute']) {
  const agent = createExternalAgent({ workspaceId: 'default', name: `Fixture-${crypto.randomUUID()}`, adapter: { kind: 'http', endpoint: 'https://fixture.invalid', allowedHosts: ['fixture.invalid'] } });
  const runtime = new ExternalAgentRuntime([{
    kind: 'http', supportsCancellation: true, validate: async () => {},
    healthCheck: async () => ({ status: 'healthy', checkedAt: '' }), execute,
  }]);
  return { agent, runtime };
}
describe('external Agent run lifecycle', () => {
  it('settles thrown transports and empty outputs instead of leaving runs running or successful', async () => {
    const a = fixture(async () => { throw new Error('transport failed'); });
    expect(await a.runtime.run(a.agent.id, 'default', { objective: 'fixture', constraints: [] })).toMatchObject({ status: 'failed', runState: { stopReason: 'failed' } });
    const b = fixture(async () => ({ status: 'succeeded', outputSummary: '' }));
    expect(await b.runtime.run(b.agent.id, 'default', { objective: 'fixture', constraints: [] })).toMatchObject({ status: 'failed', runState: { stopReason: 'empty_output' } });
  });
  it('keeps cancellation authoritative over a late success and states its transport-only scope', async () => {
    let finish!: (result: { status: 'succeeded'; outputSummary: string }) => void;
    const execute = vi.fn(async () => new Promise<{ status: 'succeeded'; outputSummary: string }>(resolve => { finish = resolve; }));
    const { agent, runtime } = fixture(execute);
    const pending = runtime.run(agent.id, 'default', { objective: 'fixture', constraints: [] });
    await Promise.resolve(); await Promise.resolve();
    const run = listExternalAgentRuns({ workspaceId: 'default' })[0];
    const cancelled = await runtime.cancel(run.id, 'default');
    expect(cancelled.error).toContain('remote operation outcome is unknown');
    finish({ status: 'succeeded', outputSummary: 'late' });
    expect(await pending).toMatchObject({ status: 'cancelled', runState: { phase: 'cancelled' } });
    expect(execute.mock.calls[0][2]?.signal?.aborted).toBe(true);
  });
  it('bridges authenticated callback results to the normal conversation and refuses conflicting duplicates', async () => {
    const { agent, runtime } = fixture(async () => ({ status: 'waiting_for_callback', externalRunId: 'remote-1' }));
    const run = await runtime.run(agent.id, 'default', { objective: 'fixture', constraints: [] });
    expect(getTask(run.taskId!)?.status).toBe('waiting_for_tool');
    const output = { status: 'succeeded' as const, outputSummary: '# Report\n\nActual callback output', externalRunId: 'remote-1' };
    await expect(runtime.completeCallback(run.id, 'default', { ...output, externalRunId: 'wrong' })).rejects.toThrow('does not match');
    const completed = await runtime.completeCallback(run.id, 'default', output);
    expect(getTask(run.taskId!)).toMatchObject({ status: 'done', output: output.outputSummary });
    expect(getExecution(run.executionId!)?.runState?.acceptance).toBe('pending');
    expect(listExecutionMessages(run.executionId!).some(message => message.content === output.outputSummary)).toBe(true);
    expect(await runtime.completeCallback(run.id, 'default', output)).toEqual(completed);
    await expect(runtime.completeCallback(run.id, 'default', { ...output, outputSummary: 'conflict' })).rejects.toThrow('settled');
  });
  it('bounds callback waiting and re-arms the persisted deadline without redispatching', async () => {
    vi.useFakeTimers();
    process.env.MYRMECIA_EXTERNAL_CALLBACK_TIMEOUT_MS = '1000';
    const execute = vi.fn(async () => ({ status: 'waiting_for_callback' as const, externalRunId: 'remote' }));
    const { agent, runtime } = fixture(execute);
    const run = await runtime.run(agent.id, 'default', { objective: 'fixture', constraints: [] });
    runtime.recoverCallbacks();
    expect(execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1001);
    expect(getTask(run.taskId!)?.status).toBe('failed');
    expect(getExecution(run.executionId!)?.runState?.stopReason).toBe('deadline');
    expect(vi.getTimerCount()).toBe(0);
    await expect(runtime.completeCallback(run.id, 'default', {
      status: 'succeeded', outputSummary: 'late', externalRunId: 'remote',
    })).rejects.toThrow('settled');
  });
});
