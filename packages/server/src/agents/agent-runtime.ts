import { join } from 'path';
import { agentWithPinnedSetup, resolvePinnedSkill, getAgentSetupSnapshot } from './agent-setup-snapshot.js';
import { missingContractInput } from './agent-contract-input.js';
import type { AgentDefinition, ModelCostType, Task, AgentProgress, ProgressTracker } from '../types.js';
import { eventBus } from '../events/event-bus.js';
import { updateTask, addTaskLog, getTask } from '../db/models/task.js';
import { updateAgent } from '../db/models/agent.js';
import { createExecution, getExecution, updateExecution, addExecutionMessage } from '../db/models/execution.js';
import { recordLedgerEntry } from '../db/models/execution-ledger.js';
import { guardrails } from './safety-guardrails.js';
import { workspaceManager } from '../workspace/workspace-manager.js';
import { completeRunTrace, completeTraceSpan, createRunTrace, createTraceSpan } from '../db/models/trace.js';
import { getTrajectoryStore } from '../memory/trajectory-store.js';
import { getMemoryService } from '../memory/memory-service.js';
import { isDocumentSession } from '../knowledge/session-documents.js';
import { prepareRuntimeKnowledge, assertRuntimeKnowledgeCurrent } from '../memory/runtime-knowledge-bridge.js';
import { hasPrivateKnowledgeContext } from '../db/models/agent-knowledge.js';
import { tsAgentLoop } from './ts-agent-loop.js';
import { metrics } from '../observability/telemetry.js';
import { assertExecutionTokenBudget, estimateTokenCount, getRuntimeLimits, resolveAgentRuntimeLimits } from './runtime-limits.js';
import { prepareTaskBudget } from './agent-budget.js';
import { AgentConcurrencyError } from './agent-concurrency.js';
import { getDb } from '../db/database.js';
import { sanitizeAgentOutput } from '../security/dlp-runtime.js';
import { selectRuntimeAdapter, type RuntimeAdapter } from './runtime-adapter.js';
import { logger } from '../lib/logger.js';
import { ExecutionMiddlewareChain } from './execution-middleware.js';
import { indexExecutionArtifacts, captureArtifactBaseline } from '../artifacts/execution-artifact-indexer.js';
import { checkpointExecutionContext, loadExecutionContext, persistExecutionContext } from './execution-context.js';
import { clearPauseControl, getPauseControl, setPauseControl, UserPauseReached } from './pause-control.js';
import { AgentRunStopped, classifyAgentStop, updateAgentRun, validateAgentOutput } from './run-state.js';
import type { AgentStopReason } from '@myrmecia/shared';
import { queueOwnsRetry } from './retry-ownership.js';
import { requestedAgentInput } from './completion-control.js';
import { assertRunWrite, withOwnedRun } from './run-coordinator.js';
import { runtimeV2Enabled } from './runtime-version.js';
import { markContinuationStarted, RuntimeSliceYield, settleContinuation } from './runtime-continuation.js';
import { verifyCompletionCriteria } from './completion-gate.js';
import { finalizeInboxForExecution } from '../db/models/agent-inbox.js';
import { resolveExecutionWorld } from './execution-world.js';
import { prepareTaskWorkspace, recordWorkspaceBoundary } from '../workspace/task-workspace.js';
import { withWorkspaceLease, currentWorkspaceAccessMode } from '../workspace/workspace-lease.js';
import { safeWorkspacePath } from '../workspace/path-policy.js';

export interface TaskResult {
  stopReason?: AgentStopReason;
  output: string;
  costUSD: number | null;
  costType?: ModelCostType;
  provider?: string;
  actualModelId?: string;
  aiUnits?: number;
  billingMultiplier?: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  numTurns: number;
  executionId: string;
}

// ProgressTracker utilities
function createProgressTracker(): ProgressTracker {
  return { toolUseCount: 0, latestInputTokens: 0, cumulativeOutputTokens: 0, recentActivities: [] };
}

function getTokenCount(tracker: ProgressTracker): number {
  return tracker.latestInputTokens + tracker.cumulativeOutputTokens;
}

