import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createPipeline, getPipeline, listPipelines, updatePipeline } from '../db/models/pipeline.js';
import { createTemplate, listTemplates, getTemplate } from '../db/models/pipeline.js';
import { getTask } from '../db/models/task.js';
import { eventBus } from '../events/event-bus.js';
import { TaskQueue } from '../queue/task-queue.js';
import { AgentManager } from '../agents/agent-manager.js';
import { contextManager } from './context-manager.js';
import { getReflectionService } from '../memory/reflection.js';
import { workspaceManager } from '../workspace/workspace-manager.js';
import { createTestReportFromOutput, isTestingStage } from '../testing/test-report.js';
import { saveCheckpoint, getCompletedStageIndices } from './checkpoint.js';
import type { Pipeline, PipelineStage } from '../types.js';

const execAsync = promisify(exec);

export class PipelineEngine {
  private taskQueue: TaskQueue;
  private agentManager: AgentManager;
  private stageGitShas = new Map<string, string>(); // key: `${pipelineId}:${stageIndex}`
  private taskToPipeline = new Map<string, { pipelineId: string; stageIndex: number }>();

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
              dependsOn: s.depends_on,
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
  async create(data: { name: string; templateId: string; input: string; gateMode?: 'auto' | 'manual'; workspaceId?: string; domainId?: string }): Promise<Pipeline> {
    const template = getTemplate(data.templateId);
    if (!template) throw new Error(`Template ${data.templateId} not found`);

    const stages: PipelineStage[] = template.stages.map((s, i) => ({
      index: i,
      name: s.name,
      agentRole: s.role,
      status: 'pending' as const,
      promptTemplate: s.promptTemplate,
      dependsOn: (s as any).dependsOn,
    }));

    const pipeline = createPipeline({
      name: data.name,
      templateId: data.templateId,
      stages,
      gateMode: data.gateMode,
      input: data.input,
      workspaceId: data.workspaceId,
      domainId: data.domainId,
    });

    // Create isolated workspace for this pipeline
    try {
      const ws = await workspaceManager.createPipelineWorkspace(pipeline.id);
      console.log(`  📁 Created workspace: ${ws.path} (git worktree: ${ws.isGitWorktree})`);
    } catch (err: any) {
      console.warn(`  ⚠️ Workspace creation failed: ${err.message} — using default cwd`);
    }

    // Start all stages that have no dependencies (or depend only on completed stages)
    this.startReadyStages(pipeline.id);
    return getPipeline(pipeline.id)!;
  }

  /**
   * Start all pipeline stages whose dependencies are satisfied.
   * Enables parallel execution when stages share the same dependency level.
   */
  private startReadyStages(pipelineId: string) {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline || pipeline.status === 'done' || pipeline.status === 'failed') return;

