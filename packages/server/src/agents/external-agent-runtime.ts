import type {
  ExternalAgent,
  ExternalAgentAdapter,
  ExternalAgentHealth,
  ExternalAgentInvocationContext,
  ExternalAgentRun,
  ExternalAgentTriggerType,
} from '@myrmecia/shared';
import {
  createExternalAgentRun,
  getExternalAgent,
  getExternalAgentRun,
  updateExternalAgent,
  updateExternalAgentRun,
} from '../db/models/external-agent.js';
import { HttpAgentAdapter, LocalCliAgentAdapter } from './external-agent-adapters.js';
import { initialAgentRunState, validateAgentOutput } from './run-state.js';
import { sanitizeAgentOutput } from '../security/dlp-runtime.js';
import { createTask, getTask, updateTask } from '../db/models/task.js';
import { addExecutionMessage, createExecution, updateExecution } from '../db/models/execution.js';
import { eventBus } from '../events/event-bus.js';
import type { AgentRunState, ExternalAgentAdapterResult } from '@myrmecia/shared';
import { getDb } from '../db/database.js';

export class ExternalAgentRuntime {
  private readonly adapters: ExternalAgentAdapter[];
  private active = new Map<string, AbortController>();
  private callbacks = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(adapters: ExternalAgentAdapter[] = [new LocalCliAgentAdapter(), new HttpAgentAdapter()]) {
    this.adapters = adapters;
  }

  private adapterFor(agent: ExternalAgent): ExternalAgentAdapter {
    const adapter = this.adapters.find(candidate => candidate.kind === agent.adapter.kind);
    if (!adapter) throw new Error(`No adapter is registered for "${agent.adapter.kind}".`);
    return adapter;
  }

  async validate(agent: ExternalAgent): Promise<void> {
    await this.adapterFor(agent).validate(agent);
  }

  async healthCheck(agent: ExternalAgent): Promise<ExternalAgentHealth> {
    const health = await this.adapterFor(agent).healthCheck(agent);
    updateExternalAgent(agent.id, agent.workspaceId || 'default', {
      status: health.status === 'healthy' ? 'active' : 'degraded',
      lastHealthCheckAt: health.checkedAt,
      lastHealthStatus: health.status,
    });
    return health;
  }

