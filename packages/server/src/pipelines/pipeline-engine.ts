import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createPipeline, getPipeline, listPipelines, updatePipeline } from '../db/models/pipeline.js';
import { createTemplate, listTemplates, getTemplate, updateTemplate } from '../db/models/pipeline.js';
import { getTask } from '../db/models/task.js';
import { listAgents, getAgent } from '../db/models/agent.js';
import { eventBus } from '../events/event-bus.js';
import { PUBLISH_RECONFIRMATION_ERROR, TaskQueue } from '../queue/task-queue.js';
import { AgentManager } from '../agents/agent-manager.js';
import { logger } from '../lib/logger.js';
import { contextManager } from './context-manager.js';
import { getReflectionService } from '../memory/reflection.js';
import { workspaceManager } from '../workspace/workspace-manager.js';
import { createTestReportFromOutput, isTestingStage } from '../testing/test-report.js';
import { saveCheckpoint, getCompletedStageIndices } from './checkpoint.js';
import type { Pipeline, PipelineStage, PipelineTemplate } from '../types.js';
import { GOVERNED_PUBLISH_MCP_TOOLS } from '../tools/mcp-manager.js';

const execAsync = promisify(exec);

interface PipelineTemplateYaml {
  name?: string;
  description?: string;
  stages?: PipelineTemplateYamlStage[];
}

interface PipelineTemplateYamlStage {
  name: string;
  role: string;
  prompt_template: string;
  depends_on?: number[];
  publish_tools?: string[];
}

function toTemplateStages(stages: PipelineTemplateYamlStage[]): PipelineTemplate['stages'] {
  return stages.map((stage) => ({
    name: stage.name,
    role: stage.role,
    promptTemplate: stage.prompt_template,
    ...(stage.depends_on?.length ? { dependsOn: stage.depends_on } : {}),
    ...(stage.publish_tools?.length ? { publishTools: stage.publish_tools } : {}),
  }));
}

/**
 * MCP tools that take an irreversible real-world action (posting to a live social
 * account). Any pipeline that resolves a stage to an agent holding one of these
 * tools is treated as "autonomous-publish-capable" and is forced into manual
 * gating unless the caller explicitly opts in (see `resolveGateMode` below).
 */
/** Resolve a stage's `role` the same way `AgentManager.findAvailableAgent` does
 * (direct role match, falling back to an id match), but without filtering by
 * current availability — we only need the agent *definition* to inspect its
 * tool grants ahead of pipeline creation. */
function resolveAgentsForRole(role: string) {
  const byRole = listAgents({ role });
  if (byRole.length > 0) return byRole;
  const byId = getAgent(role);
  return byId ? [byId] : [];
}

/** Does this template contain a stage whose agent can call a real-publish MCP tool? */
function stageHasAutonomousPublishCapability(stage: { role: string; publishTools?: string[] }): boolean {
  if (stage.publishTools?.some(tool =>
    GOVERNED_PUBLISH_MCP_TOOLS.some(publishTool => publishTool === tool)
  )) {
    return true;
  }
  return resolveAgentsForRole(stage.role).some(agent =>
    (agent.allowedTools || []).some(tool =>
      GOVERNED_PUBLISH_MCP_TOOLS.some(publishTool => publishTool === tool)
    )
  );
}

function templateHasAutonomousPublishStage(stages: Array<{ role: string; publishTools?: string[] }>): boolean {
  return stages.some(stageHasAutonomousPublishCapability);
}

function readyPublishStageIndices(stages: PipelineStage[]): number[] {
  return stages.flatMap((stage, index) => {
    if (stage.status !== 'pending' || !stageHasAutonomousPublishCapability({
      role: stage.agentRole,
      publishTools: stage.publishTools,
    })) {
      return [];
    }
    const dependencies = stage.dependsOn ?? (index > 0 ? [index - 1] : []);
    return dependencies.every(dependency => stages[dependency]?.status === 'done') ? [index] : [];
  });
}

export class PublishConfirmationRequiredError extends Error {}
export class PublishStageSkipForbiddenError extends Error {}

/**
 * Decide the effective gateMode for a new pipeline. Pipelines that can reach a
 * real-publish MCP tool always default to (and are forced back to) "manual"
 * unless the caller both requests "auto" AND explicitly confirms
 * `confirmAutonomousPublish` — this is the opt-in, off-by-default "let it write
 * and publish itself" switch. Non-publishing pipelines are unaffected.
 *
 * Note: an *unspecified* gateMode defaults to "auto" further down the stack
 * (see `createPipeline` / db/models/pipeline.ts), so `undefined` must be
 * treated the same as an explicit "auto" request here — otherwise omitting
 * gateMode would silently bypass this guard.
 *
 * Returns `forcedForSafety: true` only when the guard actually downgraded an
 * auto/unspecified request to "manual" — not for the ordinary, benign case of
 * a non-publishing template simply defaulting to "auto" when unspecified —
 * so callers can log/report the safety event precisely instead of inferring
 * it from a generic "did the value change" comparison.
 */