    for (const [idx, stage] of pipeline.stages.entries()) {
      if (stage.status !== 'pending') continue;

      // Determine dependencies: explicit dependsOn, or implicit sequential (previous stage)
      const deps = stage.dependsOn ?? (idx > 0 ? [idx - 1] : []);
      const allDepsCompleted = deps.every(d => pipeline.stages[d]?.status === 'done');

      if (allDepsCompleted) {
        // Fire-and-forget: don't await — allows parallel starts
        this.startStage(pipelineId, idx);
      }
    }
  }

  /** Start a pipeline stage */
  private async startStage(pipelineId: string, stageIndex: number) {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) return;

    const stages = [...pipeline.stages];
    const stage = stages[stageIndex];
    if (!stage) return;

    // Use context manager for optimized input building (with long-term memory recall)
    const prompt = await contextManager.buildStageInputWithMemory(pipeline, stageIndex);

    // Determine workspace — use pipeline workspace if available, else cwd
    const ws = workspaceManager.getWorkspaceInfo(pipelineId, 'pipeline');
    let workdir = ws?.path || undefined;
    let workspacePath = ws?.path || undefined;

    // Capture git SHA for rollback (saved in unified checkpoint later)
    if (ws?.path) {
      try {
        const { stdout } = await execAsync('git rev-parse HEAD', { cwd: ws.path, encoding: 'utf-8', timeout: 5000 });
        this.stageGitShas.set(`${pipelineId}:${stageIndex}`, stdout.trim());
      } catch {
        // Not a git workspace, skip
      }
    }

    // Create stage-specific artifact directory
    if (ws) {
      const stageDir = workspaceManager.createStageDir(ws.path, stageIndex, stage.name);
      // Stage output will be written here after completion
    }

    // Find an available agent for this role (prefer the pipeline's domain agents)
    const agent = this.agentManager.findAvailableAgent(stage.agentRole, pipeline.domainId);
    if (!agent) {
      stages[stageIndex] = { ...stage, status: 'pending' };
      updatePipeline(pipelineId, { stages, status: 'blocked' });
      eventBus.emit('pipeline:stage:started', { pipelineId, stageIndex, status: 'blocked', workspaceId: pipeline.workspaceId });

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
      workspaceId: pipeline.workspaceId,
      domainId: pipeline.domainId,
    });

    stages[stageIndex] = { ...stage, status: 'running', taskId: task.id, input: prompt };
    updatePipeline(pipelineId, { stages, currentStageIndex: stageIndex });
    this.taskToPipeline.set(task.id, { pipelineId, stageIndex });

    eventBus.emit('pipeline:stage:started', { pipelineId, stageIndex, taskId: task.id, workspaceId: pipeline.workspaceId });
  }

  /** Retry a blocked stage (when agent becomes available) */
  private async retryBlockedStage(pipelineId: string, stageIndex: number) {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline || pipeline.status !== 'blocked') return;

    const stage = pipeline.stages[stageIndex];
    if (stage.status !== 'pending') return;

    const agent = this.agentManager.findAvailableAgent(stage.agentRole, pipeline.domainId);
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
    const ref = this.taskToPipeline.get(taskId);
    if (!ref) return;
    this.taskToPipeline.delete(taskId);

    const pipeline = getPipeline(ref.pipelineId);
    if (!pipeline) return;
    const stageIdx = ref.stageIndex;

    const task = getTask(taskId);
    if (!task) return;

    const stages = [...pipeline.stages];
    stages[stageIdx] = { ...stages[stageIdx], status: 'done', output: task.output || '' };
    updatePipeline(pipeline.id, { stages });

    // Save unified checkpoint for recovery and rollback
    const gitSha = this.stageGitShas.get(`${pipeline.id}:${stageIdx}`);
    saveCheckpoint({
      pipelineId: pipeline.id,
      stageIndex: stageIdx,
      stageName: stages[stageIdx].name,
      stageOutput: task.output || '',
      context: task.input || '',
      timestamp: new Date().toISOString(),
      gitSha,
    });
    this.stageGitShas.delete(`${pipeline.id}:${stageIdx}`);

    // Write stage artifact to workspace
    const ws = workspaceManager.getWorkspaceInfo(pipeline.id, 'pipeline');
    if (ws && task.output) {
      const stageDir = workspaceManager.createStageDir(ws.path, stageIdx, stages[stageIdx].name);
      workspaceManager.writeStageArtifact(stageDir, task.output, 'output.md');
      if (isTestingStage(stages[stageIdx].name, stages[stageIdx].agentRole)) {
        const testReport = createTestReportFromOutput(task.output, `${stages[stageIdx].name} completed`);
        workspaceManager.writeStageArtifact(stageDir, JSON.stringify(testReport, null, 2), 'test-report.json');
      }
    }

    eventBus.emit('pipeline:stage:done', {
      pipelineId: pipeline.id,
      stageIndex: stageIdx,
      workspaceId: pipeline.workspaceId,
      output: task.output,
    });

    // Check if pipeline is complete (all stages done)
    const updatedPipeline = getPipeline(pipeline.id)!;
    const allDone = updatedPipeline.stages.every(s => s.status === 'done' || s.status === 'skipped');
    if (allDone) {
      updatePipeline(pipeline.id, { status: 'done', completedAt: new Date().toISOString() });
      eventBus.emit('pipeline:done', { pipelineId: pipeline.id, workspaceId: pipeline.workspaceId });

      // Reflect on the completed run → store insights + a reusable procedural lesson.
      const finished = getPipeline(pipeline.id);
      if (finished) {
        getReflectionService().reflectOnPipeline(finished).catch(() => { /* non-critical */ });
      }

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

    // Advance: start all stages whose dependencies are now satisfied
    this.startReadyStages(pipeline.id);
  }

  /** Rebuild in-memory timers/progress after a server restart. */
  async recoverInterruptedPipelines() {
    const pipelines = listPipelines();

    for (const pipeline of pipelines) {
      // Restore checkpointed stages as done
      const completedIndices = getCompletedStageIndices(pipeline.id);
      if (completedIndices.size > 0) {
        const stages = [...pipeline.stages];
        for (const idx of completedIndices) {
          if (stages[idx] && stages[idx].status !== 'done') {
            stages[idx] = { ...stages[idx], status: 'done' };
          }
        }
        updatePipeline(pipeline.id, { stages });
      }

      // Rebuild taskToPipeline map for running stages
      for (let i = 0; i < pipeline.stages.length; i++) {
        const stage = pipeline.stages[i];
        if (stage.taskId && stage.status === 'running') {
          this.taskToPipeline.set(stage.taskId, { pipelineId: pipeline.id, stageIndex: i });
        }
      }

      if (pipeline.status === 'blocked') {
        eventBus.emit('pipeline:stage:started', {
          pipelineId: pipeline.id,
          stageIndex: pipeline.currentStageIndex,
          workspaceId: pipeline.workspaceId,
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
            workspaceId: pipeline.workspaceId,
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

  /** Resume pipeline from checkpoints — skips completed stages */
  async resume(pipelineId: string): Promise<Pipeline> {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`);
    if (pipeline.status === 'done') throw new Error('Pipeline is already done');
    if (pipeline.status === 'running') throw new Error('Pipeline is already running');

    const completedIndices = getCompletedStageIndices(pipelineId);
    if (completedIndices.size === 0) {
      // No checkpoints — just start from the beginning
      updatePipeline(pipelineId, { status: 'running' });
      this.startReadyStages(pipelineId);
      return getPipeline(pipelineId)!;
    }

    // Mark checkpointed stages as done
    const stages = [...pipeline.stages];
    for (const idx of completedIndices) {
      if (stages[idx]) {
        stages[idx] = { ...stages[idx], status: 'done' };
      }
    }
    updatePipeline(pipelineId, { stages, status: 'running' });

    // Start stages whose dependencies are satisfied and which are not checkpointed
    this.startReadyStages(pipelineId);
    return getPipeline(pipelineId)!;
  }

  /** Cancel pipeline */
  async cancel(pipelineId: string) {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) return;

    for (const stage of pipeline.stages) {
      if (stage.taskId) {
        this.taskToPipeline.delete(stage.taskId);
        this.stageGitShas.delete(`${pipelineId}:${stage.index}`);
        if (stage.status === 'running') {
          this.agentManager.cancelTask(stage.taskId);
        }
      }
    }

    updatePipeline(pipelineId, { status: 'failed' });

    // Cleanup workspace
    await workspaceManager.cleanupWorkspace(pipelineId, 'pipeline');
  }

  /** Retry a rolled-back stage */
  async retryStage(pipelineId: string, stageIndex: number): Promise<void> {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`);

    const stage = pipeline.stages[stageIndex];
    if (!stage) throw new Error(`Stage ${stageIndex} not found`);
    if (stage.status !== 'rolled_back') {
      throw new Error(`Stage ${stageIndex} is not in rolled_back status (current: ${stage.status})`);
    }

    const stages = [...pipeline.stages];
    if (stages[stageIndex].taskId) {
      this.taskToPipeline.delete(stages[stageIndex].taskId!);
      this.stageGitShas.delete(`${pipelineId}:${stageIndex}`);
    }
    stages[stageIndex] = { ...stages[stageIndex], status: 'pending', taskId: undefined, output: undefined };
    updatePipeline(pipelineId, { stages, status: 'running' });

    eventBus.emit('pipeline:awaiting_retry', { pipelineId, stageIndex, action: 'retry', workspaceId: pipeline.workspaceId });

    this.startReadyStages(pipelineId);
  }
}