  async run(
    externalAgentId: string,
    workspaceId: string,
    invocation: ExternalAgentInvocationContext,
    triggerType: ExternalAgentTriggerType = 'manual',
  ): Promise<ExternalAgentRun> {
    const agent = getExternalAgent(externalAgentId, workspaceId);
    if (!agent) throw new Error('External Agent was not found in this workspace.');
    if (agent.status === 'disabled') throw new Error('External Agent is disabled.');
    if (invocation.workspaceId && invocation.workspaceId !== workspaceId) throw new Error('Invocation workspace does not match the Agent workspace.');
    if (invocation.taskId && getTask(invocation.taskId)?.workspaceId !== workspaceId) throw new Error('Task does not belong to this workspace.');
    if (invocation.taskId && (getTask(invocation.taskId)?.mode !== 'direct' || getTask(invocation.taskId)?.pipelineId)) {
      throw new Error('External invocations can only attach direct tasks; workflow stages require governed dispatch');
    }
    if (invocation.taskId && !['pending', 'queued', 'assigned'].includes(getTask(invocation.taskId)?.status || '')) {
      throw new Error('Task is already running or settled; create a new invocation instead');
    }
    await this.validate(agent);
    if (invocation.taskId && !['pending', 'queued', 'assigned'].includes(getTask(invocation.taskId)?.status || '')) {
      throw new Error('Task was cancelled or started while the external Agent was being validated');
    }
    const task = invocation.taskId ? getTask(invocation.taskId)! : createTask({
      title: `${agent.name}: ${invocation.objective}`.slice(0, 160),
      description: invocation.objective, input: invocation.objective, mode: 'direct', workspaceId,
      workdir: invocation.workdir, createdBy: 'user', maxRetries: 0,
    });
    invocation = { ...invocation, taskId: task.id, workspaceId };
    const execution = createExecution({ taskId: task.id, agentDefId: `external:${agent.id}`, workspaceId });
    const run = createExternalAgentRun({
      externalAgentId: agent.id,
      workspaceId,
      taskId: invocation.taskId,
      triggerType,
      status: 'running',
      invocation,
      artifactIds: [],
      startedAt: new Date().toISOString(),
    });
    const controller = new AbortController();
    this.active.set(run.id, controller);
    const configuredTimeout = Number(process.env.MYRMECIA_EXTERNAL_CALLBACK_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(86_400_000, Math.max(1000, configuredTimeout)) : 900_000;
    const state = {
      ...initialAgentRunState(), phase: 'deciding' as const, runtime: `external-${agent.adapter.kind}`,
      agentName: agent.name, deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    };
    updateExternalAgentRun(run.id, workspaceId, { runState: state, executionId: execution.id });
    updateTask(task.id, { status: 'running', startedAt: new Date().toISOString() });
    updateExecution(execution.id, { runState: state });
    addExecutionMessage({ executionId: execution.id, type: 'user_input', content: invocation.objective });
    eventBus.emit('task:created', { taskId: task.id, task: getTask(task.id), workspaceId });
    eventBus.emit('execution:started', { executionId: execution.id, taskId: task.id, workspaceId });
    try {
      const result = await this.adapterFor(agent).execute(agent, { ...invocation, runId: run.id }, { signal: controller.signal });
      const current = getExternalAgentRun(run.id, workspaceId);
      if (current?.status === 'cancelled') return current;
      if (getTask(task.id)?.status === 'cancelled') {
        const cancelled = updateExternalAgentRun(run.id, workspaceId, {
          status: 'cancelled', error: 'Task cancelled; late external output was not committed. Remote effects require verification.',
          completedAt: new Date().toISOString(),
          runState: { ...state, phase: 'cancelled', stopReason: 'cancelled', updatedAt: new Date().toISOString() },
        })!;
        this.syncConversation(cancelled);
        return cancelled;
      }
      const output = sanitizeAgentOutput(result.outputSummary || '', { workspaceId, taskId: invocation.taskId, purpose: 'external Agent output' });
      const validation = validateAgentOutput(output);
      const emptyResult = result.status === 'succeeded' && validation.status !== 'passed';
      const succeeded = result.status === 'succeeded' && !emptyResult;
      const cancelled = result.status === 'cancelled';
      const updated = updateExternalAgentRun(run.id, workspaceId, {
        status: emptyResult ? 'failed' : result.status,
        outputSummary: output,
        externalRunId: result.externalRunId,
        error: emptyResult ? 'External Agent returned no deliverable' : result.error,
        runState: {
          ...state,
          phase: succeeded ? 'completed' : cancelled ? 'cancelled' : result.status === 'waiting_for_callback' ? 'waiting_for_tool' : 'failed',
          stopReason: succeeded ? 'completed' : cancelled ? 'cancelled' : result.status === 'timed_out' ? 'deadline' : emptyResult ? 'empty_output' : result.status === 'waiting_for_callback' ? undefined : 'failed',
          validation, updatedAt: new Date().toISOString(),
        },
        artifactIds: result.artifactIds || [],
        completedAt: result.status === 'waiting_for_callback' ? undefined : new Date().toISOString(),
      }) || run;
      this.syncConversation(updated);
      if (updated.status === 'waiting_for_callback') this.watchCallback(updated);
      return updated;
    } catch (error) {
      const current = getExternalAgentRun(run.id, workspaceId);
      if (current?.status === 'cancelled') return current;
      // Transport failures must not leave durable runs "running" forever.
      const updated = updateExternalAgentRun(run.id, workspaceId, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : String(error),
        runState: { ...state, phase: controller.signal.aborted ? 'cancelled' : 'failed', stopReason: controller.signal.aborted ? 'cancelled' : 'failed', updatedAt: new Date().toISOString() },
        completedAt: new Date().toISOString(),
      }) || run;
      this.syncConversation(updated);
      return updated;
    } finally {
      this.active.delete(run.id);
    }
  }

  private clearCallback(runId: string): void {
    const timer = this.callbacks.get(runId);
    if (timer) clearTimeout(timer);
    this.callbacks.delete(runId);
  }

  private watchCallback(run: ExternalAgentRun): void {
    this.clearCallback(run.id);
    const deadline = Date.parse(run.runState?.deadlineAt || '');
    if (!Number.isFinite(deadline)) return; // Historical detached jobs remain unknown.
    const timer = setTimeout(() => {
      this.callbacks.delete(run.id);
      const current = getExternalAgentRun(run.id, run.workspaceId || 'default');
      if (current?.status !== 'waiting_for_callback') return;
      const updated = updateExternalAgentRun(run.id, run.workspaceId || 'default', {
        status: 'timed_out',
        error: 'External Agent callback deadline exceeded; remote operation outcome needs verification',
        completedAt: new Date().toISOString(),
        runState: { ...(current.runState || initialAgentRunState()), phase: 'failed', stopReason: 'deadline', updatedAt: new Date().toISOString() },
      });
      if (updated) this.syncConversation(updated);
    }, Math.max(1, Math.min(86_400_000, deadline - Date.now())));
    timer.unref();
    this.callbacks.set(run.id, timer);
  }

  /** Re-arm durable deadlines, not remote dispatch, after a server restart. */
  recoverCallbacks(): void {
    const workspaces = getDb().all<{ workspace_id: string }>(
      "SELECT DISTINCT workspace_id FROM external_agent_runs WHERE status = 'waiting_for_callback'",
    );
    for (const { workspace_id } of workspaces) {
      // Iterate directly: a normal UI listing is bounded to 200 runs.
      const rows = getDb().all<{ id: string }>(
        "SELECT id FROM external_agent_runs WHERE workspace_id = ? AND status = 'waiting_for_callback'", workspace_id,
      );
      for (const row of rows) {
        const run = getExternalAgentRun(row.id, workspace_id);
        if (run) this.watchCallback(run);
      }
    }
  }

