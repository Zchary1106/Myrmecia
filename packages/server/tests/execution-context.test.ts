import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../src/db/database.js';
import { getExecutionContext, getLatestTaskCheckpoint, listTaskCheckpoints } from '../src/db/models/execution-context.js';
import {
  checkpointExecutionContext,
  persistExecutionContext,
  persistInheritedExecutionContext,
} from '../src/agents/execution-context.js';
import { createTask } from '../src/db/models/task.js';

let testDir = '';

describe('durable execution context', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'myrmecia-execution-context-'));
    process.env.DB_PATH = join(testDir, 'test.db');
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('preserves the root execution contract while keeping legacy Task inputs compatible', () => {
    const stored = createTask({ title: 'Root', description: 'Implement feature', mode: 'master', input: 'Build it', workspaceId: 'ws-1', workspacePath: '/repo', workdir: '/repo', modelId: 'gpt-5', reasoningEffort: 'high', contextLength: 128000 });
    const context = persistExecutionContext(stored, {
      provider: 'copilot', constraints: ['Do not change public API'], codeBaseline: { revision: 'abc123', branch: 'main' },
    });
    expect(context).toMatchObject({ taskId: stored.id, workspaceId: 'ws-1', workspacePath: '/repo', workdir: '/repo', provider: 'copilot', modelId: 'gpt-5', reasoningEffort: 'high', contextLength: 128000, goal: 'Implement feature', constraints: ['Do not change public API'], codeBaseline: { revision: 'abc123' } });
    expect(getExecutionContext(stored.id)).toMatchObject({ id: context.id, taskId: stored.id });
  });

  it('inherits the same context through Master and QA child tasks', () => {
    const parent = createTask({ title: 'Parent', description: 'Build feature', mode: 'master', input: 'Build it', workspaceId: 'ws-1', workspacePath: '/repo', workdir: '/repo', modelId: 'gpt-5', reasoningEffort: 'xhigh', contextLength: 128000 });
    const masterChild = createTask({ title: 'Implement', description: 'Implement module', mode: 'direct', input: 'Implement', parentTaskId: parent.id });
    const qaChild = createTask({ title: 'Review', description: 'Review module', mode: 'direct', input: 'Review', parentTaskId: masterChild.id });
    const parentContext = persistExecutionContext(parent, { provider: 'copilot', constraints: ['Run tests'], codeBaseline: { revision: 'base-1' } });
    const devContext = persistInheritedExecutionContext(parentContext, masterChild);
    const qaContext = persistInheritedExecutionContext(devContext, qaChild);
    expect(devContext).toMatchObject({ workspaceId: 'ws-1', workspacePath: '/repo', workdir: '/repo', provider: 'copilot', modelId: 'gpt-5', reasoningEffort: 'xhigh', contextLength: 128000, constraints: ['Run tests'], codeBaseline: { revision: 'base-1' }, parentTaskId: parent.id });
    expect(qaContext).toMatchObject({ workspaceId: 'ws-1', workspacePath: '/repo', workdir: '/repo', provider: 'copilot', modelId: 'gpt-5', reasoningEffort: 'xhigh', contextLength: 128000, constraints: ['Run tests'], codeBaseline: { revision: 'base-1' }, parentTaskId: masterChild.id });
  });

  it('preserves inherited constraints and baseline when runtime persists resolved execution fields', () => {
    const parent = createTask({ title: 'Parent', description: 'Build feature', mode: 'master', input: 'Build it', workspaceId: 'ws-1', workspacePath: '/repo', workdir: '/repo', modelId: 'gpt-5' });
    const child = createTask({ title: 'Implement', description: 'Implement module', mode: 'direct', input: 'Implement', parentTaskId: parent.id });
    const parentContext = persistExecutionContext(parent, { provider: 'copilot', constraints: ['Run tests'], codeBaseline: { revision: 'base-1' } });
    persistInheritedExecutionContext(parentContext, child);

    const savedDuringRuntime = persistExecutionContext({ ...child, workspacePath: '/repo/.myrmecia/tasks/child', workdir: '/repo/.myrmecia/tasks/child' }, {
      modelId: 'gpt-5.5', provider: 'copilot',
    });
    expect(savedDuringRuntime).toMatchObject({
      workspacePath: '/repo/.myrmecia/tasks/child', workdir: '/repo/.myrmecia/tasks/child',
      modelId: 'gpt-5.5', provider: 'copilot', constraints: ['Run tests'],
      codeBaseline: { revision: 'base-1' }, parentTaskId: parent.id,
    });
  });

  it('appends and reads checkpoints without overwriting recovery history', () => {
    const stored = createTask({ title: 'Root', description: 'Implement feature', mode: 'direct', input: 'Build it' });
    const context = persistExecutionContext(stored);
    checkpointExecutionContext(context, { phase: 'developing', completed: ['plan'], pending: ['implement'], blocked: [], resumeHint: 'Continue implementation' });
    const latest = checkpointExecutionContext(context, { phase: 'testing', completed: ['plan', 'implement'], pending: ['test'], blocked: ['redis unavailable'], lastValidation: { command: 'pnpm test', exitCode: 1 }, resumeHint: 'Fix test failure' });
    expect(listTaskCheckpoints(stored.id)).toHaveLength(2);
    expect(getLatestTaskCheckpoint(stored.id)).toMatchObject({ id: latest.id, phase: 'testing', blocked: ['redis unavailable'], lastValidation: { exitCode: 1 }, resumeHint: 'Fix test failure' });
  });
});
