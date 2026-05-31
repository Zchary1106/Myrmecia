import OpenAI from 'openai';
import type { AgentDefinition, Task, AgentProgress, ToolActivity, ProgressTracker } from '../types.js';
import { eventBus } from '../events/event-bus.js';
import { updateTask, addTaskLog } from '../db/models/task.js';
import { updateExecution, addExecutionMessage } from '../db/models/execution.js';
import { completeTraceSpan, createTraceSpan } from '../db/models/trace.js';
import { resolveAllowedToolsForAgent, validateToolParams } from '../tools/tool-policy.js';
import { createToolExecution, completeToolExecution, summarizeToolPayload } from '../tools/tool-execution.js';
import { estimateModelCost, recordModelUsage, selectModelForAgent } from '../models/model-registry.js';
import { messageBus } from './message-bus.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SkillDefinition, SkillVersion, SkillExecutorConfig } from '../types.js';
import { parseSkillContent } from '../skills/skill-parser.js';
import { SkillExecutor } from '../skills/skill-executor.js';
import { llmCache } from '../cache/llm-cache.js';
import { metrics } from '../observability/telemetry.js';
import { assertExecutionTokenBudget, remainingResponseTokens, resolveAgentRuntimeLimits } from './runtime-limits.js';
import { sanitizeAgentOutput } from '../security/dlp-runtime.js';
import { buildSandboxToolDefinition, executeTool, isSandboxTool } from '../skills/tool-sandbox.js';
import { appendExecutionAuditEvent, recordExecutionPolicySnapshot } from '../audit/execution-audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_RECENT_ACTIVITIES = 5;

function buildModelToolName(toolId: string, index: number): string {
  const safeName = toolId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return `tool_${index}_${safeName}`;
}

function buildModelToolDefinitions(toolIds: string[]) {
  const modelNameToToolId = new Map<string, string>();
  const toolDefs = toolIds.map((toolId, index) => {
    const modelToolName = buildModelToolName(toolId, index);
    modelNameToToolId.set(modelToolName, toolId);
    return buildSandboxToolDefinition(toolId, modelToolName);
  });
  return { toolDefs, modelNameToToolId };
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

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  return estimateModelCost(model, inputTokens, outputTokens);
}

function buildSystemPrompt(
  agent: AgentDefinition,
  toolPolicy: ReturnType<typeof resolveAllowedToolsForAgent>,
  runtimeSkill?: { skill: SkillDefinition; version: SkillVersion; source: string },
): string {
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

  return systemPrompt;
}

export class TsAgentLoop {
  private getClient(): OpenAI {
    const baseURL = process.env.AGENT_FACTORY_BASE_URL || 'https://your-model-endpoint.example.com/v1';
    const apiKey = process.env.AGENT_FACTORY_API_KEY || process.env.ANTHROPIC_API_KEY || '';
    return new OpenAI({ baseURL, apiKey });
  }

