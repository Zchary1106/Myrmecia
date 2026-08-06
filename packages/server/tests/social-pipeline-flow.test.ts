import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createPipeline, getPipeline, updatePipeline } from '../src/db/models/pipeline.js';
import { createTask, updateTask } from '../src/db/models/task.js';
import { PipelineEngine } from '../src/pipelines/pipeline-engine.js';
import type { AgentManager } from '../src/agents/agent-manager.js';
import type { TaskQueue } from '../src/queue/task-queue.js';

describe('social pipeline approval and validation flow', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'social-pipeline-flow-')), 'test.db');
    getDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('persists a human approval and starts all ready platform branches', async () => {
    const xhsAgent = createAgent({ id: 'xhs-agent', name: 'XHS', role: 'xiaohongshu-writer' });
    const wechatAgent = createAgent({ id: 'wechat-agent', name: 'WeChat', role: 'wechat-writer' });
    const pipeline = createPipeline({
      name: 'Three lanes',
      input: 'topic',
      gateMode: 'manual',
      stages: [
        {
          index: 0,
          name: 'Human review package',
          agentRole: 'social-review-coordinator',
          status: 'done',
          output: '{"recommendation":"approve"}',
          requiresApproval: true,
          approvalKind: 'content',
        },
        {
          index: 1,
          name: 'XHS assets',
          agentRole: 'xiaohongshu-writer',
          status: 'pending',
          dependsOn: [0],
        },
        {
          index: 2,
          name: 'WeChat draft',
          agentRole: 'wechat-writer',
          status: 'pending',
          dependsOn: [0],
        },
      ],
    });
    updatePipeline(pipeline.id, { status: 'paused', currentStageIndex: 0 });

    const enqueue = vi.fn(async (data: any) => createTask({
      title: data.title,
      description: data.description,
      input: data.input,
      mode: 'pipeline',
      assigneeId: data.assigneeId,
      pipelineId: data.pipelineId,
      stageIndex: data.stageIndex,
    }));
    const manager = {
      findAvailableAgent: (role: string) =>
        role === 'xiaohongshu-writer' ? xhsAgent : role === 'wechat-writer' ? wechatAgent : undefined,
    } as unknown as AgentManager;
    const engine = new PipelineEngine({ enqueue } as unknown as TaskQueue, manager);

    await engine.approveGate(
      pipeline.id,
      false,
      { id: 'human-operator', role: 'operator', source: 'local' },
      'Reviewed final drafts',
    );

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    const updated = getPipeline(pipeline.id)!;
    expect(updated.stages[0].approval).toMatchObject({
      actorId: 'human-operator',
      kind: 'content',
      note: 'Reviewed final drafts',
    });
    expect(updated.stages[0].approval?.contentHash).toHaveLength(64);
    expect(updated.stages.slice(1).map(stage => stage.status)).toEqual(['running', 'running']);
  });

  it('blocks the pipeline when a structured output policy fails', async () => {
    const pipeline = createPipeline({
      name: 'Preflight policy',
      input: 'topic',
      stages: [{
        index: 0,
        name: 'Preflight',
        agentRole: 'social-preflight',
        status: 'running',
        outputPolicy: {
          field: 'ok',
          allowedValues: [true],
          onFailure: 'blocked',
        },
      }],
    });
    const task = createTask({
      title: 'Preflight',
      description: 'Preflight',
      input: 'topic',
      mode: 'pipeline',
      pipelineId: pipeline.id,
      stageIndex: 0,
    });
    updatePipeline(pipeline.id, {
      stages: [{ ...pipeline.stages[0], taskId: task.id }],
      currentStageIndex: 0,
    });
    updateTask(task.id, { status: 'done', output: '{"ok":false,"errors":["login failed"]}' });

    const engine = new PipelineEngine({} as TaskQueue, {} as AgentManager);
    await (engine as any).onTaskComplete(task.id);

    expect(getPipeline(pipeline.id)).toMatchObject({
      status: 'blocked',
      currentStageIndex: 0,
      stages: [{
        status: 'review',
        validationErrors: [expect.stringContaining('"ok"')],
      }],
    });
  });

  it('recovers every completed parallel branch and starts the fan-in stage', async () => {
    const reviewer = createAgent({
      id: 'review-coordinator',
      name: 'Review coordinator',
      role: 'social-review-coordinator',
    });
    const pipeline = createPipeline({
      name: 'Recover parallel branches',
      input: 'topic',
      stages: [
        { index: 0, name: 'Douyin', agentRole: 'douyin-writer', status: 'running' },
        { index: 1, name: 'XHS', agentRole: 'xiaohongshu-writer', status: 'running' },
        {
          index: 2,
          name: 'Review fan-in',
          agentRole: 'social-review-coordinator',
          status: 'pending',
          dependsOn: [0, 1],
        },
      ],
    });
    const first = createTask({
      title: 'Douyin',
      description: 'Douyin',
      input: 'topic',
      mode: 'pipeline',
      pipelineId: pipeline.id,
      stageIndex: 0,
    });
    const second = createTask({
      title: 'XHS',
      description: 'XHS',
      input: 'topic',
      mode: 'pipeline',
      pipelineId: pipeline.id,
      stageIndex: 1,
    });
    updateTask(first.id, { status: 'done', output: 'douyin output' });
    updateTask(second.id, { status: 'done', output: 'xhs output' });
    updatePipeline(pipeline.id, {
      currentStageIndex: 1,
      stages: [
        { ...pipeline.stages[0], taskId: first.id },
        { ...pipeline.stages[1], taskId: second.id },
        pipeline.stages[2],
      ],
    });

    const enqueue = vi.fn(async (data: any) => createTask({
      title: data.title,
      description: data.description,
      input: data.input,
      mode: 'pipeline',
      assigneeId: data.assigneeId,
      pipelineId: data.pipelineId,
      stageIndex: data.stageIndex,
    }));
    const manager = {
      findAvailableAgent: (role: string) => role === 'social-review-coordinator' ? reviewer : undefined,
    } as unknown as AgentManager;
    const engine = new PipelineEngine({ enqueue } as unknown as TaskQueue, manager);

    await engine.recoverInterruptedPipelines();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

    expect(getPipeline(pipeline.id)?.stages.map(stage => stage.status)).toEqual([
      'done',
      'done',
      'running',
    ]);
  });

  it('re-runs a completed image stage and invalidates downstream publication', async () => {
    const xhsAgent = createAgent({ id: 'xhs-rerun', name: 'XHS', role: 'xiaohongshu-writer' });
    const pipeline = createPipeline({
      name: 'Regenerate images',
      input: 'topic',
      gateMode: 'manual',
      stages: [
        { index: 0, name: 'Draft', agentRole: 'xiaohongshu-writer', status: 'done', output: 'draft' },
        {
          index: 1,
          name: '配图生成',
          agentRole: 'xiaohongshu-writer',
          status: 'done',
          output: 'no images',
          dependsOn: [0],
        },
        {
          index: 2,
          name: 'Publish',
          agentRole: 'social-publisher',
          status: 'pending',
          output: 'stale output',
          dependsOn: [1],
          publishTools: ['mcp__xiaohongshu__publish_content'],
        },
      ],
    });
    updatePipeline(pipeline.id, { status: 'paused', currentStageIndex: 1 });
    const enqueue = vi.fn(async (data: any) => createTask({
      title: data.title,
      description: data.description,
      input: data.input,
      mode: 'pipeline',
      assigneeId: data.assigneeId,
      pipelineId: data.pipelineId,
      stageIndex: data.stageIndex,
    }));
    const manager = {
      findAvailableAgent: (role: string) => role === 'xiaohongshu-writer' ? xhsAgent : undefined,
      cancelTask: vi.fn(),
    } as unknown as AgentManager;
    const engine = new PipelineEngine({ enqueue } as unknown as TaskQueue, manager);

    await engine.rerunStage(pipeline.id, 1);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

    const updated = getPipeline(pipeline.id)!;
    expect(updated.stages[1].status).toBe('running');
    expect(updated.stages[1]).not.toHaveProperty('output');
    expect(updated.stages[2].status).toBe('pending');
    expect(updated.stages[2]).not.toHaveProperty('output');
  });
});