  private syncConversation(run: ExternalAgentRun): void {
    if (!run.taskId || !run.executionId || !run.runState) return;
    const task = getTask(run.taskId);
    const terminalTask = task && ['cancelled', 'failed', 'done'].includes(task.status);
    if (terminalTask && run.status !== 'cancelled') return;
    const succeeded = run.status === 'succeeded';
    const waiting = run.status === 'waiting_for_callback';
    const cancelled = run.status === 'cancelled';
    const updated = updateTask(run.taskId, {
      status: waiting ? 'waiting_for_tool' : succeeded ? 'done' : cancelled ? 'cancelled' : 'failed',
      ...(run.outputSummary ? { output: run.outputSummary } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(!waiting ? { completedAt: run.completedAt || new Date().toISOString() } : {}),
    });
    updateExecution(run.executionId, {
      status: waiting ? 'running' : succeeded ? 'done' : cancelled ? 'cancelled' : 'failed',
      runState: run.runState,
      ...(!waiting ? { completedAt: run.completedAt || new Date().toISOString() } : {}),
    });
    if (run.outputSummary || run.error || waiting) {
      const content = run.outputSummary || run.error || '外部 Agent 已接收任务，等待经过认证的结果回调。';
      const message = addExecutionMessage({
        executionId: run.executionId, type: waiting ? 'progress' : succeeded ? 'agent_text' : 'error', content,
      });
      eventBus.emit('execution:message', { executionId: run.executionId, taskId: run.taskId, workspaceId: run.workspaceId, message });
    }
    eventBus.emit('task:updated', { taskId: run.taskId, task: updated, workspaceId: run.workspaceId });
    if (!waiting) {
      // External writes are not automatically retried by the local task queue.
      if (cancelled) eventBus.emit('task:cancelled', { taskId: run.taskId, task: updated, workspaceId: run.workspaceId });
      eventBus.emit(succeeded || cancelled ? 'execution:done' : 'execution:failed', {
        executionId: run.executionId, taskId: run.taskId, workspaceId: run.workspaceId,
      });
    }
  }

  async completeCallback(runId: string, workspaceId: string, result: ExternalAgentAdapterResult): Promise<ExternalAgentRun> {
    const run = getExternalAgentRun(runId, workspaceId);
    if (!run) throw new Error('External Agent run not found');
    if (run.taskId && getTask(run.taskId)?.status === 'cancelled') throw new Error('Run already settled: owning task was cancelled');
    if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(result.status)) throw new Error('Callback must contain a terminal status');
    const output = sanitizeAgentOutput(result.outputSummary || '', { workspaceId, taskId: run.taskId, purpose: 'external callback' });
    if (run.status !== 'waiting_for_callback') {
      if (run.status === result.status && (run.outputSummary || '') === output
        && (run.error || '') === (result.error || '') && JSON.stringify(run.artifactIds) === JSON.stringify(result.artifactIds || [])) return run;
      throw new Error('Run already settled or not waiting for a callback');
    }
    if (run.externalRunId && result.externalRunId !== run.externalRunId) throw new Error('Remote run identifier does not match');
    const validation = validateAgentOutput(output);
    if (result.status === 'succeeded' && validation.status !== 'passed') {
      throw new Error('A callback must include usable output; artifact IDs alone are not verified deliverables');
    }
    const succeeded = result.status === 'succeeded', cancelled = result.status === 'cancelled';
    const runState: AgentRunState = {
      ...(run.runState || initialAgentRunState()), phase: succeeded ? 'completed' : cancelled ? 'cancelled' : 'failed',
      stopReason: succeeded ? 'completed' : cancelled ? 'cancelled' : result.status === 'timed_out' ? 'deadline' : 'failed',
      validation, updatedAt: new Date().toISOString(),
    };
    const updated = updateExternalAgentRun(runId, workspaceId, {
      status: result.status, outputSummary: output, error: result.error, artifactIds: result.artifactIds || [],
      runState, completedAt: new Date().toISOString(),
    })!;
    this.clearCallback(runId);
    this.syncConversation(updated);
    return updated;
  }

  async cancel(runId: string, workspaceId: string): Promise<ExternalAgentRun> {
    const run = getExternalAgentRun(runId, workspaceId);
    if (!run) throw new Error('External Agent run not found');
    const agent = getExternalAgent(run.externalAgentId, workspaceId);
    const controller = this.active.get(runId);
    if (!agent || !controller || !this.adapterFor(agent).supportsCancellation) {
      throw new Error('Cancellation is unsupported for this detached or remote run; verify its remote outcome');
    }
    const updated = updateExternalAgentRun(runId, workspaceId, {
      status: 'cancelled', completedAt: new Date().toISOString(),
      error: agent.adapter.kind === 'http' ? 'Local transport cancelled; remote operation outcome is unknown' : 'Local process cancellation requested',
      runState: { ...(run.runState || initialAgentRunState()), phase: 'cancelled', stopReason: 'cancelled', updatedAt: new Date().toISOString() },
    })!;
    controller.abort();
    this.syncConversation(updated);
    return updated;
  }
}

let runtime: ExternalAgentRuntime | undefined;

export function getExternalAgentRuntime(): ExternalAgentRuntime {
  runtime ||= new ExternalAgentRuntime();
  return runtime;
}
