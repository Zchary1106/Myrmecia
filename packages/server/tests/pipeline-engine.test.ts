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

describe('PipelineEngine autonomous-publish safety guard', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-pipeline-autopublish-')), 'test.db');
    getDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  function createPublisherAgentAndTemplate() {
    createAgent({
      name: 'Social Publisher',
      role: 'social-publisher',
      allowedTools: ['mcp__xiaohongshu__publish_content', 'mcp__douyin-upload__douyin_upload_video'],
    });
    return createTemplate({
      name: 'Publish Template',
      stages: [{ name: 'Publish', role: 'social-publisher', promptTemplate: 'Publish {input}' }],
    });
  }

  function createNonPublishingTemplate() {
    createAgent({ name: 'Dev', role: 'developer', allowedTools: ['file_read', 'file_write'] });
    return createTemplate({
      name: 'Engineering Template',
      stages: [{ name: 'Build', role: 'developer', promptTemplate: 'Build {input}' }],
    });
  }

  // `create()` fires off stage execution in the background (fire-and-forget); a stub that
  // reports "no agent available" keeps that background call harmless in this unit test
  // instead of throwing on a real AgentManager method the fake object doesn't implement.
  const stubAgentManager = { findAvailableAgent: () => undefined } as unknown as AgentManager;

  it('forces gateMode to manual for a publish-capable template requesting auto without confirmation', async () => {
    const template = createPublisherAgentAndTemplate();
    const engine = new PipelineEngine({} as TaskQueue, stubAgentManager);

    const pipeline = await engine.create({
      name: 'Auto run, no confirmation',
      templateId: template.id,
      input: 'ship a post',
      gateMode: 'auto',
    });

    expect(pipeline.gateMode).toBe('manual');
  });

  it('forces gateMode to manual for a publish-capable template when gateMode is omitted entirely', async () => {
    // Omitting gateMode defaults to 'auto' further down the stack (db/models/pipeline.ts),
    // so this must be forced to manual too, not just the explicit gateMode: 'auto' case.
    const template = createPublisherAgentAndTemplate();
    const engine = new PipelineEngine({} as TaskQueue, stubAgentManager);

    const pipeline = await engine.create({
      name: 'Auto run, gateMode omitted',
      templateId: template.id,
      input: 'ship a post',
    });

    expect(pipeline.gateMode).toBe('manual');
  });

  it('allows gateMode auto for a publish-capable template only when explicitly confirmed', async () => {
    const template = createPublisherAgentAndTemplate();
    const engine = new PipelineEngine({} as TaskQueue, stubAgentManager);

    const pipeline = await engine.create({
      name: 'Auto run, confirmed',
      templateId: template.id,
      input: 'ship a post',
      gateMode: 'auto',
      confirmAutonomousPublish: true,
    });

    expect(pipeline.gateMode).toBe('auto');
  });

  it('always honors an explicit manual request regardless of confirmation', async () => {
    const template = createPublisherAgentAndTemplate();
    const engine = new PipelineEngine({} as TaskQueue, stubAgentManager);

    const pipeline = await engine.create({
      name: 'Manual run',
      templateId: template.id,
      input: 'ship a post',
      gateMode: 'manual',
    });

    expect(pipeline.gateMode).toBe('manual');
  });

  it('leaves non-publishing templates unaffected by the guard', async () => {
    const template = createNonPublishingTemplate();
    const engine = new PipelineEngine({} as TaskQueue, stubAgentManager);

    const autoPipeline = await engine.create({
      name: 'Engineering auto run',
      templateId: template.id,
      input: 'build the feature',
      gateMode: 'auto',
    });
    expect(autoPipeline.gateMode).toBe('auto');

    const defaultPipeline = await engine.create({
      name: 'Engineering default run',
      templateId: template.id,
      input: 'build the feature',
    });
    expect(defaultPipeline.gateMode).toBe('auto');
  });
});