function getProgressSnapshot(tracker: ProgressTracker, summary?: string): AgentProgress {
  return {
    toolUseCount: tracker.toolUseCount,
    tokenCount: getTokenCount(tracker),
    lastActivity: tracker.recentActivities.length > 0
      ? tracker.recentActivities[tracker.recentActivities.length - 1]
      : undefined,
    recentActivities: [...tracker.recentActivities],
    summary,
  };
}

export class AgentRuntime {
  private abortControllers = new Map<string, AbortController>();
  private agentExecutionWindows = new Map<string, number[]>();
  private runtimeAdapters: RuntimeAdapter[];

  constructor() {
    // All built-in Agents use the TS loop. Extensions are inserted before this
    // universal fallback so their canHandle rules retain priority.
    this.runtimeAdapters = [
      {
        name: 'ts-agent-loop',
        canHandle: () => true,
        execute: (ctx) => tsAgentLoop.execute(
          ctx.agent, ctx.task, ctx.abortController, ctx.executionId, ctx.traceId, ctx.spanId, ctx.tracker, ctx.runtimeSkill, ctx.middleware,
        ),
      },
    ];
  }

  /** Register an additional runtime adapter (inserted before the fallback). */
  registerRuntimeAdapter(adapter: RuntimeAdapter): void {
    if (this.runtimeAdapters.some(a => a.name === adapter.name)) return;
    this.runtimeAdapters.splice(this.runtimeAdapters.length - 1, 0, adapter);
  }

  async execute(agent: AgentDefinition, task: Task): Promise<TaskResult> {
    task = await prepareTaskWorkspace(task);
    return withWorkspaceLease(task, () => withOwnedRun(task, () => this.executeOwned(agent, task)));
  }

