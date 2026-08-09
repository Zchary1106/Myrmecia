import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SelfHealingEngine, isNonRetryableExecutionError } from '../src/agents/self-healing.js';
import { closeDb } from '../src/db/database.js';
import { createTask, getTask, updateTask } from '../src/db/models/task.js';

describe('SelfHealingEngine — decomposition guard', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-self-heal-')), 'test.db');
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('does not revert a failed coordination parent to pending (P2 zombie regression)', async () => {
    const engine = new SelfHealingEngine();
    const parent = createTask({ title: 'parent', description: 'p', input: 'p', mode: 'master' });
    createTask({ title: 'child', description: 'c', input: 'c', mode: 'master', parentTaskId: parent.id });
    updateTask(parent.id, { status: 'failed', error: 'subtask failed' });

    await (engine as any).onTaskFailed(parent.id, 'subtask failed');

    // Parent is settled as failed by the master monitor; self-healing must leave it be.
    expect(getTask(parent.id)!.status).toBe('failed');
  });

  it('does not self-heal a decomposition subtask (leaves it terminal for the cascade/monitor)', async () => {
    const engine = new SelfHealingEngine();
    const parent = createTask({ title: 'parent', description: 'p', input: 'p', mode: 'master' });
    const child = createTask({ title: 'child', description: 'c', input: 'c', mode: 'master', parentTaskId: parent.id });
    updateTask(child.id, { status: 'failed', error: 'boom' });

    await (engine as any).onTaskFailed(child.id, 'boom');

    expect(getTask(child.id)!.status).toBe('failed');
  });

  it('still heals a normal standalone task (reverts to pending for retry)', async () => {
    const engine = new SelfHealingEngine();
    const task = createTask({ title: 'solo', description: 's', input: 's', mode: 'direct' });
    updateTask(task.id, { status: 'failed', error: 'oops' });

    await (engine as any).onTaskFailed(task.id, 'oops');

    // No assignee → not re-executed, but level-1 healing still reopens it.
    expect(getTask(task.id)!.status).toBe('pending');
  });

  it('does not retry deterministic token-budget failures', async () => {
    const engine = new SelfHealingEngine();
    const task = createTask({ title: 'large', description: 's', input: 's', mode: 'direct' });
    updateTask(task.id, { status: 'failed', error: 'agent execution exceeded token budget (40000/30000)' });

    await (engine as any).onTaskFailed(task.id, 'agent execution exceeded token budget (40000/30000)');

    expect(getTask(task.id)!.status).toBe('failed');
    expect(getTask(task.id)!.retryCount).toBe(0);
  });

  it('classifies policy and resource failures as non-retryable', () => {
    expect(isNonRetryableExecutionError('agent execution exceeded token budget (4/3)')).toBe(true);
    expect(isNonRetryableExecutionError('Publish confirmation required')).toBe(true);
    expect(isNonRetryableExecutionError('temporary provider timeout')).toBe(false);
  });
});