  async execute(
    agent: AgentDefinition,
    task: Task,
    abortController: AbortController,
    executionId: string,
    traceId: string,
    rootSpanId: string,
    tracker: ProgressTracker,
    runtimeSkill?: { skill: SkillDefinition; version: SkillVersion; source: 'assignment' | 'skillPath' },
  ): Promise<TaskResult> {
    const startTime = Date.now();
    const client = this.getClient();
    const toolPolicy = resolveAllowedToolsForAgent(agent);

    // Block disallowed tools (same as Python runtime path)
    for (const decision of toolPolicy.decisions.filter(d => !d.allowed)) {
      const message = `Tool ${decision.toolId} blocked by policy: ${decision.reason}`;
      const span = createTraceSpan({
        traceId, parentSpanId: rootSpanId, type: 'permission.check',
        name: `Tool policy: ${decision.toolId}`,
        metadata: { reason: decision.reason, approvalRequired: decision.approvalRequired },
      });
      completeTraceSpan(span.id, { status: 'blocked', metadata: { decision } });
      addTaskLog(task.id, 'warn', message, agent.id);
      addExecutionMessage({ executionId, type: 'progress', content: message, toolName: decision.toolId });
      eventBus.emit('tool:blocked', { toolId: decision.toolId, taskId: task.id, workspaceId: task.workspaceId, executionId, agentId: agent.id, reason: decision.reason });
    }

    const systemPrompt = buildSystemPrompt(agent, toolPolicy, runtimeSkill);

    // Check if the resolved skill is structured (step-driven)
    let parsedSkill = runtimeSkill
      ? parseSkillContent(runtimeSkill.version.content)
      : null;

    // If no structured skill resolved, try LLM matching
    if (!parsedSkill?.isStructured) {
      try {
        const { matchSkillForTask } = await import('../skills/skill-matcher.js');
        const { getLatestPublishedSkillVersion } = await import('../db/models/skill.js');
        const match = await matchSkillForTask(task.input, agent.role);
        if (match.skillId && match.confidence >= 0.7) {
          const version = getLatestPublishedSkillVersion(match.skillId);
          if (version) {
            const matched = parseSkillContent(version.content);
            if (matched.isStructured) {
              parsedSkill = matched;
              addTaskLog(task.id, 'info', `Skill matched: ${match.skillId} (${(match.confidence * 100).toFixed(0)}% — ${match.reason})`, 'system');
            }
          }
        }
      } catch { /* matcher unavailable, proceed without */ }
    }

    if (parsedSkill?.isStructured && parsedSkill.config) {
      return this.executeWithSkillExecutor(
        agent, task, abortController, executionId, traceId, rootSpanId,
        tracker, parsedSkill as { config: SkillExecutorConfig; promptContent: string }, toolPolicy, systemPrompt,
      );
    }

    // Prompt build trace
    const promptSpan = createTraceSpan({
      traceId, parentSpanId: rootSpanId, type: 'prompt.build', name: 'Build runtime prompt',
      metadata: { skillPath: agent.skillPath, skillId: runtimeSkill?.skill.id, skillVersionId: runtimeSkill?.version.id,
        skillVersion: runtimeSkill?.version.version, skillChecksum: runtimeSkill?.version.checksum,
        skillSource: runtimeSkill?.source, requestedTools: toolPolicy.requestedTools },
    });
    completeTraceSpan(promptSpan.id, { status: 'done', metadata: { allowedTools: toolPolicy.allowedTools, promptChars: task.input.length, systemPromptChars: systemPrompt.length } });

    // Inject messages before model routing so long-context escalation sees the real prompt size.
    let enrichedInput = task.input;
    try {
      const pendingMsgs = messageBus.drain(executionId);
      if (pendingMsgs.length > 0) {
        const msgContext = pendingMsgs.map(m => `[${m.messageType}] ${m.content}`).join('\n');
        enrichedInput = `${task.input}\n\n## Context from other agents:\n${msgContext}`;
        addTaskLog(task.id, 'info', `Injected ${pendingMsgs.length} message(s) from other agents`, 'system');
      }
    } catch {}

    // Model selection
    const modelSelection = selectModelForAgent(agent, task, { promptText: `${systemPrompt}\n\n${enrichedInput}` });
    const selectedModel = modelSelection.modelId;
    const limits = resolveAgentRuntimeLimits(agent, modelSelection);
    updateExecution(executionId, {
      modelId: selectedModel,
      modelTier: modelSelection.modelTier,
      modelRouteSource: modelSelection.source,
      modelRouteReason: modelSelection.reason,
    });
    recordExecutionPolicySnapshot({
      executionId,
      taskId: task.id,
      agentId: agent.id,
      workspaceId: task.workspaceId,
      policySnapshot: {
        runner: 'ts-agent-loop',
        modelSelection,
        runtimeLimits: limits,
        toolPolicy,
        workspaceScope: { workspaceId: task.workspaceId, workdir: task.workdir },
        dlp: { enabled: true, mode: 'scan-redact-block' },
        sandbox: { enabled: true, guardian: true },
      },
    });
    for (const decision of toolPolicy.decisions.filter(d => !d.allowed)) {
      appendExecutionAuditEvent(executionId, {
        type: 'tool.blocked',
        severity: 'block',
        message: `Tool ${decision.toolId} blocked by policy: ${decision.reason}`,
        metadata: { decision },
      });
    }
    const modelSpan = createTraceSpan({
      traceId, parentSpanId: rootSpanId, type: 'model.route', name: 'Select model',
      metadata: modelSelection as unknown as Record<string, unknown>,
    });
    completeTraceSpan(modelSpan.id, { status: 'done' });

    // LLM call span
    const llmSpan = createTraceSpan({
      traceId, parentSpanId: rootSpanId, type: 'llm.call', name: 'TS Agent Loop',
      metadata: { model: selectedModel, runner: 'ts-agent-loop' },
    });

    try {
      // Build tool definitions for the API
      const { toolDefs, modelNameToToolId } = buildModelToolDefinitions(toolPolicy.allowedTools);

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: enrichedInput },
      ];