  private async executeOwned(agent: AgentDefinition, task: Task): Promise<TaskResult> {
    agent = agentWithPinnedSetup(task.id, agent);
    const pinnedConfig = getAgentSetupSnapshot(task.id)?.completeConfig;
    if (pinnedConfig && !task.modelId && pinnedConfig.config.model && pinnedConfig.config.model !== 'auto') {
      task = { ...task, modelId: pinnedConfig.config.model };
    }
    if (runtimeV2Enabled()) markContinuationStarted(task);
    const executionStartedAtMs = Date.now();
    const abortController = new AbortController();
    const tracker = createProgressTracker();

    // Ensure workspace exists for this task
    let workspacePath = task.workspacePath;
    if (!workspacePath) throw new Error('WORKSPACE_PREPARATION_REQUIRED');
    const artifactBaseline = captureArtifactBaseline(workspacePath);
    if (workspacePath && !task.workdir) {
      task.workdir = workspacePath;
    }
    if (workspacePath) task.workspacePath = workspacePath;
    const executionContext = persistExecutionContext(task);
    persistExecutionContext(task, {
      contextUsage: {
        estimatedInputTokens: estimateTokenCount(task.input),
        maxInputTokens: task.contextLength || getRuntimeLimits().maxExecutionTokens,
        reservedOutputTokens: getRuntimeLimits().maxModelResponseTokens,
        occupancyPercent: Math.min(100, Math.round((estimateTokenCount(task.input) / Math.max(1, (task.contextLength || getRuntimeLimits().maxExecutionTokens) - getRuntimeLimits().maxModelResponseTokens)) * 100)),
        updatedAt: new Date().toISOString(),
      },
    });
    checkpointExecutionContext(executionContext, {
      phase: 'starting',
      completed: [],
      pending: ['agent execution'],
      blocked: [],
      resumeHint: 'Start or retry the agent from this execution context.',
    });

    // Create execution instance
    const runtimeSkill = resolvePinnedSkill(task.id, agent);
    const execution = getDb().transaction(() => {
      const active = getDb().get<{ total: number }>(`SELECT COUNT(*) AS total FROM task_executions
        WHERE agent_def_id = ? AND workspace_id = ? AND status = 'running'`, agent.id, task.workspaceId || 'default')!.total;
      const max = Math.min(agent.config.maxConcurrent || 1, Number(process.env.AGENT_MAX_CONCURRENCY) || 8);
      if (active >= max) {
        if (this.abortControllers.get(task.id) === abortController) this.abortControllers.delete(task.id);
        throw new AgentConcurrencyError(agent.id, max);
      }
      return createExecution({
        taskId: task.id, agentDefId: agent.id,
        skillVersionId: runtimeSkill?.version.id.startsWith('file:') ? undefined : runtimeSkill?.version.id,
        workspaceId: task.workspaceId,
      });
    });
    updateAgentRun(execution.id, 'starting');
    this.abortControllers.set(task.id, abortController);
    const trace = createRunTrace({ taskId: task.id, executionId: execution.id, agentId: agent.id });
    const setup = getAgentSetupSnapshot(task.id);
    recordLedgerEntry({
      executionId: execution.id, taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId,
      type: 'agent.config.pinned', summary: setup?.versionId ? `Agent configuration ${setup.versionId}` : 'Legacy / phase-one configuration; no complete revision',
      metadata: { versionId: setup?.versionId, configHash: setup?.configHash,
        pinnedBeforeDispatch: setup?.pinnedBeforeDispatch || false, skillVersionId: runtimeSkill?.version.id },
    });
    const middleware = new ExecutionMiddlewareChain(
      agent,
      task,
      execution.id,
      resolveAgentRuntimeLimits(agent, undefined, task.contextLength),
    );
    const agentSpan = createTraceSpan({
      traceId: trace.id,
      type: 'agent.start',
      name: `${agent.name} execution`,
      metadata: { agentId: agent.id, taskId: task.id, role: agent.role },
    });

    updateTask(task.id, { status: 'running', assigneeId: agent.id, startedAt: new Date().toISOString() });
    eventBus.emit('task:started', { taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId });
    eventBus.emit('execution:started', { executionId: execution.id, taskId: task.id, agentDefId: agent.id, workspaceId: task.workspaceId });
    addTaskLog(task.id, 'info', `${agent.emoji} ${agent.name} started`, agent.id);
    addExecutionMessage({ executionId: execution.id, type: 'user_input', content: task.input });

    try {
      this.enforceAgentRateLimit(agent.id);
      const knowledgeContext = prepareRuntimeKnowledge(agent, task, execution.id);
      if (knowledgeContext) task = { ...task, input: task.input + knowledgeContext };
      const resolvedWorld = await resolveExecutionWorld();
      const world = 'capabilities' in resolvedWorld ? resolvedWorld.capabilities : resolvedWorld;
      updateAgentRun(execution.id, 'deciding', { executionWorld: {
        mode: world.mode, filesystemIsolation: world.isolation.filesystem, processIsolation: world.isolation.process,
        networkIsolation: world.isolation.network, credentialIsolation: world.isolation.credentials, externalMcpIsolated: false,
      } });

      const budget = runtimeV2Enabled() ? { allowed: true, reason: undefined } : guardrails.checkBudget();
      if (!budget.allowed) throw new Error(`Budget exceeded: ${budget.reason}`);
      recordLedgerEntry({
        executionId: execution.id, taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId,
        type: 'budget.checked', decision: 'allowed',
        summary: 'Budget check passed before execution',
      });

      const adapter = selectRuntimeAdapter(agent, this.runtimeAdapters) || this.runtimeAdapters[this.runtimeAdapters.length - 1];
      if (currentWorkspaceAccessMode() === 'shared_readonly' && adapter.name !== 'ts-agent-loop') throw new Error('WORKSPACE_READONLY_RUNTIME_UNSUPPORTED');
      if (agent.config.governanceBudget && adapter.name !== 'ts-agent-loop') {
        throw new Error('BUDGET_RUNTIME_UNSUPPORTED: configured hard limits require the governed host loop');
      }
      prepareTaskBudget(agent, task, resolveAgentRuntimeLimits(agent, undefined, task.contextLength));
      updateAgentRun(execution.id, 'deciding', { runtime: adapter.name });
      middleware.beforeExecution(adapter.name);
      addTaskLog(task.id, 'info', `Executor: ${adapter.name}`, 'system');
      recordLedgerEntry({
        executionId: execution.id, taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId,
        type: 'runtime.selected', decision: adapter.name,
        summary: `Selected ${adapter.name} runtime for ${agent.name}`,
        metadata: { runtime: adapter.name, role: agent.role },
      });

      const inputQuestion = missingContractInput(agent, task);
      const result = inputQuestion ? {
        output: JSON.stringify({ kind: 'myrmecia.request_input', question: inputQuestion }),
        inputTokens: 0, outputTokens: 0, numTurns: 0, durationMs: 0, costUSD: null,
      } : await adapter.execute({
        agent, task, abortController,
        executionId: execution.id,
        traceId: trace.id,
        spanId: agentSpan.id,
        tracker,
        runtimeSkill,
        middleware,
      });
      if (abortController.signal.aborted || getTask(task.id)?.status === 'cancelled') {
        throw new AgentRunStopped('cancelled', 'Execution cancelled; late output was not committed', result.output);
      }
      if (['failed', 'done'].includes(getTask(task.id)?.status || '')) {
        throw new AgentRunStopped('interrupted', 'AGENT_STOPPED: task was settled while the execution was running', result.output);
      }
      if (result.stopReason && result.stopReason !== 'completed' && result.stopReason !== 'needs_input') {
        throw new AgentRunStopped(result.stopReason, `AGENT_STOPPED: ${result.stopReason}`, result.output);
      }
      assertRuntimeKnowledgeCurrent(execution.id);
      const safeOutput = sanitizeAgentOutput(result.output, {
        agentId: agent.id,
        taskId: task.id,
        workspaceId: task.workspaceId,
        executionId: execution.id,
        purpose: 'task output',
      });
      const inputRequest = requestedAgentInput(safeOutput);
      const safeResult: TaskResult = {
        ...result, output: inputRequest || safeOutput, executionId: execution.id,
        stopReason: inputRequest ? 'needs_input' : result.stopReason || 'completed',
      };
      updateAgentRun(execution.id, 'validating');
      const validation = validateAgentOutput(safeOutput);
      if (validation.status !== 'passed') {
        updateAgentRun(execution.id, 'validating', { validation });
        throw new AgentRunStopped(safeOutput.trim() ? 'failed' : 'empty_output',
          `AGENT_EMPTY_OUTPUT: output validation failed: ${validation.checks.filter(check => !check.passed).map(check => check.message).join('; ')}`, safeOutput);
      }
      assertExecutionTokenBudget(safeResult.inputTokens, safeResult.outputTokens, safeResult.output, 'agent execution');
      if (safeResult.stopReason !== 'needs_input') {
        middleware.validateDevelopmentDelivery(task.workdir || process.cwd(), safeResult.output);
      }

      if (!runtimeV2Enabled() && safeResult.costUSD != null) guardrails.trackCost(task.id, safeResult.costUSD);
      middleware.afterExecution({
        inputTokens: safeResult.inputTokens,
        outputTokens: safeResult.outputTokens,
        durationMs: safeResult.durationMs,
        numTurns: safeResult.numTurns,
      });

      if (safeResult.stopReason === 'needs_input') {
        clearPauseControl('task', task.id);
        if (task.pipelineId) throw new AgentRunStopped('needs_input', 'AGENT_STOPPED: workflow input requires manual intervention', safeResult.output);
        try {
          recordWorkspaceBoundary(task);
          indexExecutionArtifacts({ task, executionId: execution.id, output: safeResult.output,
            startedAtMs: executionStartedAtMs, captureState: 'partial', baseline: artifactBaseline });
        } catch (error: any) {
          throw new AgentRunStopped('tool_unavailable', error.message || 'ARTIFACT_CAPTURE_FAILED', safeResult.output);
        }
        const progress = getProgressSnapshot(tracker, 'Waiting for user input');
        updateAgentRun(execution.id, 'waiting_for_user', { stopReason: 'needs_input', validation, turn: safeResult.numTurns });
        updateExecution(execution.id, {
          status: 'done', progress, costUSD: safeResult.costUSD, costType: safeResult.costType || 'unavailable',
          inputTokens: safeResult.inputTokens, outputTokens: safeResult.outputTokens,
          tokenCount: safeResult.inputTokens + safeResult.outputTokens, completedAt: new Date().toISOString(),
          provider: safeResult.provider, actualModelId: safeResult.actualModelId,
        });
        const waiting = updateTask(task.id, { status: 'review', output: safeResult.output, completedAt: new Date().toISOString() });
        checkpointExecutionContext(executionContext, {
          phase: 'waiting_for_user', completed: [], pending: ['user input'], blocked: [],
          resumeHint: 'Continue this conversation with fresh user input; do not replay prior approvals.',
        });
        recordLedgerEntry({
          executionId: execution.id, taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId,
          type: 'execution.waiting_for_user', decision: 'needs_input', summary: 'Agent requested essential user input',
        });
        eventBus.emit('task:updated', { taskId: task.id, task: waiting, workspaceId: task.workspaceId });
        eventBus.emit('execution:done', { executionId: execution.id, taskId: task.id, workspaceId: task.workspaceId, progress });
        return safeResult;
      }

      // Artifact availability must be established before outcome verification, not after "done".
      // Failed/unavailable checks still need truthful model provenance.
      updateExecution(execution.id, { provider: safeResult.provider, actualModelId: safeResult.actualModelId });
      try {
        recordWorkspaceBoundary(task);
        if (workspacePath && currentWorkspaceAccessMode() !== 'shared_readonly') {
          const { mkdirSync, writeFileSync } = await import('node:fs');
          const outputDir = safeWorkspacePath(workspacePath, 'output');
          mkdirSync(outputDir, { recursive: true });
          writeFileSync(safeWorkspacePath(workspacePath, 'output/summary.md'), safeResult.output || '', 'utf8');
          const executionDir = safeWorkspacePath(workspacePath, 'output/executions');
          mkdirSync(executionDir, { recursive: true });
          writeFileSync(safeWorkspacePath(workspacePath, `output/executions/${execution.id}.md`), safeResult.output || '', 'utf8');
        }
        indexExecutionArtifacts({ task, executionId: execution.id, output: safeResult.output, startedAtMs: executionStartedAtMs, baseline: artifactBaseline });
      } catch (error: any) {
        throw new AgentRunStopped('tool_unavailable', error.message || 'ARTIFACT_CAPTURE_FAILED', safeResult.output);
      }
      const verification = await verifyCompletionCriteria(task, execution.id, safeResult.output, abortController.signal);
      assertRunWrite(task.id);
      if (abortController.signal.aborted || getTask(task.id)?.status === 'cancelled') {
        throw new AgentRunStopped('cancelled', 'Execution cancelled during completion verification', safeResult.output);
      }
      clearPauseControl('task', task.id);
      updateAgentRun(execution.id, 'validating', { verification });
      if (!['passed', 'not_requested'].includes(verification.status)) {
        throw new AgentRunStopped(verification.status === 'unavailable' ? 'tool_unavailable' : 'failed',
          `COMPLETION_CRITERIA_${verification.status.toUpperCase()}: mandatory outcome evidence did not pass`, safeResult.output);
      }
      const finalProgress = getProgressSnapshot(tracker, 'Execution finished');
      updateAgentRun(execution.id, 'completed', {
        stopReason: 'completed', validation, verification, turn: safeResult.numTurns,
      });
      updateExecution(execution.id, {
        status: 'done', progress: finalProgress,
        costUSD: safeResult.costUSD,
        costType: safeResult.costType || (safeResult.costUSD == null ? 'unavailable' : 'estimated'),
        provider: safeResult.provider,
        actualModelId: safeResult.actualModelId,
        inputTokens: safeResult.inputTokens,
        outputTokens: safeResult.outputTokens,
        aiUnits: safeResult.aiUnits || 0,
        billingMultiplier: safeResult.billingMultiplier,
        tokenCount: safeResult.inputTokens + safeResult.outputTokens,
        completedAt: new Date().toISOString(),
      });

      // Guard against resurrecting a task that reached a terminal state (e.g.
      // cancelled by the user or the dependency cascade) while this execution
      // was completing. Mirrors the catch path's terminal check.
      const priorStatus = getTask(task.id)?.status;
      const settledDuringRun = priorStatus === 'cancelled' || priorStatus === 'failed' || priorStatus === 'done';
      if (!settledDuringRun) {
        updateTask(task.id, { status: 'done', output: safeResult.output, completedAt: new Date().toISOString() });
      }
      checkpointExecutionContext(executionContext, {
        phase: 'completed',
        completed: ['agent execution'],
        pending: [],
        blocked: [],
        lastValidation: { executionId: execution.id, status: 'done', durationMs: safeResult.durationMs },
        resumeHint: 'Execution completed; inspect QA/review state before making further changes.',
      });
      recordLedgerEntry({
        executionId: execution.id, taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId,
        type: 'execution.completed', decision: 'done',
        summary: `Execution completed in ${Math.round(safeResult.durationMs / 1000)}s`,
        metadata: {
          costUSD: safeResult.costUSD,
          costType: safeResult.costType,
          provider: safeResult.provider,
          actualModelId: safeResult.actualModelId,
          aiUnits: safeResult.aiUnits,
          inputTokens: safeResult.inputTokens,
          outputTokens: safeResult.outputTokens,
          numTurns: safeResult.numTurns,
          durationMs: safeResult.durationMs,
        },
      });

      const stats = { ...agent.stats };
      stats.tasksCompleted++;
      stats.lastActiveAt = new Date().toISOString();
      const totalDuration = stats.avgDurationMs * (stats.tasksCompleted - 1) + safeResult.durationMs;
      stats.avgDurationMs = Math.round(totalDuration / stats.tasksCompleted);
      updateAgent(agent.id, { stats });

      const costLabel = safeResult.costUSD == null ? 'cost N/A' : `$${safeResult.costUSD.toFixed(4)}`;
      addTaskLog(task.id, 'info', `Done ${Math.round(safeResult.durationMs / 1000)}s | ${costLabel} | ${safeResult.numTurns} turns`, agent.id);
      completeTraceSpan(agentSpan.id, { status: 'done', metadata: { durationMs: safeResult.durationMs, numTurns: safeResult.numTurns } });
      completeRunTrace(trace.id, { status: 'done', summary: 'Completed' });
      if (!settledDuringRun) {
        eventBus.emit('task:done', { taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId, output: safeResult.output, cost: safeResult.costUSD });
      }
      eventBus.emit('execution:done', { executionId: execution.id, taskId: task.id, workspaceId: task.workspaceId, progress: finalProgress });

      // Record trajectory for semantic routing learning
      this.recordTrajectory(task, agent.id, true, safeResult.durationMs, safeResult.costUSD || 0, safeResult.output, execution.id);

      // Emit telemetry metrics
      metrics.taskExecutions.add(1, { status: 'done' });
      metrics.taskDuration.record(safeResult.durationMs);
      metrics.agentExecutions.add(1, { agentId: agent.id, status: 'done' });
      metrics.tokenUsage.add(safeResult.inputTokens + safeResult.outputTokens);
      if (safeResult.costUSD != null) {
        metrics.costMicrodollars.add(Math.round(safeResult.costUSD * 1_000_000));
      }

      return safeResult;
    } catch (err: any) {
      if (!/FENCE_LOST|ARTIFACT_CAPTURE_FAILED/.test(err?.message || '')) {
        try { indexExecutionArtifacts({ task, executionId: execution.id, output: String(err.partialOutput || ''), startedAtMs: executionStartedAtMs, captureState: 'partial', baseline: artifactBaseline }); }
        catch (captureError) { logger.warn({ taskId: task.id }, 'Partial artifact capture unavailable; retained directory requires reconciliation'); }
      }
      if (/RUN_FENCE_LOST/.test(err?.message || '')) {
        abortController.abort();
        throw err;
      }
      if (err instanceof UserPauseReached && getTask(task.id)?.status !== 'cancelled') {
        recordWorkspaceBoundary(task);
        updateAgentRun(execution.id, 'interrupted', { stopReason: 'interrupted', userPaused: true });
        updateExecution(execution.id, { status: 'failed', completedAt: new Date().toISOString() });
        setPauseControl('task', task.id, 'paused');
        const held = updateTask(task.id, { status: 'queued', error: null });
        addTaskLog(task.id, 'info', 'User pause reached a stable turn boundary; execution history and checkpoint retained', 'runtime');
        completeTraceSpan(agentSpan.id, { status: 'done', metadata: { userPaused: true } });
        completeRunTrace(trace.id, { status: 'done', summary: 'User pause at stable checkpoint; task awaits resume' });
        eventBus.emit('task:updated', { taskId: task.id, task: held, workspaceId: task.workspaceId });
        eventBus.emit('execution:failed', { executionId: execution.id, taskId: task.id, workspaceId: task.workspaceId, stopReason: 'interrupted' });
        throw err;
      }
      if (err instanceof RuntimeSliceYield) {
        updateAgentRun(execution.id, 'interrupted', { stopReason: 'interrupted' });
        updateExecution(execution.id, { status: 'failed', completedAt: new Date().toISOString() });
        updateTask(task.id, { status: 'queued', error: null });
        addTaskLog(task.id, 'info', 'Run slice completed at a stable read-only boundary; continuation awaits the same queue', 'runtime');
        throw err;
      }
      middleware.onError(err);
      if (getPauseControl('task', task.id)) setPauseControl('task', task.id, 'paused');
      const errorMsg = err.message || 'Unknown error';
      const priorStatus = getTask(task.id)?.status;
      // Provider/tool timeouts can also abort a request; that is not a user
      // cancellation. Only the task/canonical abort error proves cancel.
      const stopReason = classifyAgentStop(err, priorStatus === 'cancelled');
      const cancelled = stopReason === 'cancelled';
      updateAgentRun(execution.id, cancelled ? 'cancelled' : stopReason === 'interrupted' ? 'interrupted' : 'failed', { stopReason });
      const failureProgress = getProgressSnapshot(tracker);
      // A provider-owned loop can publish partial measured usage before throwing.
      // The host tracker has no successful model result in that case; do not reset it to zero.
      failureProgress.tokenCount = Math.max(failureProgress.tokenCount, getExecution(execution.id)?.progress.tokenCount || 0);
      updateExecution(execution.id, { status: cancelled ? 'cancelled' : 'failed', progress: failureProgress, completedAt: new Date().toISOString() });
      addExecutionMessage({ executionId: execution.id, type: 'error', content: errorMsg });

      // If the task was already settled (cancelled by the user or the dependency
      // cascade, which aborts the in-flight execution), don't overwrite that
      // terminal state or re-emit task:failed — doing so would re-trigger the
      // cascade and flip an already-final status.
      const alreadyTerminal = priorStatus === 'cancelled' || priorStatus === 'failed' || priorStatus === 'done';
      if (!alreadyTerminal) {
        const partialOutput = err instanceof AgentRunStopped && err.partialOutput
          ? sanitizeAgentOutput(err.partialOutput, { agentId: agent.id, taskId: task.id, executionId: execution.id, workspaceId: task.workspaceId, purpose: 'partial output' })
          : undefined;
        updateTask(task.id, { status: cancelled ? 'cancelled' : 'failed', error: errorMsg, ...(partialOutput ? { output: partialOutput } : {}) });
      }
      checkpointExecutionContext(loadExecutionContext(task), {
        phase: cancelled ? 'cancelled' : 'failed',
        completed: [],
        pending: ['operator retry or replan'],
        blocked: [errorMsg],
        lastValidation: { executionId: execution.id, status: cancelled ? 'cancelled' : 'failed', stopReason },
        resumeHint: 'Inspect the failure and retry from this checkpoint or replan the task.',
      });

      const stats = { ...agent.stats };
      if (!cancelled) {
        stats.tasksFailed++;
        updateAgent(agent.id, { stats });
      }

      addTaskLog(task.id, alreadyTerminal ? 'warn' : 'error',
        alreadyTerminal ? `Execution stopped (task already ${priorStatus}): ${errorMsg}` : `Failed: ${errorMsg}`,
        agent.id);
      recordLedgerEntry({
        executionId: execution.id, taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId,
        type: 'execution.failed', decision: 'failed',
        summary: `Execution failed: ${errorMsg}`.slice(0, 500),
        metadata: { error: errorMsg },
      });
      completeTraceSpan(agentSpan.id, { status: 'failed', error: errorMsg });
      completeRunTrace(trace.id, { status: 'failed', summary: errorMsg });
      if (!alreadyTerminal && !cancelled && !queueOwnsRetry(task.id)) {
        eventBus.emit('task:failed', { taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId, error: errorMsg });
      }
      if (!alreadyTerminal && cancelled) {
        eventBus.emit('task:cancelled', { taskId: task.id, workspaceId: task.workspaceId });
      }
      eventBus.emit(cancelled ? 'execution:done' : 'execution:failed', { executionId: execution.id, taskId: task.id, workspaceId: task.workspaceId, error: errorMsg, stopReason });

      // Record failed trajectory too (for learning what doesn't work)
      if (!cancelled) this.recordTrajectory(task, agent.id, false, Date.now() - (Date.parse(task.startedAt || '') || Date.now()), 0, errorMsg, execution.id);

      // Emit failure telemetry
      metrics.taskExecutions.add(1, { status: cancelled ? 'cancelled' : 'failed' });
      metrics.agentExecutions.add(1, { agentId: agent.id, status: cancelled ? 'cancelled' : 'failed' });

      throw err;
    } finally {
      try {
        const status = getExecution(execution.id)?.status;
        if (status !== 'running') finalizeInboxForExecution(task.workspaceId || 'default', execution.id);
        if (runtimeV2Enabled() && ['done', 'failed', 'cancelled'].includes(getTask(task.id)?.status || '')) settleContinuation(task);
      } finally {
        if (this.abortControllers.get(task.id) === abortController) this.abortControllers.delete(task.id);
      }
    }
  }

