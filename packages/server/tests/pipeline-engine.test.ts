import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentManager } from '../src/agents/agent-manager.js';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createPipeline, createTemplate, getPipeline, listTemplates, updatePipeline } from '../src/db/models/pipeline.js';
import { createTask, updateTask } from '../src/db/models/task.js';
import { PipelineEngine } from '../src/pipelines/pipeline-engine.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import { workspaceManager } from '../src/workspace/workspace-manager.js';

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

  it('syncs changed YAML templates without replacing persisted IDs', async () => {
    const templatesDir = mkdtempSync(join(tmpdir(), 'agent-factory-content-templates-'));
    const templatePath = join(templatesDir, 'content.yaml');
    const engine = new PipelineEngine({} as TaskQueue, {} as AgentManager);
    writeFileSync(templatePath, `
name: Content Workflow
description: Initial
stages:
  - name: Research
    role: trend-scout
    prompt_template: "Research {input}"
`, 'utf-8');
    await engine.loadTemplates(templatesDir);
    const initial = listTemplates().find(template => template.name === 'Content Workflow');

    writeFileSync(templatePath, `
name: Content Workflow
description: Updated
stages:
  - name: Research
    role: trend-scout
    prompt_template: "Research {input}"
  - name: Draft
    role: xiaohongshu-writer
    depends_on: [0]
    prompt_template: "Draft {input}"
`, 'utf-8');
    await engine.loadTemplates(templatesDir);
    const synced = listTemplates().find(template => template.name === 'Content Workflow');

    expect(synced?.id).toBe(initial?.id);
    expect(synced?.description).toBe('Updated');
    expect(synced?.stages[1].dependsOn).toEqual([0]);
  });
});

describe('PipelineEngine publishing safety', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-publish-safety-')), 'test.db');
    getDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  const unavailableAgentManager = { findAvailableAgent: () => undefined } as unknown as AgentManager;

  function createPublishTemplate() {
    createAgent({
      id: 'publisher',
      name: 'Publisher',
      role: 'social-publisher',
      allowedTools: ['mcp__xiaohongshu__publish_content'],
    });
    return createTemplate({
      name: 'Publish Workflow',
      // Keep this unit test focused on gate resolution; an unsatisfied
      // dependency prevents create() from fire-and-forget starting a real stage.
      stages: [{ name: 'Publish', role: 'social-publisher', promptTemplate: 'Publish {input}', dependsOn: [99] }],
    });
  }

  it('forces publish-capable pipelines to manual gates by default', async () => {
    const template = createPublishTemplate();
    const pipeline = await new PipelineEngine({} as TaskQueue, unavailableAgentManager).create({
      name: 'Safe publish',
      templateId: template.id,
      input: 'publish content',
      gateMode: 'auto',
    });
    expect(pipeline.gateMode).toBe('manual');
    await workspaceManager.cleanupWorkspace(pipeline.id);
  });

  it('allows autonomous publish only after explicit confirmation', async () => {
    const template = createPublishTemplate();
    const pipeline = await new PipelineEngine({} as TaskQueue, unavailableAgentManager).create({
      name: 'Confirmed publish',
      templateId: template.id,
      input: 'publish content',
      gateMode: 'auto',
      confirmAutonomousPublish: true,
    });
    expect(pipeline.gateMode).toBe('auto');
    await workspaceManager.cleanupWorkspace(pipeline.id);
  });
});