      let finalOutput = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let numTurns = 0;
      const maxTurns = agent.maxTurns || agent.config.maxTurns || 50;

      // Check LLM cache for exact-match responses (no-tool calls only)
      const canCache = toolDefs.length === 0;
      if (canCache) {
        const cacheKey = { model: selectedModel, system: systemPrompt, prompt: enrichedInput };
        const cached = llmCache.get(cacheKey);
        if (cached) {
          const safeCachedOutput = sanitizeAgentOutput(cached.output, {
            agentId: agent.id,
            taskId: task.id,
            workspaceId: task.workspaceId,
            executionId,
            purpose: 'cached agent output',
          });
          metrics.cacheHitRate.add(1, { status: 'hit' });
          addTaskLog(task.id, 'info', `Cache hit — skipping LLM call`, 'system');
          completeTraceSpan(llmSpan.id, {
            status: 'done',
            metadata: { inputTokens: cached.inputTokens, outputTokens: cached.outputTokens, numTurns: 1, cached: true },
          });
          const cacheCost = estimateCost(selectedModel, cached.inputTokens, cached.outputTokens);
          recordModelUsage({
            modelId: selectedModel, agentId: agent.id, taskId: task.id,
            executionId, status: 'success',
            inputTokens: cached.inputTokens, outputTokens: cached.outputTokens,
            costUSD: cacheCost, latencyMs: 0, routeReason: modelSelection.reason,
            routeSource: modelSelection.source, modelTier: modelSelection.modelTier,
          });
          return { output: safeCachedOutput, costUSD: cacheCost, inputTokens: cached.inputTokens, outputTokens: cached.outputTokens, durationMs: 0, numTurns: 1, executionId };
        }
        metrics.cacheHitRate.add(1, { status: 'miss' });
      }

      let totalToolCalls = 0;
      let totalToolRuntimeMs = 0;

