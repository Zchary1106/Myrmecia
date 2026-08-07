import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentManager } from '../src/agents/agent-manager.js';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createPipeline, createTemplate, getPipeline, listTemplates, updatePipeline } from '../src/db/models/pipeline.js';
import { createTask, updateTask } from '../src/db/models/task.js';
import {
  PipelineEngine,
  PublishConfirmationRequiredError,
  PublishStageSkipForbiddenError,
  parseDeclaredVideoPath,
} from '../src/pipelines/pipeline-engine.js';
import { PUBLISH_RECONFIRMATION_ERROR, TaskQueue } from '../src/queue/task-queue.js';
import { workspaceManager } from '../src/workspace/workspace-manager.js';
import { buildMcpPolicyContext } from '../src/agents/ts-agent-loop.js';

describe('Douyin video input parsing', () => {
  it('extracts quoted and unquoted video paths without consuming later lines', () => {
    expect(parseDeclaredVideoPath('topic: Codex\nvideo_path: /Users/me/Videos/final cut.mp4\naudience: developers'))
      .toBe('/Users/me/Videos/final cut.mp4');
    expect(parseDeclaredVideoPath('videoPath: \"/tmp/final.mp4\"'))
      .toBe('/tmp/final.mp4');
    expect(parseDeclaredVideoPath('topic only')).toBeUndefined();
  });
});

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
    publish_tools: [mcp__wechat-official-account__wechat_publish]
    prompt_template: "Implement {input}"
