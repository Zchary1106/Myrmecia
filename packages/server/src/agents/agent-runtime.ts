import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AgentDefinition, Task, AgentProgress, ToolActivity, ProgressTracker } from '../types.js';
import { eventBus } from '../events/event-bus.js';
import { updateTask, addTaskLog } from '../db/models/task.js';
import { updateAgent } from '../db/models/agent.js';
import { createExecution, updateExecution, addExecutionMessage } from '../db/models/execution.js';
import { guardrails } from './safety-guardrails.js';
import { workspaceManager } from '../workspace/workspace-manager.js';
import { createToolExecution, completeToolExecution, summarizeToolPayload } from '../tools/tool-execution.js';
import { resolveAllowedToolsForAgent } from '../tools/tool-policy.js';
import { completeRunTrace, completeTraceSpan, createRunTrace, createTraceSpan } from '../db/models/trace.js';
import { recordModelUsage, selectModelForAgent } from '../models/model-registry.js';
import { resolveSkillForAgent } from '../db/models/skill.js';
import { getExecutor, DEFAULT_LIMITS } from './executor.js';
import { getTrajectoryStore } from '../memory/trajectory-store.js';
import { messageBus } from './message-bus.js';
import { tsAgentLoop } from './ts-agent-loop.js';
import { metrics } from '../observability/telemetry.js';
import type { SkillDefinition, SkillVersion } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_RECENT_ACTIVITIES = 5;

// Path to CrewAI runner
const CREW_RUNNER = join(__dirname, '../../../../packages/crew/crew_runner.py');

function shouldUseTsLoop(agent: AgentDefinition): boolean {
  const executor = process.env.AGENT_EXECUTOR;
  if (executor === 'ts') return true;
  if (executor === 'crewai') return false;

  // Default: use TS loop when agent has no tools (no Python dependency)
  const tools = agent.allowedTools || agent.config.allowedTools || [];
  return tools.length === 0;
}

export interface TaskResult {
  output: string;
  costUSD: number;
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

