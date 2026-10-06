import OpenAI from 'openai';
import type { AgentDefinition, ModelCostType, Task, AgentProgress, ToolActivity, ProgressTracker } from '../types.js';
import { eventBus } from '../events/event-bus.js';
import { updateTask, addTaskLog, getTask } from '../db/models/task.js';
import { getPipeline } from '../db/models/pipeline.js';
import { updateExecution, addExecutionMessage, getExecution } from '../db/models/execution.js';
import { completeTraceSpan, createTraceSpan } from '../db/models/trace.js';
import { resolveAllowedToolsForAgent, validateToolParams } from '../tools/tool-policy.js';
import { createToolExecution, completeToolExecution, summarizeToolPayload } from '../tools/tool-execution.js';
import { estimateModelCost, recordModelUsage, selectModelForAgent } from '../models/model-registry.js';
import { getModelGateway } from '../models/gateway.js';
import { messageBus } from './message-bus.js';
import type { SkillDefinition, SkillVersion, SkillExecutorConfig } from '../types.js';
import { parseSkillContent } from '../skills/skill-parser.js';
import { SkillExecutor } from '../skills/skill-executor.js';
import { llmCache } from '../cache/llm-cache.js';
import { metrics } from '../observability/telemetry.js';
import { assertExecutionTokenBudget, remainingResponseTokens, resolveAgentRuntimeLimits } from './runtime-limits.js';
import { compactMessages } from './context-compactor.js';
import { loadExecutionContext, persistExecutionContext } from './execution-context.js';
import { archiveContextSummary, archiveLongToolOutput } from './tool-output-artifact.js';
import { sanitizeAgentOutput } from '../security/dlp-runtime.js';
import { buildSandboxToolDefinition, executeTool, isSandboxTool } from '../skills/tool-sandbox.js';
import {
  GOVERNED_PUBLISH_MCP_TOOLS,
  isMcpTool,
  type McpCallPolicyContext,
} from '../tools/mcp-manager.js';
import { getMcpToolDefinitions, executeMcpTool } from '../tools/mcp-tools.js';
import { appendExecutionAuditEvent, recordExecutionPolicySnapshot } from '../audit/execution-audit.js';
import { recordLedgerEntry } from '../db/models/execution-ledger.js';
import { resolveDomainForTask, applyDomainOverlay, applyDomainKnowledge } from './domain-context.js';
import { buildAgentSystemPrompt, usesResearchAnswerContract } from './agent-prompt.js';
import { getSandboxProfile } from './sandbox-profile.js';
import type { ExecutionMiddlewareChain } from './execution-middleware.js';
import { ResearchBudget } from './research-budget.js';
import { isResearchTool, recoveredResearchContext, saveResearchEvidence } from './research-evidence.js';
import { AgentRunStopped, updateAgentRun } from './run-state.js';
import { loopFingerprint, readLoopCheckpoint, saveLoopCheckpoint, sealLoopCheckpoint } from './loop-checkpoint.js';
import { runWriteOnce } from '../tools/write-once.js';
import { requestedAgentInput } from './completion-control.js';
import { isSimpleConversation } from './conversation-intent.js';

const MAX_RECENT_ACTIVITIES = 5;

function recordContextUsage(task: Task, estimatedInputTokens: number, maxInputTokens: number, reservedOutputTokens: number, summaryVersion?: number) {
  const usableTokens = Math.max(1, maxInputTokens - reservedOutputTokens);
  const previous = loadExecutionContext(task).contextUsage;
  persistExecutionContext(task, {
    contextUsage: {
      estimatedInputTokens,
      maxInputTokens,
      reservedOutputTokens,
      occupancyPercent: Math.min(100, Math.round((estimatedInputTokens / usableTokens) * 100)),
      ...(summaryVersion !== undefined ? { summaryVersion } : previous?.summaryVersion !== undefined ? { summaryVersion: previous.summaryVersion } : {}),
      updatedAt: new Date().toISOString(),
    },
  });
}

function modelRequestTuning(task: Task): Record<string, string> {
  return task.reasoningEffort ? { reasoning_effort: task.reasoningEffort } : {};
}

export function buildMcpPolicyContext(agent: AgentDefinition, task: Task): McpCallPolicyContext {
  const persistedTask = getTask(task.id);
  const sourceTask = persistedTask || task;
  const context: McpCallPolicyContext = {
    agentId: agent.id,
    taskMode: sourceTask.mode,
    pipelineId: sourceTask.pipelineId,
    stageIndex: sourceTask.stageIndex,
    taskId: sourceTask.id,
    taskInput: sourceTask.input,
    workdir: sourceTask.workdir,
  };
  if (
    !persistedTask
    || persistedTask.status !== 'running'
    || agent.id !== 'social-publisher'
    || sourceTask.mode !== 'pipeline'
    || !sourceTask.pipelineId
    || sourceTask.stageIndex === undefined
    || sourceTask.retryCount > 0
  ) {
    return context;
  }

  const pipeline = getPipeline(sourceTask.pipelineId);
  const stage = pipeline?.stages[sourceTask.stageIndex];
  if (
    !pipeline
    || pipeline.status !== 'running'
    || pipeline.currentStageIndex !== sourceTask.stageIndex
    || stage?.status !== 'running'
    || stage.taskId !== sourceTask.id
    || sourceTask.assigneeId !== agent.id
  ) {
    return context;
  }

  const agentTools = new Set(agent.allowedTools || agent.config.allowedTools || []);
  const approvedPublishTools = (stage.publishTools || []).filter(tool =>
    agentTools.has(tool)
    && GOVERNED_PUBLISH_MCP_TOOLS.some(governedTool => governedTool === tool)
  );
  if (approvedPublishTools.length === 0) return context;

  const dependencyIndices = stage.dependsOn ?? (sourceTask.stageIndex > 0 ? [sourceTask.stageIndex - 1] : []);
  return {
    ...context,
    publishAuthorized: true,
    approvedPublishTools,
    publishAuthorizationId: sourceTask.id,
    approvedDraftTaskIds: dependencyIndices
      .map(index => pipeline.stages[index]?.taskId)
      .filter((taskId): taskId is string => Boolean(taskId)),
  };
}

function buildModelToolName(toolId: string, index: number): string {
  const safeName = toolId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return `tool_${index}_${safeName}`;
}

/**
 * Extract assistant text whether the gateway returns `content` as a plain
 * string, as an array of content blocks (some providers do this when text and
 * tool calls are mixed), or `null`.
 */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : (part as any)?.text ?? ''))
      .join('');
  }
  return '';
}