`, 'utf-8');
    await engine.loadTemplates(templatesDir);

    const synced = listTemplates().find(template => template.name === 'Feature');
    expect(synced?.id).toBe(initial?.id);
    expect(synced).toMatchObject({
      description: 'Updated version',
      stages: [
        { name: 'Spec', role: 'product-manager', promptTemplate: 'Write a spec for {input}' },
        {
          name: 'Implement',
          role: 'developer',
          promptTemplate: 'Implement {input}',
          dependsOn: [0],
          publishTools: ['mcp__wechat-official-account__wechat_publish'],
        },
      ],
    });

  });

  it('recovers an interrupted publisher as awaiting a newly confirmed retry', async () => {
    createAgent({
      id: 'social-publisher',
      name: 'Social Publisher',
      role: 'social-publisher',
      allowedTools: ['mcp__wechat-official-account__wechat_publish'],
    });
    const pipeline = createPipeline({
      name: 'Interrupted publish',
      input: 'publish',
      gateMode: 'manual',
      stages: [{
        index: 0,
        name: 'Publish',
        agentRole: 'social-publisher',
        status: 'running',
        publishTools: ['mcp__wechat-official-account__wechat_publish'],
      }],
    });
    const task = createTask({
      title: 'Interrupted publisher',
      description: 'Interrupted publisher',
      input: 'publish',
      mode: 'pipeline',
      assigneeId: 'social-publisher',
      pipelineId: pipeline.id,
      stageIndex: 0,
    });
    updateTask(task.id, {
      status: 'failed',
      error: PUBLISH_RECONFIRMATION_ERROR,
      completedAt: new Date().toISOString(),
    });
    updatePipeline(pipeline.id, {
      status: 'running',
      currentStageIndex: 0,
      stages: [{ ...pipeline.stages[0], taskId: task.id }],
    });

    const engine = new PipelineEngine({} as TaskQueue, {} as AgentManager);
    await engine.recoverInterruptedPipelines();

    expect(getPipeline(pipeline.id)).toMatchObject({
      status: 'awaiting_retry',
      stages: [{ status: 'rolled_back', taskId: task.id }],
    });
    await expect(engine.retryStage(pipeline.id, 0)).rejects.toBeInstanceOf(PublishConfirmationRequiredError);
  });
});

describe('PipelineEngine autonomous-publish safety guard', () => {
  const createdPipelineIds: string[] = [];

  beforeEach(() => {
    createdPipelineIds.length = 0;
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-pipeline-autopublish-')), 'test.db');
    getDb();
  });

  afterEach(async () => {
    for (const pipelineId of createdPipelineIds) {
      await workspaceManager.cleanupWorkspace(pipelineId);
    }
    closeDb();
    delete process.env.DB_PATH;
  });

  function createPublisherAgentAndTemplate() {
    createAgent({
      name: 'Social Publisher',
      role: 'social-publisher',
      allowedTools: [
        'mcp__xiaohongshu__publish_content',
        'mcp__douyin-upload__douyin_upload_video',
        'mcp__wechat-official-account__wechat_publish',
      ],
    });
    return createTemplate({
      name: 'Publish Template',
      stages: [{ name: 'Publish', role: 'social-publisher', promptTemplate: 'Publish {input}', dependsOn: [99] }],
    });
  }

  function createNonPublishingTemplate() {
    createAgent({ name: 'Dev', role: 'developer', allowedTools: ['file_read', 'file_write'] });
    return createTemplate({
      name: 'Engineering Template',
      stages: [{ name: 'Build', role: 'developer', promptTemplate: 'Build {input}', dependsOn: [99] }],
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
    createdPipelineIds.push(pipeline.id);

    expect(pipeline.gateMode).toBe('manual');
  });

  it('does not start a first-stage publisher without an explicit approval', async () => {
    createAgent({
      id: 'social-publisher',
      name: 'First Stage Publisher',
      role: 'social-publisher',
      allowedTools: ['mcp__wechat-official-account__wechat_publish'],
    });
    const template = createTemplate({
      name: 'Publish First Template',
      stages: [{ name: 'Publish', role: 'social-publisher', promptTemplate: 'Publish {input}' }],
    });
    const engine = new PipelineEngine({} as TaskQueue, stubAgentManager);

    const pipeline = await engine.create({
      name: 'Unsafe publish first',
      templateId: template.id,
      input: 'draft-approved-12345',
      gateMode: 'manual',
    });
    createdPipelineIds.push(pipeline.id);

    expect(getPipeline(pipeline.id)).toMatchObject({
      status: 'paused',
      currentStageIndex: -1,
      stages: [{ status: 'pending' }],
    });
    expect(getPipeline(pipeline.id)?.stages[0].taskId).toBeUndefined();
  });

  it('treats WeChat publish capability as human-gated', async () => {
    createAgent({
      name: 'WeChat Publisher',
      role: 'wechat-publisher',
      allowedTools: ['mcp__wechat-official-account__wechat_publish'],
    });
    const template = createTemplate({
      name: 'WeChat Publish Template',
      stages: [{ name: 'Publish', role: 'wechat-publisher', promptTemplate: 'Publish {input}', dependsOn: [99] }],
    });
    const engine = new PipelineEngine({} as TaskQueue, stubAgentManager);

    const pipeline = await engine.create({
      name: 'WeChat auto run',
      templateId: template.id,
      input: 'publish the draft',
      gateMode: 'auto',
    });
    createdPipelineIds.push(pipeline.id);

    expect(pipeline.gateMode).toBe('manual');
  });

  it('requires explicit server-side confirmation and forbids skip before publishing', async () => {
    createPublisherAgentAndTemplate();
    const pipeline = createPipeline({
      name: 'Paused before publish',
      input: 'approved draft',
      gateMode: 'manual',
      stages: [
        { index: 0, name: 'Draft', agentRole: 'developer', status: 'done' },
        { index: 1, name: 'Publish', agentRole: 'social-publisher', status: 'pending' },
      ],
    });
    createdPipelineIds.push(pipeline.id);
    updatePipeline(pipeline.id, {
      status: 'paused',
      currentStageIndex: 0,
      stages: pipeline.stages,
    });
    const engine = new PipelineEngine({} as TaskQueue, stubAgentManager);

    await expect(engine.approveGate(pipeline.id)).rejects.toBeInstanceOf(PublishConfirmationRequiredError);
    await expect(engine.skipStage(pipeline.id)).rejects.toBeInstanceOf(PublishStageSkipForbiddenError);
    await expect(engine.resume(pipeline.id)).rejects.toBeInstanceOf(PublishConfirmationRequiredError);

    expect(getPipeline(pipeline.id)).toMatchObject({
      status: 'paused',
      currentStageIndex: 0,
      stages: [
        { status: 'done' },
        { status: 'pending' },
      ],
    });

    updatePipeline(pipeline.id, {
      status: 'failed',
      currentStageIndex: 1,
      stages: [
        pipeline.stages[0],
        { ...pipeline.stages[1], status: 'rolled_back' },
      ],
    });
    await expect(engine.retryStage(pipeline.id, 1)).rejects.toBeInstanceOf(PublishConfirmationRequiredError);
    updatePipeline(pipeline.id, { gateMode: 'auto' });
    await expect(engine.retryStage(pipeline.id, 1)).rejects.toBeInstanceOf(PublishConfirmationRequiredError);
  });

  it('authorizes MCP publishing only for the task attached to the running publish stage', () => {
    const publisher = createAgent({
      id: 'social-publisher',
      name: 'Context Publisher',
      role: 'social-publisher',
      allowedTools: ['mcp__wechat-official-account__wechat_publish'],
    });
    const pipeline = createPipeline({
      name: 'Authorized publish context',
      input: 'article brief',
      gateMode: 'manual',
      stages: [
        {
          index: 0,
          name: 'Draft',
          agentRole: 'wechat-writer',
          status: 'done',
          output: '草稿ID: draft-approved-12345',
          taskId: 'draft-task-1',
        },
        {
          index: 1,
          name: 'Publish',
          agentRole: 'social-publisher',
          status: 'running',
          publishTools: ['mcp__wechat-official-account__wechat_publish'],
        },
      ],
    });
    createdPipelineIds.push(pipeline.id);
    const task = createTask({
      title: 'Publish task',
      description: 'Publish approved draft',
      input: 'Publish draft-approved-12345',
      mode: 'pipeline',
      assigneeId: publisher.id,
      pipelineId: pipeline.id,
      stageIndex: 1,
    });
    updatePipeline(pipeline.id, {
      status: 'running',
      currentStageIndex: 1,
      stages: [
        pipeline.stages[0],
        { ...pipeline.stages[1], taskId: task.id },
      ],
    });
    updateTask(task.id, { status: 'running' });

    expect(buildMcpPolicyContext(publisher, task)).toMatchObject({
      publishAuthorized: true,
      approvedDraftTaskIds: ['draft-task-1'],
      approvedPublishTools: ['mcp__wechat-official-account__wechat_publish'],
      publishAuthorizationId: task.id,
    });
    expect(buildMcpPolicyContext(publisher, { ...task, id: 'forged-task-id' })).not.toHaveProperty('publishAuthorized');
    updateTask(task.id, { retryCount: 1 });
    expect(buildMcpPolicyContext(publisher, task)).not.toHaveProperty('publishAuthorized');
    updateTask(task.id, { status: 'cancelled', retryCount: 0 });
    expect(buildMcpPolicyContext(publisher, task)).not.toHaveProperty('publishAuthorized');
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
    createdPipelineIds.push(pipeline.id);

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
    createdPipelineIds.push(pipeline.id);

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
    createdPipelineIds.push(pipeline.id);

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
    createdPipelineIds.push(autoPipeline.id);
    expect(autoPipeline.gateMode).toBe('auto');

    const defaultPipeline = await engine.create({
      name: 'Engineering default run',
      templateId: template.id,
      input: 'build the feature',
    });
    createdPipelineIds.push(defaultPipeline.id);
    expect(defaultPipeline.gateMode).toBe('auto');
  });
});