function resolveGateMode(
  stages: Array<{ role: string; publishTools?: string[] }>,
  requested: 'auto' | 'manual' | undefined,
  confirmAutonomousPublish: boolean | undefined
): { gateMode: 'auto' | 'manual'; forcedForSafety: boolean } {
  if (requested === 'manual') return { gateMode: 'manual', forcedForSafety: false };
  if (!templateHasAutonomousPublishStage(stages)) return { gateMode: requested ?? 'auto', forcedForSafety: false };
  if (confirmAutonomousPublish === true) return { gateMode: 'auto', forcedForSafety: false };
  return { gateMode: 'manual', forcedForSafety: true };
}

export class PipelineEngine {
  private taskQueue: TaskQueue;
  private agentManager: AgentManager;
  private stageGitShas = new Map<string, string>(); // key: `${pipelineId}:${stageIndex}`
  private taskToPipeline = new Map<string, { pipelineId: string; stageIndex: number }>();
  private publishStageApprovals = new Set<string>();

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
      const existingByName = new Map(listTemplates().map(template => [template.name, template]));

      for (const file of files) {
        const content = readFileSync(join(templatesDir, file), 'utf-8');
        const tmpl = parseYaml(content) as PipelineTemplateYaml | undefined;
        if (!tmpl?.name || !Array.isArray(tmpl.stages)) {
          logger.debug({ file }, 'Skipping non-pipeline template metadata file');
          continue;
        }
        const data = {
          name: tmpl.name,
          description: tmpl.description || '',
          stages: toTemplateStages(tmpl.stages),
        };
        const existing = existingByName.get(data.name);

        if (!existing) {
          const created = createTemplate(data);
          existingByName.set(data.name, created);
          logger.info({ template: tmpl.name }, 'Loaded pipeline template');
          continue;
        }

        if (
          existing.description !== data.description
          || JSON.stringify(existing.stages) !== JSON.stringify(data.stages)
        ) {
          updateTemplate(existing.id, data);
          logger.info({ template: tmpl.name }, 'Synced pipeline template');
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to load pipeline templates');
    }
  }

