import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask, getTask, updateTask } from '../src/db/models/task.js';
import { TaskQueue } from '../src/queue/task-queue.js';

const describeRedis = process.env.REDIS_URL ? describe : describe.skip;

describeRedis('TaskQueue Redis restart recovery', () => {
  let queue: TaskQueue;

  beforeEach(async () => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-redis-recovery-')), 'test.db');
    getDb();
    queue = new TaskQueue({ executeTask: vi.fn() } as any);
    await (queue as any).queue?.obliterate({ force: true });
  });

  afterEach(async () => {
    await queue?.shutdown();
    closeDb();
    delete process.env.DB_PATH;
  });

  it('requeues an interrupted task from its durable checkpoint on a new queue instance', async () => {
    const agent = createAgent({ id: 'redis-agent', name: 'Redis Agent', role: 'dev' });
    const task = createTask({ title: 'restart', description: 'restart', input: 'run', mode: 'direct', assigneeId: agent.id });
    updateTask(task.id, { status: 'running' });

    // Simulate the original process going away before a new server constructs
    // its queue and invokes recovery.
    await queue.shutdown();
    queue = new TaskQueue({ executeTask: vi.fn() } as any);
    await queue.recoverRunningTasks();

    expect(getTask(task.id)?.status).toBe('pending');
    await expect(queue.getStats()).resolves.toMatchObject({ backend: 'redis', waiting: 1, prioritized: 1 });
  });
});
