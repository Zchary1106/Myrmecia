import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { createPipeline, getPipeline, listPipelines, updatePipeline } from '../db/models/pipeline.js';
import { createTemplate, listTemplates, getTemplate } from '../db/models/pipeline.js';
import { getTask } from '../db/models/task.js';
import { eventBus } from '../events/event-bus.js';
import { TaskQueue } from '../queue/task-queue.js';
import { AgentManager } from '../agents/agent-manager.js';
import { contextManager } from './context-manager.js';
import { workspaceManager } from '../workspace/workspace-manager.js';
import type { Pipeline, PipelineStage } from '../types.js';

export class PipelineEngine {
  private taskQueue: TaskQueue;
  private agentManager: AgentManager;

  constructor(taskQueue: TaskQueue, agentManager: AgentManager) {
    this.taskQueue = taskQueue;
    this.agentManager = agentManager;

    // Listen for task completion to advance pipelines
    eventBus.on('task:done', (event) => {
      const { taskId } = event.payload as any;
      this.onTaskComplete(taskId);
    });
  }

  /** Load YAML templates from filesystem into DB */
  async loadTemplates(templatesDir: string) {
    try {
      const files = readdirSync(templatesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
      const existing = listTemplates();
      const existingNames = new Set(existing.map(t => t.name));

      for (const file of files) {
        const content = readFileSync(join(templatesDir, file), 'utf-8');
        const tmpl = parseYaml(content);
        if (!existingNames.has(tmpl.name)) {
          createTemplate({
            name: tmpl.name,
            description: tmpl.description,
            stages: tmpl.stages.map((s: any) => ({
              name: s.name,
              role: s.role,
              promptTemplate: s.prompt_template,
            })),
          });
          console.log(`  Loaded template: ${tmpl.name}`);
        }
      }
    } catch (err: any) {
      console.error('Failed to load templates:', err.message);
    }
  }

  /** Create a new pipeline from a template */
  async create(data: { name: string; templateId: string; input: string; gateMode?: 'auto' | 'manual' }): Promise<Pipeline> {
    const template = getTemplate(data.templateId);
    if (!template) throw new Error(`Template ${data.templateId} not found`);

    const stages: PipelineStage[] = template.stages.map((s, i) => ({
      index: i,
      name: s.name,
      agentRole: s.role,
      status: 'pending' as const,
      promptTemplate: s.promptTemplate,
    }));

    const pipeline = createPipeline({
      name: data.name,
      templateId: data.templateId,
      stages,
      gateMode: data.gateMode,
      input: data.input,
    });

    // Create isolated workspace for this pipeline
    try {
      const ws = await workspaceManager.createPipelineWorkspace(pipeline.id);
      console.log(`  📁 Created workspace: ${ws.path} (git worktree: ${ws.isGitWorktree})`);
    } catch (err: any) {
      console.warn(`  ⚠️ Workspace creation failed: ${err.message} — using default cwd`);
    }

    // Start first stage
    await this.startStage(pipeline.id, 0);
    return getPipeline(pipeline.id)!;
  }

  /** Start a pipeline stage */
  private async startStage(pipelineId: string, stageIndex: number) {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) return;

    const stages = [...pipeline.stages];
    const stage = stages[stageIndex];
    if (!stage) return;

    // Use context manager for optimized input building
    const prompt = contextManager.buildStageInput(pipeline, stageIndex);

    // Determine workspace — use pipeline workspace if available, else cwd
    const ws = workspaceManager.getWorkspaceInfo(pipelineId, 'pipeline');
    let workdir = ws?.path || undefined;
    let workspacePath = ws?.path || undefined;

    // Create stage-specific artifact directory
    if (ws) {
      const stageDir = workspaceManager.createStageDir(ws.path, stageIndex, stage.name);
      // Stage output will be written here after completion
    }

    // Find an available agent for this role
    const agent = this.agentManager.findAvailableAgent(stage.agentRole);
    if (!agent) {
      stages[stageIndex] = { ...stage, status: 'pending' };
      updatePipeline(pipelineId, { stages, status: 'blocked' });
      eventBus.emit('pipeline:stage:started', { pipelineId, stageIndex, status: 'blocked' });

      // Retry after delay — an agent may become available
      setTimeout(() => this.retryBlockedStage(pipelineId, stageIndex), 10000);
      return;
    }

    // Create task for this stage
    const task = await this.taskQueue.enqueue({
      title: `${pipeline.name} — ${stage.name}`,
      description: prompt,
      mode: 'pipeline',
      assigneeId: agent.id,
      input: prompt,
      pipelineId: pipeline.id,
      stageIndex,
      workdir,
      workspacePath,
    });

    stages[stageIndex] = { ...stage, status: 'running', taskId: task.id, input: prompt };
    updatePipeline(pipelineId, { stages, currentStageIndex: stageIndex });

    eventBus.emit('pipeline:stage:started', { pipelineId, stageIndex, taskId: task.id });
  }

  /** Retry a blocked stage (when agent becomes available) */
  private async retryBlockedStage(pipelineId: string, stageIndex: number) {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline || pipeline.status !== 'blocked') return;

    const stage = pipeline.stages[stageIndex];
    if (stage.status !== 'pending') return;