  /** Create a new pipeline from a template */
  async create(data: {
    name: string;
    templateId: string;
    input: string;
    gateMode?: 'auto' | 'manual';
    /** Explicit opt-in required to run a publish-capable pipeline with gateMode "auto".
     *  Off by default: omitting this (or setting false) forces "manual" for any
     *  pipeline that can reach a real-publish MCP tool (e.g. mcp__xiaohongshu__publish_content). */
    confirmAutonomousPublish?: boolean;
    workspaceId?: string;
    domainId?: string;
  }): Promise<Pipeline> {
    const template = getTemplate(data.templateId);
    if (!template) throw new Error(`Template ${data.templateId} not found`);

    const stages: PipelineStage[] = template.stages.map((s, i) => ({
      index: i,
      name: s.name,
      agentRole: s.role,
      status: 'pending' as const,
      promptTemplate: s.promptTemplate,
      dependsOn: s.dependsOn,
      publishTools: s.publishTools,
    }));

    const { gateMode, forcedForSafety } = resolveGateMode(template.stages, data.gateMode, data.confirmAutonomousPublish);
    if (forcedForSafety) {
      logger.warn(
        { templateId: data.templateId, requested: data.gateMode ?? 'auto' },
        'Forced pipeline to manual gating: template can reach a real-publish MCP tool and confirmAutonomousPublish was not set'
      );
    }

    const pipeline = createPipeline({
      name: data.name,
      templateId: data.templateId,
      stages,
      gateMode,
      input: data.input,
      workspaceId: data.workspaceId,
      domainId: data.domainId,
    });

    // Create isolated workspace for this pipeline
    try {
      const ws = await workspaceManager.createPipelineWorkspace(pipeline.id);
      logger.info({ path: ws.path, gitWorktree: ws.isGitWorktree }, 'Created pipeline workspace');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Pipeline workspace creation failed; using default cwd');
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
    const publishApprovalKey = `${pipelineId}:${stageIndex}`;
    if (
      pipeline.gateMode === 'manual'
      && stageHasAutonomousPublishCapability({ role: stage.agentRole, publishTools: stage.publishTools })
      && !this.publishStageApprovals.has(publishApprovalKey)
    ) {
      updatePipeline(pipelineId, {
        status: 'paused',
        currentStageIndex: stageIndex - 1,
      });
      logger.warn({ pipelineId, stageIndex }, 'Publish stage paused until explicit approval');
      return;
    }

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
    this.publishStageApprovals.delete(publishApprovalKey);

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
    const ref = this.resolveTaskPipelineRef(taskId);
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
          logger.warn({ err: mergeResult.error }, 'Pipeline workspace merge failed');
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

  private resolveTaskPipelineRef(taskId: string): { pipelineId: string; stageIndex: number } | undefined {
    const mapped = this.taskToPipeline.get(taskId);
    if (mapped) return mapped;

    const task = getTask(taskId);
    if (task?.pipelineId && typeof task.stageIndex === 'number') {
      return { pipelineId: task.pipelineId, stageIndex: task.stageIndex };
    }

    const pipeline = listPipelines({ status: 'running' })
      .find(candidate => candidate.stages.some(stage => stage.taskId === taskId));
    if (!pipeline) return undefined;
    const stageIndex = pipeline.stages.findIndex(stage => stage.taskId === taskId);
    return stageIndex >= 0 ? { pipelineId: pipeline.id, stageIndex } : undefined;
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
          if (
            task?.error === PUBLISH_RECONFIRMATION_ERROR
            && stageHasAutonomousPublishCapability({
              role: current.agentRole,
              publishTools: current.publishTools,
            })
          ) {
            stages[pipeline.currentStageIndex] = { ...current, status: 'rolled_back' };
            updatePipeline(pipeline.id, {
              stages,
              status: 'awaiting_retry',
            });
            eventBus.emit('pipeline:awaiting_retry', {
              pipelineId: pipeline.id,
              stageIndex: pipeline.currentStageIndex,
              taskId: current.taskId,
              workspaceId: pipeline.workspaceId,
              recovered: true,
              reason: PUBLISH_RECONFIRMATION_ERROR,
            });
            continue;
          }
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
  async approveGate(pipelineId: string, confirmPublish = false) {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline || pipeline.status !== 'paused') return;

    const nextIdx = pipeline.currentStageIndex + 1;
    const nextStage = pipeline.stages[nextIdx];
    if (
      nextStage
      && stageHasAutonomousPublishCapability({ role: nextStage.agentRole, publishTools: nextStage.publishTools })
      && !confirmPublish
    ) {
      throw new PublishConfirmationRequiredError('Publishing requires explicit confirmation');
    }
    if (nextStage && stageHasAutonomousPublishCapability({ role: nextStage.agentRole, publishTools: nextStage.publishTools })) {
      this.publishStageApprovals.add(`${pipelineId}:${nextIdx}`);
    }
    updatePipeline(pipelineId, { status: 'running' });
    await this.startStage(pipelineId, nextIdx);
  }

  /** Skip current stage */
  async skipStage(pipelineId: string) {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) return;

    const stages = [...pipeline.stages];
    const current = pipeline.currentStageIndex;
    const nextIdx = current + 1;
    if (
      nextIdx < stages.length
      && stageHasAutonomousPublishCapability({
        role: stages[nextIdx].agentRole,
        publishTools: stages[nextIdx].publishTools,
      })
    ) {
      throw new PublishStageSkipForbiddenError('A publish stage cannot be entered through skip');
    }

    stages[current] = { ...stages[current], status: 'skipped' };
    updatePipeline(pipelineId, { stages });

    if (nextIdx >= stages.length) {
      updatePipeline(pipelineId, { status: 'done', completedAt: new Date().toISOString() });
      return;
    }

    await this.startStage(pipelineId, nextIdx);
  }

  /** Resume pipeline from checkpoints — skips completed stages */
  async resume(pipelineId: string, confirmPublish = false): Promise<Pipeline> {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`);
    if (pipeline.status === 'done') throw new Error('Pipeline is already done');
    if (pipeline.status === 'running') throw new Error('Pipeline is already running');

    const completedIndices = getCompletedStageIndices(pipelineId);
    if (completedIndices.size === 0) {
      const readyPublishStages = readyPublishStageIndices(pipeline.stages);
      if (pipeline.gateMode === 'manual' && readyPublishStages.length > 0 && !confirmPublish) {
        throw new PublishConfirmationRequiredError('Resuming into publishing requires explicit confirmation');
      }
      if (confirmPublish) {
        for (const index of readyPublishStages) this.publishStageApprovals.add(`${pipelineId}:${index}`);
      }
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
    const readyPublishStages = readyPublishStageIndices(stages);
    if (pipeline.gateMode === 'manual' && readyPublishStages.length > 0 && !confirmPublish) {
      throw new PublishConfirmationRequiredError('Resuming into publishing requires explicit confirmation');
    }
    if (confirmPublish) {
      for (const index of readyPublishStages) this.publishStageApprovals.add(`${pipelineId}:${index}`);
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
    for (const key of this.publishStageApprovals) {
      if (key.startsWith(`${pipelineId}:`)) this.publishStageApprovals.delete(key);
    }

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
  async retryStage(pipelineId: string, stageIndex: number, confirmPublish = false): Promise<void> {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`);

    const stage = pipeline.stages[stageIndex];
    if (!stage) throw new Error(`Stage ${stageIndex} not found`);
    if (stage.status !== 'rolled_back') {
      throw new Error(`Stage ${stageIndex} is not in rolled_back status (current: ${stage.status})`);
    }
    if (
      stageHasAutonomousPublishCapability({ role: stage.agentRole, publishTools: stage.publishTools })
      && !confirmPublish
    ) {
      throw new PublishConfirmationRequiredError('Retrying a publish stage requires explicit confirmation');
    }
    if (stageHasAutonomousPublishCapability({ role: stage.agentRole, publishTools: stage.publishTools }) && confirmPublish) {
      this.publishStageApprovals.add(`${pipelineId}:${stageIndex}`);
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
