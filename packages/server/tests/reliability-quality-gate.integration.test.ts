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
import { createQualityLoopAttempt, listQualityLoopAttempts } from '../src/db/models/quality-loop.js';
import { createExecution, addExecutionMessage } from '../src/db/models/execution.js';
import * as toolPolicy from '../src/tools/tool-policy.js';

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

  function createDeveloperTask(mode: 'direct' | 'master' = 'direct', conversation?: string) {
    const developer = createAgent({ id: 'developer', name: 'Developer', role: 'dev', config: { maxConcurrent: 1, timeout: 300 } });
    const task = createTask({
      title: conversation ?? 'Implement reliable task', description: conversation ?? 'Implement and validate it', input: conversation ?? 'Implement it', mode,
      assigneeId: developer.id, workdir: '/workspace/project', workspacePath: '/workspace/project', workspaceId: 'workspace-a',
      modelId: 'gpt-5', reasoningEffort: 'high', contextLength: 128_000, domainId: 'software',
    });
    updateTask(task.id, { status: 'done', output: 'implementation completed' });
    return { developer, task: getTask(task.id)! };
  }

  it.each(['hello', '你好', '你可以帮我干什么'])('does not send standalone %s to code QA', async input => {
    const { task } = createDeveloperTask('direct', input);
    const execute = vi.spyOn(agentRuntime, 'execute');
    await (new QualityLoop() as any).maybeReview(task.id);
    expect(getTask(task.id)?.status).toBe('done');
    expect(listQualityLoopAttempts({ taskId: task.id })).toHaveLength(0);
    expect(listTasks({ parentTaskId: task.id })).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not use small talk to exempt a run which actually invoked tools', async () => {
    const { task } = createDeveloperTask('direct', 'hello');
    const run = createExecution({ taskId: task.id, agentDefId: 'developer' });
    addExecutionMessage({ executionId: run.id, type: 'tool_use', toolName: 'file_write', content: '{}' });
    await (new QualityLoop() as any).maybeReview(task.id);
    expect(getTask(task.id)?.status).toBe('failed'); // No QA available; fail closed.
    expect(listQualityLoopAttempts({ taskId: task.id })).toHaveLength(1);
  });

  it('does not repeat a historically misapplied failed QA gate after a tool-free greeting retry', async () => {
    const { task } = createDeveloperTask('direct', 'hello');
    createQualityLoopAttempt({ taskId: task.id, iteration: 1, status: 'failed', developerAgentId: 'developer' });
    const execute = vi.spyOn(agentRuntime, 'execute');
    await (new QualityLoop() as any).maybeReview(task.id);
    expect(getTask(task.id)?.status).toBe('done');
    expect(listQualityLoopAttempts({ taskId: task.id })).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not QA a new user greeting in an existing failed conversation, or rewrite the failed root', async () => {
    const { task: parent } = createDeveloperTask();
    updateTask(parent.id, { status: 'failed', error: 'Earlier implementation failed' });
    const child = createTask({ title: 'hello', description: 'hello', mode: 'direct', createdBy: 'user',
      assigneeId: 'developer', parentTaskId: parent.id,
      input: `Continue the conversation below and answer the NEW user message.\n\nSession root: ${parent.id}\n\nRecent turns:\n[]\n\nNEW user message:\nhello` });
    updateTask(child.id, { status: 'done', output: 'Hello!' });
    const execute = vi.spyOn(agentRuntime, 'execute');
    await (new QualityLoop() as any).maybeReview(child.id);
    expect(getTask(child.id)?.status).toBe('done');
    expect(getTask(parent.id)?.status).toBe('failed');
    expect(listQualityLoopAttempts({ taskId: child.id })).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails promptly without starting QA when command authorization is missing', async () => {
    const { task } = createDeveloperTask();
    createAgent({ id: 'qa', name: 'QA', role: 'qa', config: { maxConcurrent: 1 } });
    vi.spyOn(toolPolicy, 'resolveAllowedToolsForAgent').mockReturnValue({
      requestedTools: ['shell_exec'], allowedTools: [],
      decisions: [{ toolId: 'shell_exec', allowed: false, reason: 'approval_required', approvalRequired: true }],
    });
    const execute = vi.spyOn(agentRuntime, 'execute');
    await (new QualityLoop() as any).maybeReview(task.id);
    expect(getTask(task.id)?.error).toContain('command execution requires approval');
    expect(execute).not.toHaveBeenCalled();
    expect(listTasks({ parentTaskId: task.id })).toHaveLength(0);
  });

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