  async execute(agent: AgentDefinition, task: Task): Promise<TaskResult> {
    const abortController = new AbortController();
    this.abortControllers.set(task.id, abortController);
    const tracker = createProgressTracker();

    // Ensure workspace exists for this task
    let workspacePath = task.workspacePath;
    if (!workspacePath && !task.pipelineId) {
      try {
        const ws = await workspaceManager.createTaskWorkspace(task.id);
        workspacePath = ws.path;
        updateTask(task.id, { workspacePath });
        addTaskLog(task.id, 'info', `📁 Created workspace: ${ws.path}`, 'system');
      } catch (err: any) {
        addTaskLog(task.id, 'warn', `Workspace creation failed: ${err.message}`, 'system');
      }
    }
    if (workspacePath && !task.workdir) {
      task.workdir = workspacePath;
    }

    // Create execution instance
    const runtimeSkill = resolveSkillForAgent(agent);
    const execution = createExecution({ taskId: task.id, agentDefId: agent.id, skillVersionId: runtimeSkill?.version.id });
    const trace = createRunTrace({ taskId: task.id, executionId: execution.id, agentId: agent.id });
    const agentSpan = createTraceSpan({
      traceId: trace.id,
      type: 'agent.start',
      name: `${agent.name} execution`,
      metadata: { agentId: agent.id, taskId: task.id, role: agent.role },
    });

    updateTask(task.id, { status: 'running', assigneeId: agent.id, startedAt: new Date().toISOString() });
    eventBus.emit('task:started', { taskId: task.id, agentId: agent.id });
    eventBus.emit('execution:started', { executionId: execution.id, taskId: task.id, agentDefId: agent.id });
    addTaskLog(task.id, 'info', `${agent.emoji} ${agent.name} started`, agent.id);
    addExecutionMessage({ executionId: execution.id, type: 'user_input', content: task.input });

    try {
      const budget = guardrails.checkBudget();
      if (!budget.allowed) throw new Error(`Budget exceeded: ${budget.reason}`);

      const useTs = shouldUseTsLoop(agent);
      addTaskLog(task.id, 'info', `Executor: ${useTs ? 'TS Agent Loop' : 'CrewAI (Python)'}`, 'system');

      const result = useTs
        ? await tsAgentLoop.execute(agent, task, abortController, execution.id, trace.id, agentSpan.id, tracker, runtimeSkill)
        : await this.executeWithCrewAI(agent, task, abortController, execution.id, trace.id, agentSpan.id, tracker, runtimeSkill);

      guardrails.trackCost(task.id, result.costUSD);

      const finalProgress = getProgressSnapshot(tracker, 'Completed');
      updateExecution(execution.id, {
        status: 'done', progress: finalProgress,
        costUSD: result.costUSD, tokenCount: result.inputTokens + result.outputTokens,
        completedAt: new Date().toISOString(),
      });

      updateTask(task.id, { status: 'done', output: result.output, completedAt: new Date().toISOString() });

      // Write output summary to workspace
      if (workspacePath) {
        try {
          const { writeFileSync, mkdirSync } = await import('fs');
          const { join } = await import('path');
          mkdirSync(join(workspacePath, 'output'), { recursive: true });
          writeFileSync(join(workspacePath, 'output', 'summary.md'), result.output || '', 'utf-8');
        } catch {}
      }

      const stats = { ...agent.stats };
      stats.tasksCompleted++;
      stats.lastActiveAt = new Date().toISOString();
      const totalDuration = stats.avgDurationMs * (stats.tasksCompleted - 1) + result.durationMs;
      stats.avgDurationMs = Math.round(totalDuration / stats.tasksCompleted);
      updateAgent(agent.id, { stats });

      addTaskLog(task.id, 'info', `Done ${Math.round(result.durationMs / 1000)}s | $${result.costUSD.toFixed(4)} | ${result.numTurns} turns`, agent.id);
      completeTraceSpan(agentSpan.id, { status: 'done', metadata: { durationMs: result.durationMs, numTurns: result.numTurns } });
      completeRunTrace(trace.id, { status: 'done', summary: 'Completed' });
      eventBus.emit('task:done', { taskId: task.id, agentId: agent.id, output: result.output, cost: result.costUSD });
      eventBus.emit('execution:done', { executionId: execution.id, taskId: task.id, progress: finalProgress });

      // Record trajectory for semantic routing learning
      this.recordTrajectory(task, agent.id, true, result.durationMs, result.costUSD);

      // Emit telemetry metrics
      metrics.taskExecutions.add(1, { status: 'done' });
      metrics.taskDuration.record(result.durationMs);
      metrics.agentExecutions.add(1, { agentId: agent.id, status: 'done' });
      metrics.tokenUsage.add(result.inputTokens + result.outputTokens);
      metrics.costMicrodollars.add(Math.round(result.costUSD * 1_000_000));

      return result;
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error';
      updateExecution(execution.id, { status: 'failed', progress: getProgressSnapshot(tracker), completedAt: new Date().toISOString() });
      addExecutionMessage({ executionId: execution.id, type: 'error', content: errorMsg });
      updateTask(task.id, { status: 'failed', error: errorMsg });

      const stats = { ...agent.stats };
      stats.tasksFailed++;
      updateAgent(agent.id, { stats });

      addTaskLog(task.id, 'error', `Failed: ${errorMsg}`, agent.id);
      completeTraceSpan(agentSpan.id, { status: 'failed', error: errorMsg });
      completeRunTrace(trace.id, { status: 'failed', summary: errorMsg });
      eventBus.emit('task:failed', { taskId: task.id, agentId: agent.id, error: errorMsg });
      eventBus.emit('execution:failed', { executionId: execution.id, taskId: task.id, error: errorMsg });

      // Record failed trajectory too (for learning what doesn't work)
      this.recordTrajectory(task, agent.id, false, Date.now() - (Date.parse(task.startedAt || '') || Date.now()), 0);

      // Emit failure telemetry
      metrics.taskExecutions.add(1, { status: 'failed' });
      metrics.agentExecutions.add(1, { agentId: agent.id, status: 'failed' });

      throw err;
    } finally {
      this.abortControllers.delete(task.id);
    }
  }

  /** Record task trajectory for semantic learning (fire-and-forget) */
  private recordTrajectory(task: Task, agentId: string, success: boolean, durationMs: number, costUSD: number): void {
    // Quality score: success=0.8 base, penalize high cost, reward fast completion
    const quality = success
      ? Math.min(1, 0.8 + (durationMs < 60000 ? 0.1 : 0) + (costUSD < 0.01 ? 0.1 : 0))
      : 0.2;

    getTrajectoryStore().record({
      taskInput: task.input,
      agentId,
      mode: task.mode,
      templateId: task.pipelineId || undefined,
      success,
      quality,
      durationMs,
    }).catch(() => { /* non-critical, don't break execution */ });
  }

  private recordText(executionId: string, text: string) {
    const snippet = text.slice(0, 500);
    addExecutionMessage({ executionId, type: 'agent_text', content: snippet });
    eventBus.emit('execution:message', { executionId, type: 'agent_text', content: snippet });
    return snippet;
  }

