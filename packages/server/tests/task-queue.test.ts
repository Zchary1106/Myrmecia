import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentManager } from '../src/agents/agent-manager.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import { closeDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask, getTask, getTaskLogs } from '../src/db/models/task.js';

describe('TaskQueue failure state handling', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-task-queue-')), 'test.db');
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
    vi.restoreAllMocks();
  });

  it('marks pre-runtime BullMQ failures as failed after the final attempt', async () => {
    const agent = createAgent({ id: 'queue-agent', name: 'Queue Agent', role: 'dev' });
    const task = createTask({
      title: 'Queue failure',
      description: 'Queue failure',
      input: 'run',
      mode: 'direct',
      assigneeId: agent.id,
      maxRetries: 0,
    });
    const manager = {
      executeTask: vi.fn(async () => {
        throw new Error('Agent queue-agent at max concurrency (1)');
      }),
    } as unknown as AgentManager;
    const queue = new TaskQueue(manager);

    await expect((queue as any).processJob(task.id, { attemptsMade: 0, opts: { attempts: 1 } }))
      .rejects.toThrow('max concurrency');

    const stored = getTask(task.id)!;
    expect(stored.status).toBe('failed');
    expect(stored.error).toContain('max concurrency');
    expect(getTaskLogs(task.id).some(log => log.message.includes('Execution failed after 1/1 attempts'))).toBe(true);
  });

  it('returns pre-runtime BullMQ failures to queued while retries remain', async () => {
    const agent = createAgent({ id: 'retry-agent', name: 'Retry Agent', role: 'dev' });
    const task = createTask({
      title: 'Queue retry',
      description: 'Queue retry',
      input: 'run',
      mode: 'direct',
      assigneeId: agent.id,
      maxRetries: 1,
    });
    const manager = {
      executeTask: vi.fn(async () => {
        throw new Error('temporary capacity');
      }),
    } as unknown as AgentManager;
    const queue = new TaskQueue(manager);

    await expect((queue as any).processJob(task.id, { attemptsMade: 0, opts: { attempts: 2 } }))
      .rejects.toThrow('temporary capacity');

    const stored = getTask(task.id)!;
    expect(stored.status).toBe('queued');
    expect(stored.error).toBe('temporary capacity');
  });
});