      while (numTurns < maxTurns) {
        numTurns++;

        const completion = await client.chat.completions.create({
          model: selectedModel,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          max_tokens: remainingResponseTokens(inputTokens, outputTokens, limits),
        }, {
          signal: abortController.signal,
        });

        const choice = completion.choices[0];
        if (!choice) throw new Error('No response from model');

        inputTokens += completion.usage?.prompt_tokens || 0;
        outputTokens += completion.usage?.completion_tokens || 0;
        tracker.latestInputTokens += completion.usage?.prompt_tokens || 0;
        tracker.cumulativeOutputTokens += completion.usage?.completion_tokens || 0;
        assertExecutionTokenBudget(inputTokens, outputTokens, finalOutput, 'TS agent execution', limits);
        if (Date.now() - startTime > limits.maxExecutionWallClockMs) {
          throw new Error(`TS agent execution exceeded wall-clock budget (${limits.maxExecutionWallClockMs}ms)`);
        }

        let assistantMsg = choice.message;

        let text = typeof assistantMsg.content === 'string' ? assistantMsg.content : '';
        if (text) {
          text = sanitizeAgentOutput(text, {
            agentId: agent.id,
            taskId: task.id,
            workspaceId: task.workspaceId,
            executionId,
            purpose: 'agent text',
          });
          assistantMsg = { ...assistantMsg, content: text };
        }
        messages.push(assistantMsg);

        // Handle text content
        if (text) {
          finalOutput = text;
          addExecutionMessage({ executionId, type: 'agent_text', content: text.slice(0, 500) });
          eventBus.emit('execution:message', { executionId, taskId: task.id, workspaceId: task.workspaceId, type: 'agent_text', content: text.slice(0, 500) });
          addTaskLog(task.id, 'info', text.slice(0, 800), agent.id);
        }

        // Handle tool calls
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          for (const tc of assistantMsg.tool_calls) {
            const toolCallId = tc.id;
            const toolName = modelNameToToolId.get(tc.function.name) || tc.function.name;
            let toolInput: Record<string, unknown> = {};
            try {
              toolInput = JSON.parse(tc.function.arguments || '{}');
            } catch {}

            // Validate parameter constraints FIRST
            const constraintViolations = validateToolParams(toolName, toolInput);
            let toolOutput = '';
            let toolStatus: 'done' | 'failed' = 'done';
            const toolStartTime = Date.now();

            if (constraintViolations.length > 0) {
              toolStatus = 'failed';
              toolOutput = constraintViolations.map(v => v.message).join('; ');
              addTaskLog(task.id, 'warn', `Tool ${toolName} blocked by param constraint: ${toolOutput}`, agent.id);
              appendExecutionAuditEvent(executionId, {
                type: 'tool.blocked',
                severity: 'block',
                message: `Tool ${toolName} blocked by parameter constraints`,
                metadata: { toolName, violations: constraintViolations },
              });
              eventBus.emit('tool:blocked', {
                toolId: toolName, taskId: task.id, workspaceId: task.workspaceId, executionId, agentId: agent.id,
                reason: `param_constraint: ${toolOutput}`,
              });
              // Add error tool result to messages and continue
              messages.push({ role: 'tool', tool_call_id: toolCallId, content: toolOutput });
              continue;
            }

            // Record tool execution
            const toolExecId = `ts_${executionId}_${toolCallId}`;
            createToolExecution({
              id: toolExecId, toolId: toolName, taskId: task.id,
              executionId, agentId: agent.id, input: toolInput, startedAt: new Date().toISOString(),
            });
            tracker.toolUseCount++;

            const activity: ToolActivity = {
              toolName,
              input: toolInput,
              activityDescription: `Using ${toolName}`,
              isSearch: toolName.includes('search'),
              isRead: toolName.includes('fetch') || toolName.includes('crawler'),
              timestamp: new Date().toISOString(),
            };
            tracker.recentActivities.push(activity);
            tracker.recentActivities = tracker.recentActivities.slice(-MAX_RECENT_ACTIVITIES);

            updateExecution(executionId, { progress: getProgressSnapshot(tracker, `Using ${toolName}`) });

            const spanId = `span_${toolExecId}`;
            createTraceSpan({
              id: spanId, traceId, parentSpanId: rootSpanId, type: 'tool.call',
              name: toolName,
              metadata: { toolExecutionId: toolExecId, inputSummary: summarizeToolPayload(toolInput) },
            });

            addExecutionMessage({ executionId, type: 'tool_use', content: summarizeToolPayload(toolInput), toolName });
            eventBus.emit('tool:started', { toolExecutionId: toolExecId, toolId: toolName, taskId: task.id, workspaceId: task.workspaceId, executionId, agentId: agent.id, inputSummary: summarizeToolPayload(toolInput) });
            eventBus.emit('execution:progress', { executionId, taskId: task.id, agentDefId: agent.id, workspaceId: task.workspaceId, progress: getProgressSnapshot(tracker) });

            try {
              if (totalToolCalls >= limits.maxToolCallsPerExecution) {
                throw new Error(`Tool call limit exceeded (${limits.maxToolCallsPerExecution})`);
              }
              if (totalToolRuntimeMs >= limits.maxToolRuntimeMsPerExecution) {
                throw new Error(`Tool runtime budget exceeded (${limits.maxToolRuntimeMsPerExecution}ms)`);
              }
              totalToolCalls++;
              const result = await executeTool(toolName, toolInput, task.workdir || process.cwd(), {
                allowedTools: toolPolicy.allowedTools,
                timeoutMs: Math.min(limits.maxToolCallTimeoutMs, limits.maxToolRuntimeMsPerExecution - totalToolRuntimeMs),
                maxOutputChars: Math.min(limits.maxOutputChars, 8_000),
              });
              toolOutput = sanitizeAgentOutput(result.output, {
                agentId: agent.id,
                taskId: task.id,
                workspaceId: task.workspaceId,
                executionId,
                purpose: `tool ${toolName} result`,
              });
              toolStatus = result.status;
            } catch (err: any) {
              toolOutput = err.message || 'Tool execution failed';
              toolStatus = 'failed';
            }

            const durationMs = Date.now() - toolStartTime;
            totalToolRuntimeMs += durationMs;
            if (toolStatus === 'failed') {
              appendExecutionAuditEvent(executionId, {
                type: 'tool.failed',
                severity: String(toolOutput).includes('blocked') || String(toolOutput).includes('guardian') ? 'block' : 'warn',
                message: `Tool ${toolName} failed`,
                metadata: { toolName, output: String(toolOutput).slice(0, 500), durationMs },
              });
            }

            completeToolExecution(toolExecId, {
              status: toolStatus, output: toolOutput,
              outputSummary: String(toolOutput).slice(0, 200),
              error: toolStatus === 'failed' ? toolOutput : undefined,
              durationMs, completedAt: new Date().toISOString(),
            });
            completeTraceSpan(spanId, { status: toolStatus, metadata: { outputSummary: String(toolOutput).slice(0, 200), durationMs }, error: toolStatus === 'failed' ? toolOutput : undefined, durationMs });

            addExecutionMessage({ executionId, type: 'tool_result', content: String(toolOutput).slice(0, 500), toolName });
            eventBus.emit(toolStatus === 'failed' ? 'tool:failed' : 'tool:done', {
              toolExecutionId: toolExecId, toolId: toolName, taskId: task.id,
              workspaceId: task.workspaceId,
              executionId, agentId: agent.id, status: toolStatus, error: toolStatus === 'failed' ? toolOutput : undefined,
              durationMs, outputSummary: String(toolOutput).slice(0, 200),
            });

            messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: toolOutput,
            });
          }
        } else {
          // No tool calls — we're done
          break;
        }
      }

      const durationMs = Date.now() - startTime;
      finalOutput = sanitizeAgentOutput(finalOutput, {
        agentId: agent.id,
        taskId: task.id,
        workspaceId: task.workspaceId,
        executionId,
        purpose: 'final task output',
      });
      assertExecutionTokenBudget(inputTokens, outputTokens, finalOutput, 'TS agent execution', limits);

      // Cache the result for future identical calls
      if (canCache && finalOutput) {
        llmCache.set(
          { model: selectedModel, system: systemPrompt, prompt: enrichedInput },
          { output: finalOutput, inputTokens, outputTokens },
        );
      }

      completeTraceSpan(llmSpan.id, {
        status: 'done',
        metadata: { inputTokens, outputTokens, numTurns, durationMs, cached: false },
      });

      const costUSD = estimateCost(selectedModel, inputTokens, outputTokens);
      recordModelUsage({
        modelId: selectedModel, agentId: agent.id, taskId: task.id,
        executionId, status: 'success',
        inputTokens, outputTokens,
        costUSD,
        latencyMs: durationMs,
        routeReason: modelSelection.reason,
        routeSource: modelSelection.source,
        modelTier: modelSelection.modelTier,
      });

      return { output: finalOutput, costUSD, inputTokens, outputTokens, durationMs, numTurns, executionId };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      completeTraceSpan(llmSpan.id, { status: 'failed', error: err.message, metadata: { durationMs } });
      recordModelUsage({
        modelId: selectedModel, agentId: agent.id, taskId: task.id,
        executionId, status: 'failed', latencyMs: durationMs,
        routeReason: modelSelection.reason,
        routeSource: modelSelection.source,
        modelTier: modelSelection.modelTier,
      });
      throw err;
    }
  }

  private async executeWithSkillExecutor(
    agent: AgentDefinition,
    task: Task,
    abortController: AbortController,
    executionId: string,
    traceId: string,
    rootSpanId: string,
    tracker: ProgressTracker,
    parsedSkill: { config: SkillExecutorConfig; promptContent: string },
    toolPolicy: ReturnType<typeof resolveAllowedToolsForAgent>,
    systemPrompt: string,
  ): Promise<TaskResult> {
    const startTime = Date.now();
    const client = this.getClient();
    const modelSelection = selectModelForAgent(agent, task, {
      promptText: `${systemPrompt}\n\n${parsedSkill.promptContent}\n\n${task.input}`,
    });
    const selectedModel = modelSelection.modelId;
    const limits = resolveAgentRuntimeLimits(agent, modelSelection);
    updateExecution(executionId, {
      modelId: selectedModel,
      modelTier: modelSelection.modelTier,
      modelRouteSource: modelSelection.source,
      modelRouteReason: modelSelection.reason,
    });
    recordExecutionPolicySnapshot({
      executionId,
      taskId: task.id,
      agentId: agent.id,
      workspaceId: task.workspaceId,
      policySnapshot: {
        runner: 'skill-executor',
        modelSelection,
        runtimeLimits: limits,
        toolPolicy,
        workspaceScope: { workspaceId: task.workspaceId, workdir: task.workdir },
        dlp: { enabled: true, mode: 'scan-redact-block' },
        sandbox: { enabled: true, guardian: true },
      },
    });
    let inputTokens = 0;
    let outputTokens = 0;
    let executionToolCalls = 0;
    let executionToolRuntimeMs = 0;

    addTaskLog(task.id, 'info', `Skill Executor: ${parsedSkill.config.steps.length} steps`, 'system');

    // Build tool definitions for function calling
    const skillToolIds = parsedSkill.config.steps.flatMap(step => step.tools || []);
    const runtimeToolIds = Array.from(new Set([
      ...toolPolicy.allowedTools,
      ...skillToolIds.filter(toolId => isSandboxTool(toolId)),
    ]));
    const { toolDefs: allToolDefs, modelNameToToolId } = buildModelToolDefinitions(runtimeToolIds);
    const workdir = task.workdir || process.cwd();

    // Multi-turn LLM call with tool-use support
    const llmCall = async (
      stepSystemPrompt: string,
      userPrompt: string,
      allowedTools?: string[],
      llmOptions?: { maxTurns?: number; stepName?: string },
    ): Promise<string> => {
      if (abortController.signal.aborted) throw new Error('Execution aborted');

      // Filter tools to only those allowed for this step
      const stepAllowedTools = allowedTools?.filter(toolId => runtimeToolIds.includes(toolId)) || [];
      const stepToolDefs = stepAllowedTools.length > 0
        ? allToolDefs.filter(t => stepAllowedTools.includes(modelNameToToolId.get(t.function.name) || t.function.name))
        : [];

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: stepSystemPrompt },
        { role: 'user', content: userPrompt },
      ];

      let finalOutput = '';
      const maxTurns = llmOptions?.maxTurns ?? 20; // per-step max turns
      let stepToolRuntimeMs = 0;

      for (let turn = 0; turn < maxTurns; turn++) {
        if (abortController.signal.aborted) throw new Error('Execution aborted');

        const completion = await client.chat.completions.create({
          model: selectedModel,
          messages,
          tools: stepToolDefs.length > 0 ? stepToolDefs : undefined,
          max_tokens: remainingResponseTokens(inputTokens, outputTokens, limits),
        });

        const choice = completion.choices[0];
        if (!choice) break;

        const promptTokens = completion.usage?.prompt_tokens || 0;
        const completionTokens = completion.usage?.completion_tokens || 0;
        inputTokens += promptTokens;
        outputTokens += completionTokens;
        tracker.cumulativeOutputTokens += completionTokens;
        tracker.latestInputTokens = promptTokens;
        assertExecutionTokenBudget(inputTokens, outputTokens, finalOutput, 'skill executor', limits);
        if (Date.now() - startTime > limits.maxExecutionWallClockMs) {
          throw new Error(`Skill executor exceeded wall-clock budget (${limits.maxExecutionWallClockMs}ms)`);
        }

        let assistantMsg = choice.message;
        let text = typeof assistantMsg.content === 'string' ? assistantMsg.content : '';
        if (text) {
          text = sanitizeAgentOutput(text, {
            agentId: agent.id,
            taskId: task.id,
            workspaceId: task.workspaceId,
            executionId,
            purpose: `skill step ${llmOptions?.stepName || 'unknown'} output`,
          });
          assistantMsg = { ...assistantMsg, content: text };
        }
        messages.push(assistantMsg);

        // Capture text output
        if (text) {
          finalOutput = text;
        }

        // Handle tool calls
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          for (const tc of assistantMsg.tool_calls) {
            const toolName = modelNameToToolId.get(tc.function.name) || tc.function.name;
            let toolInput: Record<string, unknown> = {};
            try { toolInput = JSON.parse(tc.function.arguments || '{}'); } catch {}

            // Log tool use
            addTaskLog(task.id, 'info', `  🔧 ${toolName}(${JSON.stringify(toolInput).slice(0, 100)})`, agent.id);
            tracker.toolUseCount++;

            // Execute tool
            if (executionToolCalls >= limits.maxToolCallsPerExecution) {
              throw new Error(`Tool call limit exceeded (${limits.maxToolCallsPerExecution})`);
            }
            if (stepToolRuntimeMs >= limits.maxToolRuntimeMsPerStep) {
              throw new Error(`Step tool runtime budget exceeded (${limits.maxToolRuntimeMsPerStep}ms)`);
            }
            if (executionToolRuntimeMs >= limits.maxToolRuntimeMsPerExecution) {
              throw new Error(`Execution tool runtime budget exceeded (${limits.maxToolRuntimeMsPerExecution}ms)`);
            }
            executionToolCalls++;
            const remainingToolBudgetMs = Math.min(
              limits.maxToolCallTimeoutMs,
              limits.maxToolRuntimeMsPerStep - stepToolRuntimeMs,
              limits.maxToolRuntimeMsPerExecution - executionToolRuntimeMs,
            );
            const toolStartedAt = Date.now();
            const result = await executeTool(toolName, toolInput, workdir, {
              allowedTools: stepAllowedTools,
              timeoutMs: remainingToolBudgetMs,
              maxOutputChars: Math.min(limits.maxOutputChars, 8_000),
            });
            const toolElapsedMs = Date.now() - toolStartedAt;
            stepToolRuntimeMs += toolElapsedMs;
            executionToolRuntimeMs += toolElapsedMs;
            const safeToolOutput = sanitizeAgentOutput(result.output, {
              agentId: agent.id,
              taskId: task.id,
              workspaceId: task.workspaceId,
              executionId,
              purpose: `tool ${toolName} result`,
            });

            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: safeToolOutput,
            });
          }
        } else {
          // No tool calls — step complete
          break;
        }
      }

      return finalOutput;
    };

    const executor = new SkillExecutor({
      config: parsedSkill.config,
      promptContent: parsedSkill.promptContent || systemPrompt,
      workdir: task.workdir || process.cwd(),
      llmCall,
      abortSignal: abortController.signal,
      onStepStart: (idx, step) => {
        createTraceSpan({
          traceId, parentSpanId: rootSpanId,
          type: 'skill.step', name: `Step: ${step.name}`,
          metadata: { stepIndex: idx, instruction: step.instruction.slice(0, 200) },
        });
        addTaskLog(task.id, 'info', `▶ Step ${idx + 1}/${parsedSkill.config.steps.length}: ${step.name}`, agent.id);
        addExecutionMessage({ executionId, type: 'progress', content: `Starting step: ${step.name}` });
        eventBus.emit('execution:progress', {
          executionId, taskId: task.id, agentDefId: agent.id, workspaceId: task.workspaceId,
          progress: getProgressSnapshot(tracker, `Step: ${step.name}`),
        });
      },
      onStepDone: (idx, step, output) => {
        addTaskLog(task.id, 'info', `✓ Step "${step.name}" done`, agent.id);
        addExecutionMessage({ executionId, type: 'agent_text', content: output.slice(0, 500) });
      },
      onStepFailed: (idx, step, error) => {
        addTaskLog(task.id, 'warn', `✗ Step "${step.name}" failed: ${error}`, agent.id);
      },
    });

    const result = await executor.run(task.input);

    const durationMs = Date.now() - startTime;
    const costUSD = estimateCost(selectedModel, inputTokens, outputTokens);
    const safeFinalOutput = result.success
      ? sanitizeAgentOutput(result.finalOutput, {
          agentId: agent.id,
          taskId: task.id,
          workspaceId: task.workspaceId,
          executionId,
          purpose: 'final task output',
        })
      : result.finalOutput;
    assertExecutionTokenBudget(inputTokens, outputTokens, safeFinalOutput, 'skill executor', limits);

    recordModelUsage({
      modelId: selectedModel,
      agentId: agent.id,
      taskId: task.id,
      executionId,
      status: result.success ? 'success' : 'failed',
      inputTokens,
      outputTokens,
      costUSD,
      latencyMs: durationMs,
      routeReason: `skill-executor: ${parsedSkill.config.steps.length} steps`,
      routeSource: modelSelection.source,
      modelTier: modelSelection.modelTier,
    });

    if (!result.success) {
      const failedStep = result.steps.find(s => s.status === 'failed');
      throw new Error(`Skill execution failed at step "${failedStep?.name}": ${failedStep?.error}`);
    }

    return {
      output: safeFinalOutput,
      costUSD,
      inputTokens,
      outputTokens,
      durationMs,
      numTurns: result.steps.length,
      executionId,
    };
  }
}

export const tsAgentLoop = new TsAgentLoop();