  private recordToolStarted(
    executionId: string,
    traceId: string,
    parentSpanId: string,
    task: Task,
    agent: AgentDefinition,
    tracker: ProgressTracker,
    event: any,
  ) {
    const toolName = String(event.toolName || event.toolId || event.name || 'unknown');
    const input = event.input || {};
    const record = createToolExecution({
      id: event.toolExecutionId,
      toolId: toolName,
      taskId: task.id,
      executionId,
      agentId: agent.id,
      input,
      startedAt: event.startedAt,
    });
    tracker.toolUseCount++;
    const activity: ToolActivity = {
      toolName,
      input: input && typeof input === 'object' && !Array.isArray(input) ? input : { value: input },
      activityDescription: `Using ${toolName}`,
      isSearch: toolName.includes('search'),
      isRead: toolName.includes('fetch') || toolName.includes('crawler'),
      timestamp: event.startedAt || new Date().toISOString(),
    };
    tracker.recentActivities.push(activity);
    tracker.recentActivities = tracker.recentActivities.slice(-MAX_RECENT_ACTIVITIES);
    const progress = getProgressSnapshot(tracker, `Using ${toolName}`);
    updateExecution(executionId, { progress });
    const content = summarizeToolPayload(input);
    createTraceSpan({
      id: `span_${record.id}`,
      traceId,
      parentSpanId,
      type: 'tool.call',
      name: toolName,
      metadata: { toolExecutionId: record.id, inputSummary: content },
      startedAt: event.startedAt,
    });
    addExecutionMessage({ executionId, type: 'tool_use', content, toolName });
    eventBus.emit('tool:started', {
      toolExecutionId: record.id,
      toolId: toolName,
      taskId: task.id,
      executionId,
      agentId: agent.id,
      inputSummary: content,
    });
    eventBus.emit('execution:progress', { executionId, taskId: task.id, agentDefId: agent.id, progress });
  }

  private recordToolResult(executionId: string, task: Task, agent: AgentDefinition, event: any) {
    const toolName = String(event.toolName || event.toolId || event.name || 'unknown');
    const status = event.status === 'failed' || event.error ? 'failed' : 'done';
    const updated = completeToolExecution(String(event.toolExecutionId), {
      status,
      output: event.output ?? event.result,
      outputSummary: event.outputSummary,
      error: event.error,
      durationMs: event.durationMs,
      completedAt: event.completedAt,
    });
    const content = event.error || event.outputSummary || summarizeToolPayload(event.output ?? event.result);
    completeTraceSpan(`span_${event.toolExecutionId}`, {
      status,
      metadata: { outputSummary: content, durationMs: event.durationMs },
      error: event.error,
      durationMs: event.durationMs,
      completedAt: event.completedAt,
    });
    addExecutionMessage({ executionId, type: 'tool_result', content, toolName });
    eventBus.emit(status === 'failed' ? 'tool:failed' : 'tool:done', {
      toolExecutionId: updated?.id || event.toolExecutionId,
      toolId: toolName,
      taskId: task.id,
      executionId,
      agentId: agent.id,
      status,
      error: event.error,
      durationMs: event.durationMs,
      outputSummary: content,
    });
  }