  /** Record task trajectory + episodic memory (fire-and-forget) */
  private recordTrajectory(task: Task, agentId: string, success: boolean, durationMs: number, costUSD: number, output?: string, executionId?: string): void {
    if (isDocumentSession(task) || hasPrivateKnowledgeContext(task)) return; // Private/session evidence must not enter global recall.
    // Quality score: success=0.8 base, penalize high cost, reward fast completion
    const quality = success
      ? Math.min(1, 0.8 + (durationMs < 60000 ? 0.1 : 0) + (costUSD < 0.01 ? 0.1 : 0))
      : 0.2;

    // A successful adapter call is not verified task quality. Only failures are
    // useful routing evidence here; positive learning needs an accepted eval.
    if (!success) getTrajectoryStore().record({
      taskInput: task.input,
      agentId,
      mode: task.mode,
      templateId: task.pipelineId || undefined,
      success,
      quality,
      durationMs,
    }).catch(() => { /* non-critical, don't break execution */ });

    // Richer, workspace-scoped episode for long-term context recall.
    getMemoryService().captureEpisode({
      taskId: task.id,
      executionId,
      input: task.input,
      output,
      agentId,
      mode: task.mode,
      workspaceId: task.workspaceId,
      pipelineId: task.pipelineId || undefined,
      success,
      quality,
    }).catch(() => { /* non-critical */ });

    // Automatic extraction can overwrite confirmed facts with model prose.
    // Keep generated episodes quarantined; promotion requires explicit review.
  }

  private enforceAgentRateLimit(agentId: string): void {
    const limits = getRuntimeLimits();
    const now = Date.now();
    const windowStart = now - limits.agentRateWindowMs;
    const recent = (this.agentExecutionWindows.get(agentId) || []).filter(timestamp => timestamp >= windowStart);
    if (recent.length >= limits.maxAgentExecutionsPerWindow) {
      throw new Error(`Agent ${agentId} exceeded rate limit (${limits.maxAgentExecutionsPerWindow}/${limits.agentRateWindowMs}ms)`);
    }
    recent.push(now);
    this.agentExecutionWindows.set(agentId, recent);
  }

  cancel(taskId: string) {
    const controller = this.abortControllers.get(taskId);
    if (controller) { controller.abort(); this.abortControllers.delete(taskId); }
  }
}

export const agentRuntime = new AgentRuntime();