    const agent = this.agentManager.findAvailableAgent(stage.agentRole);
    if (agent) {
      updatePipeline(pipelineId, { status: 'running' });
      await this.startStage(pipelineId, stageIndex);
    } else {
      // Keep retrying
      setTimeout(() => this.retryBlockedStage(pipelineId, stageIndex), 15000);
    }
  }

  /** Handle task completion — write artifacts, advance pipeline */
  private async onTaskComplete(taskId: string) {
    const pipelines = listPipelines({ status: 'running' });

    for (const pipeline of pipelines) {
      const stageIdx = pipeline.stages.findIndex(s => s.taskId === taskId);
      if (stageIdx === -1) continue;

      const task = getTask(taskId);
      if (!task) continue;

      const stages = [...pipeline.stages];
      stages[stageIdx] = { ...stages[stageIdx], status: 'done', output: task.output || '' };
      updatePipeline(pipeline.id, { stages });

      // Write stage artifact to workspace
      const ws = workspaceManager.getWorkspaceInfo(pipeline.id, 'pipeline');
      if (ws && task.output) {
        const stageDir = workspaceManager.createStageDir(ws.path, stageIdx, stages[stageIdx].name);
        workspaceManager.writeStageArtifact(stageDir, task.output, 'output.md');
      }

      eventBus.emit('pipeline:stage:done', {
        pipelineId: pipeline.id,
        stageIndex: stageIdx,
        output: task.output,
      });

      // Check if pipeline is complete
      const nextIdx = stageIdx + 1;
      if (nextIdx >= stages.length) {
        updatePipeline(pipeline.id, { status: 'done', completedAt: new Date().toISOString() });
        eventBus.emit('pipeline:done', { pipelineId: pipeline.id });

        // Merge workspace back if git worktree
        if (ws?.isGitWorktree) {
          const mergeResult = await workspaceManager.mergePipelineWorkspace(
            pipeline.id,
            `Agent Factory: ${pipeline.name} complete`
          );
          if (!mergeResult.success) {
            console.warn(`  ⚠️ Workspace merge failed: ${mergeResult.error}`);
          }
        }
        return;
      }

      // Gate check
      if (pipeline.gateMode === 'manual') {
        updatePipeline(pipeline.id, { status: 'paused', stages });
        return;
      }

      // Auto-advance
      await this.startStage(pipeline.id, nextIdx);
    }
  }

  /** Rebuild in-memory timers/progress after a server restart. */
  async recoverInterruptedPipelines() {
    const pipelines = listPipelines();

    for (const pipeline of pipelines) {
      if (pipeline.status === 'blocked') {
        eventBus.emit('pipeline:stage:started', {
          pipelineId: pipeline.id,
          stageIndex: pipeline.currentStageIndex,
          status: 'blocked',
          recovered: true,
        });
        setTimeout(() => this.retryBlockedStage(pipeline.id, pipeline.currentStageIndex), 0);
        continue;
      }

      if (pipeline.status !== 'running') continue;

      const current = pipeline.stages[pipeline.currentStageIndex];
      if (!current) continue;

      if (current.status === 'running' && current.taskId) {
        const task = getTask(current.taskId);
        if (task?.status === 'done') {
          await this.onTaskComplete(current.taskId);
        } else if (task?.status === 'failed' || task?.status === 'cancelled' || !task) {
          const stages = [...pipeline.stages];
          stages[pipeline.currentStageIndex] = { ...current, status: 'failed' };
          updatePipeline(pipeline.id, {
            stages,
            status: 'failed',
            completedAt: new Date().toISOString(),
          });
          eventBus.emit('pipeline:failed', {
            pipelineId: pipeline.id,
            stageIndex: pipeline.currentStageIndex,
            taskId: current.taskId,
            error: task?.error || `Stage task ${current.taskId} is not recoverable`,
            recovered: true,
          });
        }
        continue;
      }

      if (current.status === 'pending') {
        await this.startStage(pipeline.id, pipeline.currentStageIndex);
      }
    }
  }

  /** Approve gate and advance to next stage */
  async approveGate(pipelineId: string) {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline || pipeline.status !== 'paused') return;

    const nextIdx = pipeline.currentStageIndex + 1;
    updatePipeline(pipelineId, { status: 'running' });
    await this.startStage(pipelineId, nextIdx);
  }

  /** Skip current stage */
  async skipStage(pipelineId: string) {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) return;

    const stages = [...pipeline.stages];
    const current = pipeline.currentStageIndex;
    stages[current] = { ...stages[current], status: 'skipped' };
    updatePipeline(pipelineId, { stages });

    const nextIdx = current + 1;
    if (nextIdx >= stages.length) {
      updatePipeline(pipelineId, { status: 'done', completedAt: new Date().toISOString() });
      return;
    }

    await this.startStage(pipelineId, nextIdx);
  }

  /** Cancel pipeline */
  async cancel(pipelineId: string) {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) return;

    for (const stage of pipeline.stages) {
      if (stage.taskId && stage.status === 'running') {
        this.agentManager.cancelTask(stage.taskId);
      }
    }

    updatePipeline(pipelineId, { status: 'failed' });

    // Cleanup workspace
    await workspaceManager.cleanupWorkspace(pipelineId, 'pipeline');
  }
}