  /**
   * Execute agent task via CrewAI (Python subprocess).
   * Spawns crew_runner.py which outputs JSON events to stdout.
   */
  private async executeWithCrewAI(
    agent: AgentDefinition, task: Task, abortController: AbortController,
    executionId: string, traceId: string, rootSpanId: string, tracker: ProgressTracker,
    runtimeSkill?: { skill: SkillDefinition; version: SkillVersion; source: 'assignment' | 'skillPath' },
  ): Promise<TaskResult> {
    const { spawn } = await import('child_process');
    const startTime = Date.now();
    const toolPolicy = resolveAllowedToolsForAgent(agent);
    for (const decision of toolPolicy.decisions.filter(decision => !decision.allowed)) {
      const message = `Tool ${decision.toolId} blocked by policy: ${decision.reason}`;
      const span = createTraceSpan({
        traceId,
        parentSpanId: rootSpanId,
        type: 'permission.check',
        name: `Tool policy: ${decision.toolId}`,
        metadata: { reason: decision.reason, approvalRequired: decision.approvalRequired },
      });
      completeTraceSpan(span.id, { status: 'blocked', metadata: { decision } });
      addTaskLog(task.id, 'warn', message, agent.id);
      addExecutionMessage({ executionId, type: 'progress', content: message, toolName: decision.toolId });
      eventBus.emit('tool:blocked', {
        toolId: decision.toolId,
        taskId: task.id,
        executionId,
        agentId: agent.id,
        reason: decision.reason,
      });
    }

    const promptSpan = createTraceSpan({
      traceId,
      parentSpanId: rootSpanId,
      type: 'prompt.build',
      name: 'Build runtime prompt',
      metadata: {
        skillPath: agent.skillPath,
        skillId: runtimeSkill?.skill.id,
        skillVersionId: runtimeSkill?.version.id,
        skillVersion: runtimeSkill?.version.version,
        skillChecksum: runtimeSkill?.version.checksum,
        skillSource: runtimeSkill?.source,
        requestedTools: toolPolicy.requestedTools,
      },
    });

    // Build system prompt from the skill file plus DB-editable profile fields.
    const runtimeProfile = [
      `You are ${agent.name}, a ${agent.role} agent.`,
      agent.description ? `Mission: ${agent.description}` : '',
      agent.whenToUse ? `When to use: ${agent.whenToUse}` : '',
      agent.capabilities?.length ? `Capabilities: ${agent.capabilities.join(', ')}` : '',
      toolPolicy.allowedTools.length
        ? `Allowed tools: ${toolPolicy.allowedTools.join(', ')}. Use them when they improve factual accuracy, research depth, formatting, or generated assets.`
        : '',
    ].filter(Boolean).join('\n\n');
    let systemPrompt = runtimeSkill
      ? `${runtimeSkill.version.content}\n\n## Runtime Profile Override\n${runtimeProfile}`
      : runtimeProfile;
    if (!runtimeSkill && agent.skillPath) {
      try {
        const skillRoot = join(__dirname, '../../../../');
        const skillPrompt = readFileSync(join(skillRoot, agent.skillPath), 'utf-8');
        systemPrompt = `${skillPrompt}\n\n## Runtime Profile Override\n${runtimeProfile}`;
      } catch {}
    }
    completeTraceSpan(promptSpan.id, {
      status: 'done',
      metadata: {
        allowedTools: toolPolicy.allowedTools,
        blockedTools: toolPolicy.decisions.filter(decision => !decision.allowed).map(decision => ({
          toolId: decision.toolId,
          reason: decision.reason,
        })),
        promptChars: task.input.length,
        systemPromptChars: systemPrompt.length,
      },
    });

    const modelSelection = selectModelForAgent(agent);
    const selectedModel = modelSelection.modelId;
    const modelSpan = createTraceSpan({
      traceId,
      parentSpanId: rootSpanId,
      type: 'model.route',
      name: 'Select model',
      metadata: modelSelection as unknown as Record<string, unknown>,
    });
    completeTraceSpan(modelSpan.id, { status: 'done' });

    // Inject pending messages from other agents into the prompt
    let enrichedInput = task.input;
    try {
      const pendingMsgs = messageBus.drain(executionId);
      if (pendingMsgs.length > 0) {
        const msgContext = pendingMsgs
          .map(m => `[${m.messageType}] ${m.content}`)
          .join('\n');
        enrichedInput = `${task.input}\n\n## Context from other agents:\n${msgContext}`;
        addTaskLog(task.id, 'info', `Injected ${pendingMsgs.length} message(s) from other agents`, 'system');
      }
    } catch { /* non-critical */ }

    // Build config JSON for crew_runner.py
    const config = JSON.stringify({
      agentId: agent.id,
      prompt: enrichedInput,
      systemPrompt,
      model: selectedModel,
      agentMeta: {
        name: agent.name,
        role: agent.role,
        description: agent.description,
        model: selectedModel,
          maxTurns: agent.maxTurns || agent.config.maxTurns,
      },
      allowedTools: toolPolicy.allowedTools,
      disallowedTools: agent.disallowedTools || [],
    });
    const llmSpan = createTraceSpan({
      traceId,
      parentSpanId: rootSpanId,
      type: 'llm.call',
      name: 'CrewAI kickoff',
      metadata: { model: selectedModel, runner: 'crew_runner.py' },
    });
    let llmSpanCompleted = false;
    const finishLlmSpan = (status: 'done' | 'failed', metadata?: Record<string, unknown>, error?: string) => {
      if (llmSpanCompleted) return;
      llmSpanCompleted = true;
      completeTraceSpan(llmSpan.id, {
        status,
        metadata,
        error,
        durationMs: Date.now() - startTime,
      });
    };

    return new Promise((resolve, reject) => {
      const executor = getExecutor();
      const proc = executor.spawn({
        executionId,
        command: 'python3',
        args: [CREW_RUNNER, config],
        workdir: task.workdir || agent.config.workdir || process.cwd(),
        env: {
          CREWAI_BASE_URL: process.env.CREWAI_BASE_URL || 'https://your-model-endpoint.example.com/v1',
          CREWAI_API_KEY: process.env.CREWAI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
          CREWAI_MODEL: process.env.CREWAI_MODEL || 'openai/gpt-5.4',
          AGENT_FACTORY_EXECUTION_ID: executionId,
          AGENT_FACTORY_TASK_ID: task.id,
          AGENT_FACTORY_AGENT_ID: agent.id,
        },
        signal: abortController.signal,
        limits: {
          ...DEFAULT_LIMITS,
          timeoutSec: agent.config.timeout || 300,
        },
      });

      let buffer = '', finalResult = '', costUSD = 0, inputTokens = 0, outputTokens = 0, numTurns = 0, stderrBuffer = '';

      proc.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);

            // Handle assistant messages (text output from CrewAI)
            if (ev.type === 'assistant' && ev.message?.content) {
              for (const block of ev.message.content) {
                if (block.type === 'text' && block.text) {
                  finalResult = block.text;
                  this.recordText(executionId, block.text);
                  addTaskLog(task.id, 'info', block.text.slice(0, 800), agent.id);
                }
              }
            }

            // Handle result event
            if (ev.type === 'result') {
              finalResult = ev.result || finalResult;
              costUSD = ev.total_cost_usd || 0;
              inputTokens = ev.usage?.input_tokens || 0;
              outputTokens = ev.usage?.output_tokens || 0;
              numTurns = ev.num_turns || 0;
            }

            if (ev.type === 'tool_use') {
              this.recordToolStarted(executionId, traceId, rootSpanId, task, agent, tracker, ev);
            }

            if (ev.type === 'tool_result') {
              this.recordToolResult(executionId, task, agent, ev);
            }

            // Handle error event
            if (ev.type === 'error') {
              addTaskLog(task.id, 'error', ev.message || 'Unknown CrewAI error', agent.id);
            }
          } catch {
            // Non-JSON line — append as text
            if (line.trim()) {
              finalResult += line + '\n';
            }
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const t = data.toString();
        stderrBuffer += t;
        // Only log meaningful stderr (skip Python warnings/noise)
        if (t.trim() && !t.includes('UserWarning') && !t.includes('DeprecationWarning')) {
          console.error(`[CrewAI stderr] ${t.slice(0, 500)}`);
          addTaskLog(task.id, 'warn', `stderr: ${t.slice(0, 300)}`, agent.id);
        }
      });

