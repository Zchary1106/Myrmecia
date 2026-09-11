import { describe, expect, it } from 'vitest';
import { createTask, updateTask } from './task.js';
import {
  createExecution,
  getActiveExecutionCount,
  getExecution,
  reconcileTerminalTaskExecutions,
} from './execution.js';

function createTerminalTask(status: 'done' | 'failed' | 'cancelled') {
  const task = createTask({
    title: `Reconcile ${status} execution`,
    description: 'Verify terminal tasks do not retain an active execution slot',
    mode: 'direct',
    input: 'noop',
  });
  updateTask(task.id, { status, completedAt: new Date().toISOString() });
  return task;
}

describe('execution reconciliation', () => {
  it('finalizes a running execution when its task is done', () => {
    const task = createTerminalTask('done');
    const execution = createExecution({ taskId: task.id, agentDefId: 'reconcile-dev' });

    const reconciled = reconcileTerminalTaskExecutions('reconcile-dev');

    expect(reconciled.map(item => item.id)).toContain(execution.id);
    expect(getExecution(execution.id)).toMatchObject({
      status: 'done',
    });
    expect(getExecution(execution.id)?.completedAt).toBeTruthy();
  });

  it('uses the terminal task state and excludes stale executions from capacity', () => {
    const failedTask = createTerminalTask('failed');
    const cancelledTask = createTerminalTask('cancelled');
    const failedExecution = createExecution({ taskId: failedTask.id, agentDefId: 'reconcile-qa' });
    const cancelledExecution = createExecution({ taskId: cancelledTask.id, agentDefId: 'reconcile-qa' });

    // Capacity reads perform reconciliation too, so old crash residue cannot
    // leave an Agent permanently unavailable.
    expect(getActiveExecutionCount('reconcile-qa')).toBe(0);
    expect(getExecution(failedExecution.id)?.status).toBe('failed');
    expect(getExecution(cancelledExecution.id)?.status).toBe('cancelled');
  });
});
