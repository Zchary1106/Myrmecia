import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentRuntime } from '../src/agents/agent-runtime.js';
import { MasterAgent } from '../src/agents/master-agent.js';
import { QualityLoop } from '../src/pipelines/quality-loop.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import { closeDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { addTaskLog, createTask, getTask, getTaskLogs, listTasks, updateTask } from '../src/db/models/task.js';
import { listQualityLoopAttempts } from '../src/db/models/quality-loop.js';

function result(output: string) {
  return { output, costUSD: 0, inputTokens: 0, outputTokens: 0, durationMs: 1, numTurns: 1, executionId: 'test-execution' };
}

describe('reliability and quality-gate integration', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-reliability-')), 'test.db');
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
    delete process.env.AGENT_IDLE_TIMEOUT_MS;
    delete process.env.AGENT_HEARTBEAT_MS;
    delete process.env.AGENT_MAX_WALL_CLOCK_MS;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createDeveloperTask(mode: 'direct' | 'master' = 'direct') {
    const developer = createAgent({ id: 'developer', name: 'Developer', role: 'dev', config: { maxConcurrent: 1, timeout: 300 } });
    const task = createTask({
      title: 'Implement reliable task', description: 'Implement and validate it', input: 'Implement it', mode,
      assigneeId: developer.id, workdir: '/workspace/project', workspacePath: '/workspace/project', workspaceId: 'workspace-a',
      modelId: 'gpt-5', reasoningEffort: 'high', contextLength: 128_000, domainId: 'software',
    });
    updateTask(task.id, { status: 'done', output: 'implementation completed' });
    return { developer, task: getTask(task.id)! };
  }

  it('holds a completed developer task in review, then releases it only after verified Test and JSON Review approval', async () => {
    const { task } = createDeveloperTask('master');
    createAgent({ id: 'qa', name: 'QA', role: 'qa', config: { maxConcurrent: 1 } });
    createAgent({ id: 'review', name: 'Reviewer', role: 'reviewer', config: { maxConcurrent: 1 } });
    const execute = vi.spyOn(agentRuntime, 'execute').mockImplementation(async (agent) => {
      if (agent.id === 'qa') return result(JSON.stringify({ command: 'pnpm test', cwd: '/workspace/project', exitCode: 0, stdout: '2 passed', stderr: '', failedTests: [] }));
      return result(JSON.stringify({ approved: true, summary: 'verified', findings: [] }));
    });

    const loop = new QualityLoop();
    await (loop as any).maybeReview(task.id);

    expect(getTask(task.id)?.status).toBe('done');
    expect(listQualityLoopAttempts({ taskId: task.id }).at(-1)).toMatchObject({ status: 'approved' });
    const children = listTasks({ parentTaskId: task.id });
    expect(children.map(child => child.title)).toEqual(expect.arrayContaining(['Test: Implement reliable task', 'Review: Implement reliable task']));
    for (const child of children) {
      expect(child).toMatchObject({ workdir: '/workspace/project', workspacePath: '/workspace/project', workspaceId: 'workspace-a', modelId: 'gpt-5', reasoningEffort: 'high', contextLength: 128_000 });
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no Test/QA agent', undefined, undefined, 'no available Test/QA agent'],
    ['test validation failure', 'qa', JSON.stringify({ command: 'pnpm test', cwd: '/workspace/project', exitCode: 1, stdout: '', stderr: 'failure', failedTests: ['fails'] }), 'Test/QA validation failed'],
    ['no Reviewer agent', 'qa', JSON.stringify({ command: 'pnpm test', cwd: '/workspace/project', exitCode: 0, stdout: 'passed', stderr: '', failedTests: [] }), 'no available Reviewer agent'],
  ])('marks the developer task failed when %s blocks the gate', async (_caseName, testAgentId, testOutput, expectedError) => {
    const { task } = createDeveloperTask();
    if (testAgentId) createAgent({ id: testAgentId, name: 'QA', role: 'qa', config: { maxConcurrent: 1 } });
    const execute = vi.spyOn(agentRuntime, 'execute').mockResolvedValue(result(testOutput || ''));

    const loop = new QualityLoop();
    await (loop as any).maybeReview(task.id);

    expect(getTask(task.id)).toMatchObject({ status: 'failed', error: expect.stringContaining(expectedError) });
    expect(listQualityLoopAttempts({ taskId: task.id }).at(-1)).toMatchObject({ status: 'failed' });
    expect(execute).toHaveBeenCalledTimes(testAgentId ? 1 : 0);
  });

  it('preserves workdir and model through Master decomposition and its Test/Review children', async () => {
    createAgent({ id: 'master', name: 'Master', role: 'orchestrator', config: { maxConcurrent: 1 } });
    createAgent({ id: 'developer', name: 'Developer', role: 'dev', config: { maxConcurrent: 1 } });
    createAgent({ id: 'qa', name: 'QA', role: 'qa', config: { maxConcurrent: 1 } });
    createAgent({ id: 'review', name: 'Reviewer', role: 'reviewer', config: { maxConcurrent: 1 } });
    const parent = createTask({
      title: 'Master task', description: 'Create one implementation task', input: 'Create one implementation task', mode: 'master',
      workdir: '/workspace/master-project', workspaceId: 'workspace-master', modelId: 'gpt-5', reasoningEffort: 'high', contextLength: 128_000,
    });
    const enqueue = vi.fn(async (data: any) => createTask(data));
    const master = new MasterAgent({ enqueue } as unknown as TaskQueue);
    vi.useFakeTimers();
    vi.spyOn(agentRuntime, 'execute').mockImplementation(async (agent, task) => {
      if (task.title.startsWith('Plan:')) return result(JSON.stringify([{ title: 'Implement child', description: 'Implement it', role: 'dev', dependencies: [] }]));
      if (agent.id === 'qa') return result(JSON.stringify({ command: 'pnpm test', cwd: '/workspace/master-project', exitCode: 0, stdout: 'passed', stderr: '', failedTests: [] }));
      return result(JSON.stringify({ approved: true, findings: [] }));
    });

    const [child] = await master.decompose(parent);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ workdir: '/workspace/master-project', workspaceId: 'workspace-master', modelId: 'gpt-5', reasoningEffort: 'high', contextLength: 128_000 }));
    updateTask(child.id, { status: 'done', output: 'implemented' });
    const loop = new QualityLoop();
    await (loop as any).maybeReview(child.id);

    const qaChildren = listTasks({ parentTaskId: child.id });
    expect(qaChildren).toHaveLength(2);
    for (const qaChild of qaChildren) {
      expect(qaChild).toMatchObject({ workdir: '/workspace/master-project', workspaceId: 'workspace-master', modelId: 'gpt-5', reasoningEffort: 'high', contextLength: 128_000 });
    }
    vi.clearAllTimers();
  });

  it.each(['TIMED_OUT', 'STALLED'])('persists heartbeat/checkpoint hints and classifies %s as a terminal runtime failure', async (expected) => {
    const agent = createAgent({ id: `runtime-${expected}`, name: 'Runtime Dev', role: 'dev', config: { maxConcurrent: 1 } });
    const task = createTask({ title: expected, description: expected, input: 'work', mode: 'direct', assigneeId: agent.id });
    addTaskLog(task.id, 'info', 'Runtime checkpoint: started; execution=execution-1', agent.id);
    addTaskLog(task.id, 'info', 'Runtime heartbeat: execution=execution-1; idle=30s', agent.id);
    const queue = new TaskQueue({ executeTask: vi.fn(async () => { throw new Error(`${expected}: simulated runtime boundary`); }) } as any);

    await expect((queue as any).processJob(task.id, { attemptsMade: 0, opts: { attempts: 1 } })).rejects.toThrow(expected);
    expect(getTask(task.id)).toMatchObject({ status: 'failed', error: expect.stringContaining(expected) });
    const messages = getTaskLogs(task.id).map(log => log.message);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('Runtime checkpoint: started'),
      expect.stringContaining('Runtime heartbeat:'),
      expect.stringContaining(`[${expected.toLowerCase()}]`),
    ]));
  });

  it('re-queues an interrupted leaf from its persisted checkpoint hint after restart', async () => {
    const agent = createAgent({ id: 'recovery-dev', name: 'Recovery Dev', role: 'dev', config: { maxConcurrent: 1 } });
    const task = createTask({ title: 'Recover', description: 'Recover', input: 'Recover', mode: 'direct', assigneeId: agent.id });
    updateTask(task.id, { status: 'running' });
    addTaskLog(task.id, 'info', 'Runtime checkpoint: tool result; execution=execution-2', agent.id);
    const recovered: string[] = [];
    const queue = new TaskQueue({ executeTask: vi.fn(async (_agentId: string, recoveredTask: any) => { recovered.push(recoveredTask.id); }) } as any);

    await queue.recoverRunningTasks();
    expect(recovered).toContain(task.id);
    expect(getTaskLogs(task.id).some(log => log.message.includes('cannot resume an in-flight process'))).toBe(true);
  });
});