      const timeoutMs = (agent.config.timeout || 300) * 1000;
      const timeout = setTimeout(() => {
        abortController.abort();
        proc.kill('SIGTERM');
        finishLlmSpan('failed', { reason: 'timeout' }, `CrewAI timeout after ${agent.config.timeout || 300}s`);
        reject(new Error(`CrewAI timeout after ${agent.config.timeout || 300}s`));
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0 || finalResult) {
          finishLlmSpan('done', { exitCode: code, costUSD, inputTokens, outputTokens, numTurns });
          recordModelUsage({
            modelId: selectedModel,
            agentId: agent.id,
            taskId: task.id,
            executionId,
            status: 'success',
            inputTokens,
            outputTokens,
            costUSD,
            latencyMs: Date.now() - startTime,
            routeReason: modelSelection.reason,
          });
          resolve({
            output: finalResult,
            costUSD, inputTokens, outputTokens,
            durationMs: Date.now() - startTime,
            numTurns,
            executionId,
          });
        } else {
          const message = `CrewAI exit ${code}: ${stderrBuffer.slice(0, 500) || 'no output'}`;
          finishLlmSpan('failed', { exitCode: code }, message);
          recordModelUsage({
            modelId: selectedModel,
            agentId: agent.id,
            taskId: task.id,
            executionId,
            status: 'failed',
            latencyMs: Date.now() - startTime,
            routeReason: modelSelection.reason,
          });
          reject(new Error(message));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        finishLlmSpan('failed', { reason: 'spawn_error' }, err.message);
        recordModelUsage({
          modelId: selectedModel,
          agentId: agent.id,
          taskId: task.id,
          executionId,
          status: 'failed',
          latencyMs: Date.now() - startTime,
          routeReason: modelSelection.reason,
        });
        reject(new Error(`CrewAI spawn failed: ${err.message}`));
      });
    });
  }

  cancel(taskId: string) {
    const controller = this.abortControllers.get(taskId);
    if (controller) { controller.abort(); this.abortControllers.delete(taskId); }
  }
}

export const agentRuntime = new AgentRuntime();