function buildModelToolDefinitions(toolIds: string[]) {
  const modelNameToToolId = new Map<string, string>();
  const sandboxToolIds = toolIds.filter(toolId => !isMcpTool(toolId));
  const toolDefs = sandboxToolIds.map((toolId, index) => {
    const modelToolName = buildModelToolName(toolId, index);
    modelNameToToolId.set(modelToolName, toolId);
    return buildSandboxToolDefinition(toolId, modelToolName);
  }) as any[];

  const allowedMcpTools = new Set(toolIds.filter(isMcpTool));
  const { defs: mcpDefs, nameToQualified } = getMcpToolDefinitions(allowedMcpTools);
  for (const [modelName, qualified] of nameToQualified) modelNameToToolId.set(modelName, qualified);
  toolDefs.push(...(mcpDefs as any[]));

  return { toolDefs, modelNameToToolId };
}

export interface TaskResult {
  stopReason?: import('@myrmecia/shared').AgentStopReason;
  output: string;
  costUSD: number | null;
  costType: ModelCostType;
  provider: string;
  actualModelId?: string;
  aiUnits: number;
  billingMultiplier?: number;
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

interface ProviderUsage {
  provider: string;
  actualModelId?: string;
  aiUnits: number;
  billingMultiplier?: number;
  costType: ModelCostType;
}

function createProviderUsage(model: string): ProviderUsage {
  const provider = getModelGateway().providerFor(model);
  return {
    provider,
    aiUnits: 0,
    costType: provider === 'copilot' ? 'subscription' : 'estimated',
  };
}

function mergeProviderUsage(usage: ProviderUsage, completionUsage: any): void {
  if (!completionUsage) return;
  usage.provider = completionUsage.provider || usage.provider;
  usage.actualModelId = completionUsage.actual_model_id || usage.actualModelId;
  usage.aiUnits += Number(completionUsage.ai_units) || 0;
  if (typeof completionUsage.billing_multiplier === 'number') {
    usage.billingMultiplier = completionUsage.billing_multiplier;
  }
  if (completionUsage.cost_type) usage.costType = completionUsage.cost_type;
}

function providerCostUSD(model: string, inputTokens: number, outputTokens: number, usage: ProviderUsage): number | null {
  if (usage.costType === 'subscription' || usage.costType === 'unavailable') return null;
  return estimateCost(model, inputTokens, outputTokens);
}

export class TsAgentLoop {
  async execute(
    agent: AgentDefinition,
    task: Task,
    abortController: AbortController,
    executionId: string,
    traceId: string,
    rootSpanId: string,
    tracker: ProgressTracker,
    runtimeSkill?: { skill: SkillDefinition; version: SkillVersion; source: 'assignment' | 'skillPath' },
    middleware?: ExecutionMiddlewareChain,
  ): Promise<TaskResult> {
    const startTime = Date.now();
    const conversationOnly = isSimpleConversation(task);
    const resolvedPolicy = resolveAllowedToolsForAgent(agent);
    // Small talk has no authority to run tools, and needs no extra LLM skill
    // matching request. Pipeline/compound implementation work keeps its gates.
    const toolPolicy = conversationOnly
      ? { ...resolvedPolicy, allowedTools: [], decisions: [] }
      : resolvedPolicy;

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

    const baseSystemPrompt = buildAgentSystemPrompt(agent, toolPolicy.allowedTools, runtimeSkill?.version.content, task);

    // Domain Pack overlay: prepend domain persona/guidelines/disclaimer if this
    // task (or the agent) is bound to a domain.
    const domain = resolveDomainForTask(agent, task);
    const systemPrompt = applyDomainOverlay(baseSystemPrompt, domain);
    if (domain) addTaskLog(task.id, 'info', `Domain Pack applied: ${domain.emoji} ${domain.name}`, 'system');

    // Check if the resolved skill is structured (step-driven)
    const researchAnswer = usesResearchAnswerContract(agent, task);
    let parsedSkill = runtimeSkill && !researchAnswer && !conversationOnly
      ? parseSkillContent(runtimeSkill.version.content)
      : null;

    // If no structured skill resolved, try LLM matching
    if (!parsedSkill?.isStructured && !researchAnswer && !conversationOnly) {
      try {
        const { matchSkillForTask } = await import('../skills/skill-matcher.js');
        const { getLatestPublishedSkillVersion } = await import('../db/models/skill.js');
        const match = await matchSkillForTask(task.input, agent.role, abortController.signal);
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

    const usesCopilot = process.env.MYRMECIA_MODEL_PROVIDER?.trim().toLowerCase() === 'copilot';
    if (parsedSkill?.isStructured && parsedSkill.config && !usesCopilot) {
      return this.executeWithSkillExecutor(
        agent, task, abortController, executionId, traceId, rootSpanId,
        tracker, parsedSkill as { config: SkillExecutorConfig; promptContent: string }, toolPolicy, systemPrompt, middleware,
      );
    }
    if (parsedSkill?.isStructured && usesCopilot) {
      addTaskLog(
        task.id,
        'info',
        'Copilot provider is executing the structured skill through the governed agent loop.',
        'system',
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
    enrichedInput += recoveredResearchContext(task, executionId, toolPolicy.allowedTools);
    // Domain knowledge: retrieve and prepend the domain's knowledge-base chunks.
    if (domain && !conversationOnly) {
      try {
        const withKnowledge = await applyDomainKnowledge(enrichedInput, domain, task.workspaceId);
        if (withKnowledge !== enrichedInput) {
          enrichedInput = withKnowledge;
          addTaskLog(task.id, 'info', `Injected domain knowledge from "${domain.name}"`, 'system');
        }
      } catch { /* non-critical */ }
    }
    try {
      const pendingMsgs = messageBus.drain(executionId);
      if (pendingMsgs.length > 0) {
        const msgContext = pendingMsgs.map(m => `[${m.messageType}] ${m.content}`).join('\n');
        enrichedInput = `${enrichedInput}\n\n## Context from other agents:\n${msgContext}`;
        addTaskLog(task.id, 'info', `Injected ${pendingMsgs.length} message(s) from other agents`, 'system');
      }
    } catch {}

    // Model selection
    const modelSelection = selectModelForAgent(agent, task, { promptText: `${systemPrompt}\n\n${enrichedInput}` });
    const selectedModel = modelSelection.modelId;
    const providerUsage = createProviderUsage(selectedModel);
    const limits = resolveAgentRuntimeLimits(agent, modelSelection, task.contextLength);
    const fingerprint = loopFingerprint({
      agentId: agent.id, modelId: selectedModel, systemPrompt, input: task.input,
      tools: toolPolicy.allowedTools, workdir: task.workdir, skillChecksum: runtimeSkill?.version.checksum,
    });
    const resumed = readLoopCheckpoint(task, fingerprint, executionId);
    const elapsedBeforeResume = resumed?.snapshot.elapsedMs || 0;
    const executionDeadline = startTime + Math.max(1, Math.min(limits.maxExecutionWallClockMs, 600_000) - elapsedBeforeResume);
    const researchBudget = new ResearchBudget(executionDeadline, task.retryCount > 0 ? 2 : 3);
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
        sandbox: { enabled: true, guardian: true, profile: getSandboxProfile() },
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
    recordLedgerEntry({
      executionId, taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId,
      type: 'model.selected', decision: selectedModel,
      summary: `Model ${selectedModel} via ${modelSelection.source} (${modelSelection.reason})`,
      metadata: {
        modelId: selectedModel,
        tier: modelSelection.modelTier,
        source: modelSelection.source,
        reason: modelSelection.reason,
      },
    });
    recordLedgerEntry({
      executionId, taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId,
      type: 'tool.policy', decision: `${toolPolicy.allowedTools.length} allowed`,
      summary: `Tool policy resolved: ${toolPolicy.allowedTools.length} allowed, ${toolPolicy.decisions.filter(d => !d.allowed).length} blocked`,
      metadata: {
        allowed: toolPolicy.allowedTools,
        blocked: toolPolicy.decisions.filter(d => !d.allowed).map(d => ({ toolId: d.toolId, reason: d.reason })),
      },
    });
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
      // The Copilot adapter exposes these as SDK custom tools but routes every
      // invocation back into this TS loop. OpenAI-compatible providers retain
      // their existing function-call path below.
      const { toolDefs, modelNameToToolId } = buildModelToolDefinitions(toolPolicy.allowedTools);
      const researchFailures = new Set<string>();
      if (researchAnswer && toolPolicy.allowedTools.some(isResearchTool)
        && ![...modelNameToToolId.values()].some(isResearchTool)) researchFailures.add('unavailable_research_tools');

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = resumed?.snapshot.messages || [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: enrichedInput },
      ];

      let finalOutput = resumed?.snapshot.finalOutput || '';
      let inputTokens = resumed?.snapshot.inputTokens || 0;
      let outputTokens = resumed?.snapshot.outputTokens || 0;
      let numTurns = resumed?.snapshot.turn || 0;
      tracker.toolUseCount = resumed?.snapshot.toolCallCount || tracker.toolUseCount;
      if (resumed) {
        updateAgentRun(executionId, 'deciding', { turn: numTurns, toolCallCount: tracker.toolUseCount, resumedFromExecutionId: resumed.executionId });
        addTaskLog(task.id, 'info', `Resumed a read-only TS loop from ${resumed.executionId}; prior budget usage was retained`, 'recovery');
      }
      let completedNormally = false;
      let needsInput = false;
      const maxTurns = agent.maxTurns || agent.config.maxTurns || 50;

      // Check LLM cache for exact-match responses (no-tool calls only)
      const canCache = toolDefs.length === 0 && !resumed && researchFailures.size === 0;
      if (canCache) {
        const cacheKey = { workspaceId: task.workspaceId, model: selectedModel, system: systemPrompt, prompt: enrichedInput };
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
          const cacheCost = providerCostUSD(selectedModel, cached.inputTokens, cached.outputTokens, providerUsage);
          recordModelUsage({
            modelId: selectedModel, agentId: agent.id, taskId: task.id,
            executionId, status: 'success',
            inputTokens: 0, outputTokens: 0,
            costUSD: cacheCost, latencyMs: 0, routeReason: modelSelection.reason,
            routeSource: modelSelection.source, modelTier: modelSelection.modelTier,
            provider: providerUsage.provider, costType: providerUsage.costType,
          });
          return {
            output: safeCachedOutput,
            costUSD: cacheCost,
            costType: providerUsage.costType,
            provider: providerUsage.provider,
            aiUnits: 0,
            inputTokens: cached.inputTokens,
            outputTokens: cached.outputTokens,
            durationMs: 0,
            numTurns: 1,
            executionId,
          };
        }
        metrics.cacheHitRate.add(1, { status: 'miss' });
      }

      let totalToolCalls = resumed?.snapshot.toolCallCount || 0;
      let totalToolRuntimeMs = resumed?.snapshot.toolRuntimeMs || 0;
      const checkpoint = (reservedInput = 0, reservedOutput = 0) => saveLoopCheckpoint(task, executionId, fingerprint, {
        schemaVersion: 1, messages, turn: numTurns, finalOutput,
        inputTokens: inputTokens + reservedInput, outputTokens: outputTokens + reservedOutput,
        toolCallCount: totalToolCalls, toolRuntimeMs: totalToolRuntimeMs,
        elapsedMs: elapsedBeforeResume + Date.now() - startTime,
      });
      const reportXiaohongshuProgress = (event: { message: string; elapsedMs: number }) => {
        const message = `小红书 · ${event.message} · ${(event.elapsedMs / 1000).toFixed(1)}s`;
        addTaskLog(task.id, 'info', message, agent.id);
        const progress = getProgressSnapshot(tracker, message);
        updateExecution(executionId, { progress });
        eventBus.emit('execution:progress', {
          executionId, taskId: task.id, agentDefId: agent.id,
          workspaceId: task.workspaceId, progress,
        });
      };
      const executeCopilotToolCall = async (tc: { id: string; function: { name: string; arguments: string }; signal?: AbortSignal }): Promise<string> => {
        if (tc.signal?.aborted || abortController.signal.aborted) throw new Error('Request aborted');
        const toolName = modelNameToToolId.get(tc.function.name) || tc.function.name;
        const mcpTool = isMcpTool(toolName);
        let toolInput: Record<string, unknown> = {};
        try { toolInput = JSON.parse(tc.function.arguments || '{}'); } catch {}

        if (!toolPolicy.allowedTools.includes(toolName)) {
          const output = `Tool ${toolName} is not allowed for agent ${agent.id}`;
          addTaskLog(task.id, 'warn', output, agent.id);
          appendExecutionAuditEvent(executionId, {
            type: 'tool.blocked',
            severity: 'block',
            message: output,
            metadata: { toolName, reason: 'not_in_agent_allowlist' },
          });
          eventBus.emit('tool:blocked', {
            toolId: toolName, taskId: task.id, workspaceId: task.workspaceId, executionId, agentId: agent.id,
            reason: 'not_in_agent_allowlist',
          });
          return output;
        }

        const violations = mcpTool ? [] : validateToolParams(toolName, toolInput);
        if (violations.length > 0) {
          const output = violations.map(violation => violation.message).join('; ');
          addTaskLog(task.id, 'warn', `Tool ${toolName} blocked by param constraint: ${output}`, agent.id);
          appendExecutionAuditEvent(executionId, {
            type: 'tool.blocked',
            severity: 'block',
            message: `Tool ${toolName} blocked by parameter constraints`,
            metadata: { toolName, violations },
          });
          eventBus.emit('tool:blocked', {
            toolId: toolName, taskId: task.id, workspaceId: task.workspaceId, executionId, agentId: agent.id,
            reason: `param_constraint: ${output}`,
          });
          return output;
        }
        const workdir = task.workdir || process.cwd();
        const middlewareDecision = middleware?.beforeToolCall(toolName, toolInput, workdir);
        if (middlewareDecision && !middlewareDecision.allowed) {
          const output = middlewareDecision.reason || `Tool ${toolName} blocked by execution middleware`;
          addTaskLog(task.id, 'warn', output, 'middleware');
          eventBus.emit('tool:blocked', {
            toolId: toolName, taskId: task.id, workspaceId: task.workspaceId, executionId, agentId: agent.id,
            reason: output,
          });
          return output;
        }

        if (totalToolCalls >= limits.maxToolCallsPerExecution) {
          throw new Error(`Tool call limit exceeded (${limits.maxToolCallsPerExecution})`);
        }
        if (totalToolRuntimeMs >= limits.maxToolRuntimeMsPerExecution) {
          throw new Error(`Tool runtime budget exceeded (${limits.maxToolRuntimeMsPerExecution}ms)`);
        }
        totalToolCalls++;
        tracker.toolUseCount++;
        updateAgentRun(executionId, 'acting', { toolCallCount: tracker.toolUseCount });
        const startedAt = Date.now();
        const toolExecId = `ts_${executionId}_${tc.id}`;
        if (!mcpTool) {
          createToolExecution({
            id: toolExecId, toolId: toolName, taskId: task.id,
            executionId, agentId: agent.id, input: toolInput, startedAt: new Date().toISOString(),
          });
        }
        addExecutionMessage({ executionId, type: 'tool_use', content: summarizeToolPayload(toolInput), toolName });
        eventBus.emit('tool:started', {
          toolExecutionId: toolExecId, toolId: toolName, taskId: task.id, workspaceId: task.workspaceId,
          executionId, agentId: agent.id, inputSummary: summarizeToolPayload(toolInput),
        });
        updateTask(task.id, { status: 'waiting_for_tool' });

        let output = '';
        let status: 'done' | 'failed' = 'done';
        let diagnostics: Record<string, unknown> | undefined;
        try {
          const result = await runWriteOnce(task, executionId, toolName, toolInput, async () => isMcpTool(toolName)
            ? await executeMcpTool(
                toolName,
                toolInput,
                Math.min(limits.maxToolCallTimeoutMs, limits.maxToolRuntimeMsPerExecution - totalToolRuntimeMs),
                buildMcpPolicyContext(agent, task),
                reportXiaohongshuProgress,
                abortController.signal,
              )
            : await executeTool(toolName, toolInput, workdir, {
                signal: abortController.signal,
                allowedTools: toolPolicy.allowedTools,
                workspaceId: task.workspaceId,
                timeoutMs: Math.min(limits.maxToolCallTimeoutMs, limits.maxToolRuntimeMsPerExecution - totalToolRuntimeMs),
                maxOutputChars: Math.min(limits.maxOutputChars, 8_000),
              }));
          output = sanitizeAgentOutput(result.output, {
            agentId: agent.id, taskId: task.id, workspaceId: task.workspaceId, executionId, purpose: `tool ${toolName} result`,
          });
          status = result.status;
          if (isResearchTool(toolName)) {
            if (status === 'failed') researchFailures.add(toolName);
            else researchFailures.delete(toolName);
          }
          diagnostics = 'diagnostics' in result && result.diagnostics
            ? result.diagnostics as unknown as Record<string, unknown>
            : undefined;
        } catch (err: any) {
          output = err.message || 'Tool execution failed';
          status = 'failed';
          if (isResearchTool(toolName)) researchFailures.add(toolName);
        }

        if (tc.signal?.aborted || abortController.signal.aborted) throw new Error('Request aborted');
        const durationMs = Date.now() - startedAt;
        totalToolRuntimeMs += durationMs;
        middleware?.afterToolCall(toolName, toolInput, status, String(output), workdir, durationMs);
        if (!mcpTool) {
          completeToolExecution(toolExecId, {
            status, output, outputSummary: String(output).slice(0, 200),
            error: status === 'failed' ? output : undefined, durationMs, completedAt: new Date().toISOString(),
          });
        }
        recordLedgerEntry({
          executionId, taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId,
          type: 'tool.executed', decision: status,
          summary: `Tool ${toolName} ${status} in ${durationMs}ms`,
          metadata: { toolName, status, durationMs, inputSummary: summarizeToolPayload(toolInput), diagnostics },
        });
        const evidence = status === 'done' && isResearchTool(toolName)
          ? saveResearchEvidence(task, executionId, toolExecId, toolName, String(output)) : undefined;
        const resultContent = isResearchTool(toolName)
          ? JSON.stringify({ kind: 'research_result', status, output: String(output).slice(0, 16_000), artifactId: evidence?.id, diagnostics })
          : String(output).slice(0, 500);
        const resultMessage = addExecutionMessage({ executionId, type: 'tool_result', content: resultContent, toolName });
        eventBus.emit('execution:message', { executionId, taskId: task.id, workspaceId: task.workspaceId, type: 'tool_result', content: resultContent, message: resultMessage });
        eventBus.emit(status === 'failed' ? 'tool:failed' : 'tool:done', {
          toolExecutionId: toolExecId, toolId: toolName, taskId: task.id, workspaceId: task.workspaceId,
          executionId, agentId: agent.id, status, error: status === 'failed' ? output : undefined,
          durationMs, outputSummary: String(output).slice(0, 200),
        });
        if (!['cancelled', 'failed', 'done'].includes(getTask(task.id)?.status || '')) {
          updateTask(task.id, { status: 'running' });
        }
        updateAgentRun(executionId, 'observing', { toolCallCount: tracker.toolUseCount });
        return archiveLongToolOutput({ task, executionId, toolExecutionId: toolExecId, toolName, output: String(output) });
      };

      while (numTurns < maxTurns) {
        if (abortController.signal.aborted) throw new AgentRunStopped('cancelled', 'Request aborted', finalOutput);
        numTurns++;
        updateAgentRun(executionId, 'deciding', { turn: numTurns });

        const followUps = messageBus.drain(executionId);
        if (followUps.length > 0) {
          const followUpContext = followUps
            .map(message => message.fromExecution
              ? `[Agent context] ${message.content}`
              : `[User follow-up] ${message.content}`)
            .join('\n');
          messages.push({
            role: 'user',
            content: `New instructions received while you were working:\n${followUpContext}`,
          });
          addTaskLog(task.id, 'info', `Applied ${followUps.length} follow-up instruction(s) before model turn ${numTurns}`, agent.id);
          eventBus.emit('execution:progress', {
            executionId,
            taskId: task.id,
            agentDefId: agent.id,
            workspaceId: task.workspaceId,
            progress: getProgressSnapshot(tracker, 'Applied follow-up instructions'),
          });
        }

        const responseReserve = remainingResponseTokens(inputTokens, outputTokens, limits);
        const promptBudget = Math.max(1, limits.maxExecutionTokens - responseReserve);
        const compaction = compactMessages(messages, promptBudget, { keepRecent: 6, triggerRatio: 0.5 });
        if (compaction.compacted) {
          messages.length = 0;
          messages.push(...compaction.messages);
          addTaskLog(task.id, 'info', `🗜️ auto-compacted context ~${compaction.before}→${compaction.after} tokens`, agent.id);
        }
        const summaryVersion = compaction.compacted
          ? (loadExecutionContext(task).contextUsage?.summaryVersion ?? 0) + 1
          : undefined;
        if (summaryVersion !== undefined) {
          const summary = compaction.messages.find(message => typeof message.content === 'string' && message.content.startsWith('[Auto-compacted'));
          const artifactId = archiveContextSummary({ task, executionId, version: summaryVersion, summary: String(summary?.content || '') });
          addTaskLog(task.id, 'info', `Context summary v${summaryVersion} archived: ${artifactId}`, agent.id);
        }
        middleware?.beforeModelTurn({
          estimatedContextTokens: compaction.after,
          maxContextTokens: promptBudget,
          turn: numTurns,
          compacted: compaction.compacted,
        });

        if (compaction.after > promptBudget) {
          throw new Error(`CONTEXT_BUDGET_EXCEEDED: prompt needs ${compaction.after}/${promptBudget} tokens after compaction`);
        }
        recordContextUsage(task, compaction.after, limits.maxExecutionTokens, responseReserve, summaryVersion);
        // Reserve an in-flight model request conservatively. After a crash its
        // actual bill is unknown, so recovery must not reset the token budget.
        checkpoint(compaction.after, responseReserve);

        const completionParams = {
          model: selectedModel,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          max_tokens: responseReserve,
          ...modelRequestTuning(task),
        };

        // The gateway preserves the OpenAI path and adapts Copilot sessions into
        // the same completion shape. Streaming is enabled unless explicitly disabled.
        const requestTimeoutMs = Math.max(1, Math.min(conversationOnly ? 60_000 : toolDefs.length ? 600_000 : 120_000, executionDeadline - Date.now()));
        const modelRequest = {
          modelId: selectedModel,
          startedAt: new Date().toISOString(),
          deadlineAt: new Date(Date.now() + requestTimeoutMs).toISOString(),
          firstOutputAt: undefined as string | undefined,
        };
        updateAgentRun(executionId, 'deciding', { modelRequest });
        const completionOptions = {
          onToolCall: (tc: { id: string; function: { name: string; arguments: string }; signal?: AbortSignal }) =>
            researchBudget.run(modelNameToToolId.get(tc.function.name) || tc.function.name, () => executeCopilotToolCall(tc), tc.signal || abortController.signal),
          signal: abortController.signal,
          timeoutMs: requestTimeoutMs,
          idleTimeoutMs: conversationOnly ? Math.min(30_000, limits.maxExecutionIdleMs) : limits.maxExecutionIdleMs,
          ...(process.env.AGENT_STREAMING !== 'false'
            ? {
                onDelta: (delta: string) => {
                  if (abortController.signal.aborted || ['cancelled', 'failed', 'done'].includes(getTask(task.id)?.status || '')) return;
                  const safeDelta = sanitizeAgentOutput(delta, {
                    agentId: agent.id,
                    taskId: task.id,
                    workspaceId: task.workspaceId,
                    executionId,
                    purpose: 'streamed assistant output',
                  });
                  if (safeDelta) {
                    if (!modelRequest.firstOutputAt) {
                      modelRequest.firstOutputAt = new Date().toISOString();
                      const live = getExecution(executionId);
                      if (live?.status === 'running' && live.runState && !['completed', 'failed', 'cancelled', 'interrupted'].includes(live.runState.phase)) {
                        updateAgentRun(executionId, live.runState.phase, { modelRequest: { ...modelRequest } });
                      }
                    }
                    eventBus.emit('token:delta', {
                      executionId,
                      taskId: task.id,
                      agentId: agent.id,
                      workspaceId: task.workspaceId,
                      delta: safeDelta,
                    });
                  }
                },
              }
            : {}),
        };
        const completion = await getModelGateway().completeForModel(selectedModel, completionParams, completionOptions).finally(() => {
          const live = getExecution(executionId);
          if (live?.status === 'running' && live.runState?.modelRequest?.startedAt === modelRequest.startedAt) {
            updateAgentRun(executionId, live.runState.phase, { modelRequest: undefined });
          }
        });
        mergeProviderUsage(providerUsage, completion.usage);

        const choice = completion.choices[0];
        if (!choice) throw new AgentRunStopped('empty_output', 'AGENT_EMPTY_OUTPUT: no response from model');

        inputTokens += completion.usage?.prompt_tokens || 0;
        outputTokens += completion.usage?.completion_tokens || 0;
        tracker.latestInputTokens += completion.usage?.prompt_tokens || 0;
        tracker.cumulativeOutputTokens += completion.usage?.completion_tokens || 0;
        assertExecutionTokenBudget(inputTokens, outputTokens, finalOutput, 'TS agent execution', limits);
        if (choice.finish_reason === 'length') {
          throw new AgentRunStopped('model_truncated', 'AGENT_MODEL_TRUNCATED: model response reached its output limit', extractMessageText(choice.message.content));
        }
        if (choice.finish_reason === 'content_filter') throw new AgentRunStopped('failed', 'AGENT_MODEL_BLOCKED: model response was filtered');
        if (Date.now() - startTime > limits.maxExecutionWallClockMs) {
          throw new Error(`TS agent execution exceeded wall-clock budget (${limits.maxExecutionWallClockMs}ms)`);
        }

        let assistantMsg = choice.message;

        let text = extractMessageText(assistantMsg.content);
        const inputQuestion = requestedAgentInput(text);
        if (inputQuestion) text = inputQuestion;
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
          const message = addExecutionMessage({ executionId, type: 'agent_text', content: text });
          eventBus.emit('execution:message', { executionId, taskId: task.id, workspaceId: task.workspaceId, type: 'agent_text', content: text, message });
          addTaskLog(task.id, 'info', text.slice(0, 800), agent.id);
        }
        if (inputQuestion) {
          needsInput = true;
          completedNormally = true;
          break;
        }

        // Handle tool calls
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          for (const tc of assistantMsg.tool_calls) {
            if (abortController.signal.aborted) throw new AgentRunStopped('cancelled', 'Request aborted', finalOutput);
            updateAgentRun(executionId, 'acting', { toolCallCount: tracker.toolUseCount });
            const toolCallId = tc.id;
            const toolName = modelNameToToolId.get(tc.function.name) || tc.function.name;
            const mcpTool = isMcpTool(toolName);
            if (isResearchTool(toolName) || toolName === 'mcp__xiaohongshu__check_login_status') {
              const output = await researchBudget.run(toolName, () => executeCopilotToolCall({ ...tc, signal: abortController.signal }), abortController.signal);
              messages.push({ role: 'tool', tool_call_id: toolCallId, content: output });
              updateAgentRun(executionId, 'observing', { toolCallCount: tracker.toolUseCount });
              continue;
            }
            let toolInput: Record<string, unknown> = {};
            try {
              toolInput = JSON.parse(tc.function.arguments || '{}');
            } catch {}

            if (!toolPolicy.allowedTools.includes(toolName)) {
              const blockedOutput = `Tool ${toolName} is not allowed for agent ${agent.id}`;
              addTaskLog(task.id, 'warn', blockedOutput, agent.id);
              appendExecutionAuditEvent(executionId, {
                type: 'tool.blocked',
                severity: 'block',
                message: blockedOutput,
                metadata: { toolName, reason: 'not_in_agent_allowlist' },
              });
              eventBus.emit('tool:blocked', {
                toolId: toolName, taskId: task.id, workspaceId: task.workspaceId, executionId, agentId: agent.id,
                reason: 'not_in_agent_allowlist',
              });
              messages.push({ role: 'tool', tool_call_id: toolCallId, content: blockedOutput });
              continue;
            }

            // Validate parameter constraints FIRST
            const constraintViolations = mcpTool ? [] : validateToolParams(toolName, toolInput);
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
            const workdir = task.workdir || process.cwd();
            const middlewareDecision = middleware?.beforeToolCall(toolName, toolInput, workdir);
            if (middlewareDecision && !middlewareDecision.allowed) {
              const blockedOutput = middlewareDecision.reason || `Tool ${toolName} blocked by execution middleware`;
              addTaskLog(task.id, 'warn', blockedOutput, 'middleware');
              eventBus.emit('tool:blocked', {
                toolId: toolName, taskId: task.id, workspaceId: task.workspaceId, executionId, agentId: agent.id,
                reason: blockedOutput,
              });
              messages.push({ role: 'tool', tool_call_id: toolCallId, content: blockedOutput });
              continue;
            }

            // Record tool execution
            const toolExecId = `ts_${executionId}_${toolCallId}`;
            if (!mcpTool) {
              createToolExecution({
                id: toolExecId, toolId: toolName, taskId: task.id,
                executionId, agentId: agent.id, input: toolInput, startedAt: new Date().toISOString(),
              });
            }
            tracker.toolUseCount++;
            updateAgentRun(executionId, 'acting', { toolCallCount: tracker.toolUseCount });

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
            updateTask(task.id, { status: 'waiting_for_tool' });

            try {
              if (totalToolCalls >= limits.maxToolCallsPerExecution) {
                throw new Error(`Tool call limit exceeded (${limits.maxToolCallsPerExecution})`);
              }
              if (totalToolRuntimeMs >= limits.maxToolRuntimeMsPerExecution) {
                throw new Error(`Tool runtime budget exceeded (${limits.maxToolRuntimeMsPerExecution}ms)`);
              }
              totalToolCalls++;
              const result = await runWriteOnce(task, executionId, toolName, toolInput, async () => isMcpTool(toolName)
                ? await executeMcpTool(
                    toolName,
                    toolInput,
                    Math.min(limits.maxToolCallTimeoutMs, limits.maxToolRuntimeMsPerExecution - totalToolRuntimeMs),
                    buildMcpPolicyContext(agent, task),
                    reportXiaohongshuProgress,
                    abortController.signal,
                  )
                : await executeTool(toolName, toolInput, workdir, {
                    signal: abortController.signal,
                    allowedTools: toolPolicy.allowedTools,
                    workspaceId: task.workspaceId,
                    timeoutMs: Math.min(limits.maxToolCallTimeoutMs, limits.maxToolRuntimeMsPerExecution - totalToolRuntimeMs),
                    maxOutputChars: Math.min(limits.maxOutputChars, 8_000),
                    onProgress: ({ message }) => {
                      addTaskLog(task.id, 'info', `⏳ ${toolName}: ${message}`, agent.id);
                      eventBus.emit('execution:progress', {
                        executionId, taskId: task.id, agentDefId: agent.id, workspaceId: task.workspaceId,
                        progress: getProgressSnapshot(tracker, message),
                      });
                    },
                  }));
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
            middleware?.afterToolCall(toolName, toolInput, toolStatus, String(toolOutput), workdir, durationMs);
            recordLedgerEntry({
              executionId, taskId: task.id, agentId: agent.id, workspaceId: task.workspaceId,
              type: 'tool.executed', decision: toolStatus,
              summary: `Tool ${toolName} ${toolStatus} in ${durationMs}ms`,
              metadata: { toolName, status: toolStatus, durationMs, inputSummary: summarizeToolPayload(toolInput) },
            });
            if (toolStatus === 'failed') {
              appendExecutionAuditEvent(executionId, {
                type: 'tool.failed',
                severity: String(toolOutput).includes('blocked') || String(toolOutput).includes('guardian') ? 'block' : 'warn',
                message: `Tool ${toolName} failed`,
                metadata: { toolName, output: String(toolOutput).slice(0, 500), durationMs },
              });
            }

            if (!mcpTool) {
              completeToolExecution(toolExecId, {
                status: toolStatus, output: toolOutput,
                outputSummary: String(toolOutput).slice(0, 200),
                error: toolStatus === 'failed' ? toolOutput : undefined,
                durationMs, completedAt: new Date().toISOString(),
              });
            }
            completeTraceSpan(spanId, { status: toolStatus, metadata: { outputSummary: String(toolOutput).slice(0, 200), durationMs }, error: toolStatus === 'failed' ? toolOutput : undefined, durationMs });

            addExecutionMessage({ executionId, type: 'tool_result', content: String(toolOutput).slice(0, 500), toolName });
            eventBus.emit(toolStatus === 'failed' ? 'tool:failed' : 'tool:done', {
              toolExecutionId: toolExecId, toolId: toolName, taskId: task.id,
              workspaceId: task.workspaceId,
              executionId, agentId: agent.id, status: toolStatus, error: toolStatus === 'failed' ? toolOutput : undefined,
              durationMs, outputSummary: String(toolOutput).slice(0, 200),
            });
            if (!['cancelled', 'failed', 'done'].includes(getTask(task.id)?.status || '')) {
              updateTask(task.id, { status: 'running' });
            }

            messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: archiveLongToolOutput({ task, executionId, toolExecutionId: toolExecId, toolName, output: String(toolOutput) }),
            });
            updateAgentRun(executionId, 'observing', { toolCallCount: tracker.toolUseCount });
          }
        } else {
          // No tool calls — we're done
          completedNormally = true;
          break;
        }
        checkpoint();
      }
      if (!completedNormally) {
        throw new AgentRunStopped('max_turns', `AGENT_MAX_TURNS: execution exhausted ${maxTurns} turns without a final answer`, finalOutput);
      }
      if (!finalOutput.trim()) throw new AgentRunStopped('empty_output', 'AGENT_EMPTY_OUTPUT: model returned no final answer');
      sealLoopCheckpoint(executionId);

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
      if (canCache && finalOutput && !needsInput && researchFailures.size === 0) {
        llmCache.set(
          { workspaceId: task.workspaceId, model: selectedModel, system: systemPrompt, prompt: enrichedInput },
          { output: finalOutput, inputTokens, outputTokens },
        );
      }

