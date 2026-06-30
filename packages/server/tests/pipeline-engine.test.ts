import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentManager } from '../src/agents/agent-manager.js';
import { closeDb, getDb } from '../src/db/database.js';
import { createPipeline, getPipeline, updatePipeline } from '../src/db/models/pipeline.js';
import { createTask, updateTask } from '../src/db/models/task.js';
import { PipelineEngine } from '../src/pipelines/pipeline-engine.js';
import { TaskQueue } from '../src/queue/task-queue.js';

describe('PipelineEngine durable task resolution', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-pipeline-engine-')), 'test.db');
    getDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('advances a stage from persisted task metadata when the in-memory map is empty', async () => {
    const pipeline = createPipeline({
      name: 'Durable pipeline',
      input: 'ship it',
      stages: [
        { index: 0, name: 'Build', agentRole: 'dev', status: 'running' },
      ],
    });
    const task = createTask({
      title: 'Build task',
      description: 'Build task',
      input: 'ship it',
      mode: 'pipeline',
      pipelineId: pipeline.id,
      stageIndex: 0,
      workspaceId: pipeline.workspaceId,
    });
    updatePipeline(pipeline.id, {
      stages: [{ ...pipeline.stages[0], status: 'running', taskId: task.id }],
      currentStageIndex: 0,
    });
    updateTask(task.id, { status: 'done', output: 'built' });

    const engine = new PipelineEngine({} as TaskQueue, {} as AgentManager);
    await (engine as any).onTaskComplete(task.id);

    const updated = getPipeline(pipeline.id)!;
    expect(updated.status).toBe('done');
    expect(updated.stages[0].status).toBe('done');
    expect(updated.stages[0].output).toBe('built');
  });
});
