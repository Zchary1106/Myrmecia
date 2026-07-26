import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentManager } from '../src/agents/agent-manager.js';
import { closeDb, getDb } from '../src/db/database.js';
import { createPipeline, getPipeline, listTemplates, updatePipeline } from '../src/db/models/pipeline.js';
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

  it('syncs changed YAML templates without replacing their persisted IDs', async () => {
    const templatesDir = mkdtempSync(join(tmpdir(), 'agent-factory-pipeline-templates-'));
    const templatePath = join(templatesDir, 'feature.yaml');
    const engine = new PipelineEngine({} as TaskQueue, {} as AgentManager);

    writeFileSync(templatePath, `
name: Feature
description: Initial version
stages:
  - name: Spec
    role: product-manager
    prompt_template: "Write a spec for {input}"
`, 'utf-8');
    await engine.loadTemplates(templatesDir);

    const initial = listTemplates().find(template => template.name === 'Feature');
    expect(initial).toMatchObject({
      description: 'Initial version',
      stages: [{ name: 'Spec', role: 'product-manager', promptTemplate: 'Write a spec for {input}' }],
    });

    writeFileSync(templatePath, `
name: Feature
description: Updated version
stages:
  - name: Spec
    role: product-manager
    prompt_template: "Write a spec for {input}"
  - name: Implement
    role: developer
    depends_on: [0]
    prompt_template: "Implement {input}"
`, 'utf-8');
    await engine.loadTemplates(templatesDir);

    const synced = listTemplates().find(template => template.name === 'Feature');
    expect(synced?.id).toBe(initial?.id);
    expect(synced).toMatchObject({
      description: 'Updated version',
      stages: [
        { name: 'Spec', role: 'product-manager', promptTemplate: 'Write a spec for {input}' },
        { name: 'Implement', role: 'developer', promptTemplate: 'Implement {input}', dependsOn: [0] },
      ],
    });
  });
});