      completeTraceSpan(llmSpan.id, {
        status: 'done',
        metadata: { inputTokens, outputTokens, numTurns, durationMs, cached: false },
      });

      const costUSD = providerCostUSD(selectedModel, inputTokens, outputTokens, providerUsage);
      recordModelUsage({
        modelId: selectedModel, agentId: agent.id, taskId: task.id,
        executionId, status: 'success',
        inputTokens, outputTokens,
        costUSD,
        costType: providerUsage.costType,
        provider: providerUsage.provider,
        actualModelId: providerUsage.actualModelId,
        aiUnits: providerUsage.aiUnits,
        billingMultiplier: providerUsage.billingMultiplier,
        latencyMs: durationMs,
        routeReason: modelSelection.reason,
        routeSource: modelSelection.source,
        modelTier: modelSelection.modelTier,
      });

      return {
        output: finalOutput,
        stopReason: needsInput ? 'needs_input' : researchAnswer && researchFailures.size > 0 ? 'tool_unavailable' : 'completed',
        costUSD,
        costType: providerUsage.costType,
        provider: providerUsage.provider,
        actualModelId: providerUsage.actualModelId,
        aiUnits: providerUsage.aiUnits,
        billingMultiplier: providerUsage.billingMultiplier,
        inputTokens,
        outputTokens,
        durationMs,
        numTurns,
        executionId,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      completeTraceSpan(llmSpan.id, { status: 'failed', error: err.message, metadata: { durationMs } });
      recordModelUsage({
        modelId: selectedModel, agentId: agent.id, taskId: task.id,
        executionId, status: 'failed', latencyMs: durationMs,
        routeReason: modelSelection.reason,
        routeSource: modelSelection.source,
        modelTier: modelSelection.modelTier,
        costType: providerUsage.costType,
        provider: providerUsage.provider,
        actualModelId: providerUsage.actualModelId,
        aiUnits: providerUsage.aiUnits,
        billingMultiplier: providerUsage.billingMultiplier,
      });
      throw err;
    } finally {
      researchBudget.close();
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
    middleware?: ExecutionMiddlewareChain,
  ): Promise<TaskResult> {
    const startTime = Date.now();
    const modelSelection = selectModelForAgent(agent, task, {
      promptText: `${systemPrompt}\n\n${parsedSkill.promptContent}\n\n${task.input}`,
    });
    const selectedModel = modelSelection.modelId;
    const providerUsage = createProviderUsage(selectedModel);
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
        sandbox: { enabled: true, guardian: true, profile: getSandboxProfile() },
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
    if (!getModelGateway().supportsTools(selectedModel) && runtimeToolIds.length > 0) {
      throw new Error('GitHub Copilot provider cannot execute structured skills that require runtime tools; use an OpenAI-compatible provider.');
    }

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
      let completedNormally = false;
      const maxTurns = llmOptions?.maxTurns ?? 20; // per-step max turns
      let stepToolRuntimeMs = 0;

      for (let turn = 0; turn < maxTurns; turn++) {
        if (abortController.signal.aborted) throw new Error('Execution aborted');
        updateAgentRun(executionId, 'deciding');

        const responseReserve = remainingResponseTokens(inputTokens, outputTokens, limits);
        const promptBudget = Math.max(1, limits.maxExecutionTokens - responseReserve);
        const compaction = compactMessages(messages, promptBudget, { keepRecent: 6, triggerRatio: 0.5 });
        if (compaction.compacted) {
          messages.length = 0;
          messages.push(...compaction.messages);
          addTaskLog(task.id, 'info', `🗜️ auto-compacted step context ~${compaction.before}→${compaction.after} tokens`, agent.id);
        }
        const summaryVersion = compaction.compacted
          ? (loadExecutionContext(task).contextUsage?.summaryVersion ?? 0) + 1
          : undefined;
        if (summaryVersion !== undefined) {
          const summary = compaction.messages.find(message => typeof message.content === 'string' && message.content.startsWith('[Auto-compacted'));
          const artifactId = archiveContextSummary({ task, executionId, version: summaryVersion, summary: String(summary?.content || '') });
          addTaskLog(task.id, 'info', `Context summary v${summaryVersion} archived: ${artifactId}`, agent.id);
        }
        middleware?.beforeModelTurn({
          estimatedContextTokens: compaction.after,
          maxContextTokens: promptBudget,
          turn: turn + 1,
          compacted: compaction.compacted,
        });

        if (compaction.after > promptBudget) {
          throw new Error(`CONTEXT_BUDGET_EXCEEDED: skill prompt needs ${compaction.after}/${promptBudget} tokens after compaction`);
        }
        recordContextUsage(task, compaction.after, limits.maxExecutionTokens, responseReserve, summaryVersion);

        const completion = await getModelGateway().completeForModel(selectedModel, {
          model: selectedModel,
          messages,
          tools: stepToolDefs.length > 0 ? stepToolDefs : undefined,
          max_tokens: responseReserve,
          ...modelRequestTuning(task),
        }, { signal: abortController.signal });
        mergeProviderUsage(providerUsage, completion.usage);

        const choice = completion.choices[0];
        if (!choice) throw new AgentRunStopped('empty_output', 'AGENT_EMPTY_OUTPUT: no response for skill step');
        if (choice.finish_reason === 'length') {
          throw new AgentRunStopped('model_truncated', 'AGENT_MODEL_TRUNCATED: skill output reached the model limit', extractMessageText(choice.message.content));
        }

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
        let text = extractMessageText(assistantMsg.content);
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

            if (!stepAllowedTools.includes(toolName)) {
              const blockedOutput = `Tool ${toolName} is not allowed for skill step ${llmOptions?.stepName || 'unknown'}`;
              addTaskLog(task.id, 'warn', blockedOutput, agent.id);
              appendExecutionAuditEvent(executionId, {
                type: 'tool.blocked',
                severity: 'block',
                message: blockedOutput,
                metadata: { toolName, reason: 'not_in_step_allowlist', step: llmOptions?.stepName },
              });
              eventBus.emit('tool:blocked', {
                toolId: toolName, taskId: task.id, workspaceId: task.workspaceId, executionId, agentId: agent.id,
                reason: 'not_in_step_allowlist',
              });
              messages.push({ role: 'tool', tool_call_id: tc.id, content: blockedOutput });
              continue;
            }
            const middlewareDecision = middleware?.beforeToolCall(toolName, toolInput, workdir);
            if (middlewareDecision && !middlewareDecision.allowed) {
              const blockedOutput = middlewareDecision.reason || `Tool ${toolName} blocked by execution middleware`;
              addTaskLog(task.id, 'warn', blockedOutput, 'middleware');
              eventBus.emit('tool:blocked', {
                toolId: toolName, taskId: task.id, workspaceId: task.workspaceId, executionId, agentId: agent.id,
                reason: blockedOutput,
              });
              messages.push({ role: 'tool', tool_call_id: tc.id, content: blockedOutput });
              continue;
            }

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
            updateAgentRun(executionId, 'acting', { toolCallCount: tracker.toolUseCount });
            updateTask(task.id, { status: 'waiting_for_tool' });
            const remainingToolBudgetMs = Math.min(
              limits.maxToolCallTimeoutMs,
              limits.maxToolRuntimeMsPerStep - stepToolRuntimeMs,
              limits.maxToolRuntimeMsPerExecution - executionToolRuntimeMs,
            );
            const toolStartedAt = Date.now();
            const result = await runWriteOnce(task, executionId, toolName, toolInput, async () => isMcpTool(toolName)
              ? await executeMcpTool(
                  toolName,
                  toolInput,
                  remainingToolBudgetMs,
                  buildMcpPolicyContext(agent, task),
                  event => {
                    const message = `小红书 · ${event.message} · ${(event.elapsedMs / 1000).toFixed(1)}s`;
                    addTaskLog(task.id, 'info', message, agent.id);
                    addExecutionMessage({ executionId, type: 'progress', content: message, toolName });
                    eventBus.emit('execution:progress', {
                      executionId, taskId: task.id, agentDefId: agent.id,
                      workspaceId: task.workspaceId, progress: getProgressSnapshot(tracker, message),
                    });
                  },
                  abortController.signal,
                )
              : await executeTool(toolName, toolInput, workdir, {
                  signal: abortController.signal,
                  allowedTools: stepAllowedTools,
                  workspaceId: task.workspaceId,
                  timeoutMs: remainingToolBudgetMs,
                  maxOutputChars: Math.min(limits.maxOutputChars, 8_000),
                  onProgress: ({ message }) => {
                    addTaskLog(task.id, 'info', `⏳ ${toolName}: ${message}`, agent.id);
                    addExecutionMessage({ executionId, type: 'progress', content: message });
                  },
                }));
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
            middleware?.afterToolCall(toolName, toolInput, result.status, safeToolOutput, workdir, toolElapsedMs);
            updateAgentRun(executionId, 'observing', { toolCallCount: tracker.toolUseCount });
            if (!['cancelled', 'failed', 'done'].includes(getTask(task.id)?.status || '')) {
              updateTask(task.id, { status: 'running' });
            }

            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: archiveLongToolOutput({ task, executionId, toolExecutionId: `skill_${executionId}_${tc.id}`, toolName, output: safeToolOutput }),
            });
          }
        } else {
          // No tool calls — step complete
          completedNormally = true;
          break;
        }
      }
      if (!completedNormally) {
        throw new AgentRunStopped('max_turns', `AGENT_MAX_TURNS: skill step exhausted ${maxTurns} turns`, finalOutput);
      }

      // If the model only emitted tool calls (no text), ask once more without
      // tools so step validation has a concrete textual result to check.
      if (!finalOutput.trim()) {
        try {
          const responseReserve = remainingResponseTokens(inputTokens, outputTokens, limits);
          const promptBudget = Math.max(1, limits.maxExecutionTokens - responseReserve);
          const summaryMessages = [...messages, { role: 'user' as const, content: 'Provide the result of this step as plain text.' }];
          const summaryCompaction = compactMessages(summaryMessages, promptBudget, { keepRecent: 6, triggerRatio: 0.5 });
          if (summaryCompaction.after > promptBudget) {
            throw new Error(`CONTEXT_BUDGET_EXCEEDED: summary prompt needs ${summaryCompaction.after}/${promptBudget} tokens after compaction`);
          }
          const summaryVersion = summaryCompaction.compacted
            ? (loadExecutionContext(task).contextUsage?.summaryVersion ?? 0) + 1
            : undefined;
          if (summaryVersion !== undefined) {
            const summary = summaryCompaction.messages.find(message => typeof message.content === 'string' && message.content.startsWith('[Auto-compacted'));
            const artifactId = archiveContextSummary({ task, executionId, version: summaryVersion, summary: String(summary?.content || '') });
            addTaskLog(task.id, 'info', `Context summary v${summaryVersion} archived: ${artifactId}`, agent.id);
          }
          recordContextUsage(task, summaryCompaction.after, limits.maxExecutionTokens, responseReserve, summaryVersion);
          const summary = await getModelGateway().completeForModel(selectedModel, {
            model: selectedModel,
            messages: summaryCompaction.messages,
            max_tokens: responseReserve,
            ...modelRequestTuning(task),
          }, { signal: abortController.signal });
          mergeProviderUsage(providerUsage, summary.usage);
          const summaryInputTokens = summary.usage?.prompt_tokens || 0;
          const summaryOutputTokens = summary.usage?.completion_tokens || 0;
          inputTokens += summaryInputTokens;
          outputTokens += summaryOutputTokens;
          tracker.latestInputTokens = summaryInputTokens;
          tracker.cumulativeOutputTokens += summaryOutputTokens;
          finalOutput = extractMessageText(summary.choices[0]?.message?.content).trim() || finalOutput;
        } catch {
          /* keep finalOutput as-is */
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
      onStepWarning: (idx, step, message) => {
        // Advisory (optional) validation failure — surfaced to the operator via
        // task logs and the execution stream, but does not fail the task.
        addTaskLog(task.id, 'warn', `⚠ Step "${step.name}" advisory: ${message}`, agent.id);
        addExecutionMessage({ executionId, type: 'progress', content: `Advisory (step "${step.name}"): ${message}` });
      },
    });

    const result = await executor.run(task.input);

    const durationMs = Date.now() - startTime;
    const costUSD = providerCostUSD(selectedModel, inputTokens, outputTokens, providerUsage);
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
      costType: providerUsage.costType,
      provider: providerUsage.provider,
      actualModelId: providerUsage.actualModelId,
      aiUnits: providerUsage.aiUnits,
      billingMultiplier: providerUsage.billingMultiplier,
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
      costType: providerUsage.costType,
      provider: providerUsage.provider,
      actualModelId: providerUsage.actualModelId,
      aiUnits: providerUsage.aiUnits,
      billingMultiplier: providerUsage.billingMultiplier,
      inputTokens,
      outputTokens,
      durationMs,
      numTurns: result.steps.length,
      executionId,
    };
  }
}

export const tsAgentLoop = new TsAgentLoop();
