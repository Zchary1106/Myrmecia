import OpenAI from 'openai';
import type { AgentDefinition, Task, AgentProgress, ToolActivity, ProgressTracker } from '../types.js';
import { eventBus } from '../events/event-bus.js';
import { updateTask, addTaskLog } from '../db/models/task.js';
import { updateExecution, addExecutionMessage } from '../db/models/execution.js';
import { completeTraceSpan, createTraceSpan } from '../db/models/trace.js';
import { resolveAllowedToolsForAgent, validateToolParams } from '../tools/tool-policy.js';
import { createToolExecution, completeToolExecution, summarizeToolPayload } from '../tools/tool-execution.js';
import { recordModelUsage, selectModelForAgent } from '../models/model-registry.js';
import { messageBus } from './message-bus.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SkillDefinition, SkillVersion, SkillExecutorConfig } from '../types.js';
import { parseSkillContent } from '../skills/skill-parser.js';
import { SkillExecutor } from '../skills/skill-executor.js';
import { llmCache } from '../cache/llm-cache.js';
import { metrics } from '../observability/telemetry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_RECENT_ACTIVITIES = 5;

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

/** Estimate cost in USD from token counts. Conservative pricing defaults. */
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Per-1K-token pricing (conservative estimate)
  const modelLower = model.toLowerCase();
  let inputPrice = 0.003, outputPrice = 0.006; // default balanced pricing
  if (modelLower.includes('opus')) { inputPrice = 0.015; outputPrice = 0.075; }
  else if (modelLower.includes('haiku')) { inputPrice = 0.001; outputPrice = 0.005; }
  else if (modelLower.includes('mini')) { inputPrice = 0.0005; outputPrice = 0.002; }
  return (inputTokens / 1000) * inputPrice + (outputTokens / 1000) * outputPrice;
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
    const baseURL = process.env.CREWAI_BASE_URL || 'https://morninglab.japaneast.cloudapp.azure.com/v1';
    const apiKey = process.env.CREWAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
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

    // Block disallowed tools (same as CrewAI path)
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
      eventBus.emit('tool:blocked', { toolId: decision.toolId, taskId: task.id, executionId, agentId: agent.id, reason: decision.reason });
    }

    const systemPrompt = buildSystemPrompt(agent, toolPolicy, runtimeSkill);

    // Check if the resolved skill is structured (step-driven)
    const parsedSkill = runtimeSkill
      ? parseSkillContent(runtimeSkill.version.content)
      : null;

    if (parsedSkill?.isStructured && parsedSkill.config) {
      return this.executeWithSkillExecutor(
        agent, task, abortController, executionId, traceId, rootSpanId,
        tracker, parsedSkill, toolPolicy, systemPrompt,
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

    // Model selection
    const modelSelection = selectModelForAgent(agent);
    const selectedModel = modelSelection.modelId;
    const modelSpan = createTraceSpan({
      traceId, parentSpanId: rootSpanId, type: 'model.route', name: 'Select model',
      metadata: modelSelection as unknown as Record<string, unknown>,
    });
    completeTraceSpan(modelSpan.id, { status: 'done' });

    // Inject messages from other agents
    let enrichedInput = task.input;
    try {
      const pendingMsgs = messageBus.drain(executionId);
      if (pendingMsgs.length > 0) {
        const msgContext = pendingMsgs.map(m => `[${m.messageType}] ${m.content}`).join('\n');
        enrichedInput = `${task.input}\n\n## Context from other agents:\n${msgContext}`;
        addTaskLog(task.id, 'info', `Injected ${pendingMsgs.length} message(s) from other agents`, 'system');
      }
    } catch {}

    // LLM call span
    const llmSpan = createTraceSpan({
      traceId, parentSpanId: rootSpanId, type: 'llm.call', name: 'TS Agent Loop',
      metadata: { model: selectedModel, runner: 'ts-agent-loop' },
    });

    try {
      // Build tool definitions for the API
      const toolDefs = toolPolicy.allowedTools.map(toolId => ({
        type: 'function' as const,
        function: {
          name: toolId,
          description: `Tool: ${toolId}`,
          parameters: { type: 'object' as const, properties: {}, additionalProperties: true },
        },
      }));

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
          });
          return { output: cached.output, costUSD: cacheCost, inputTokens: cached.inputTokens, outputTokens: cached.outputTokens, durationMs: 0, numTurns: 1, executionId };
        }
        metrics.cacheHitRate.add(1, { status: 'miss' });
      }

      while (numTurns < maxTurns) {
        numTurns++;

        const completion = await client.chat.completions.create({
          model: selectedModel,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          max_tokens: 4096,
        }, {
          signal: abortController.signal,
        });

        const choice = completion.choices[0];
        if (!choice) throw new Error('No response from model');

        inputTokens += completion.usage?.prompt_tokens || 0;
        outputTokens += completion.usage?.completion_tokens || 0;
        tracker.latestInputTokens += completion.usage?.prompt_tokens || 0;
        tracker.cumulativeOutputTokens += completion.usage?.completion_tokens || 0;

        const assistantMsg = choice.message;
        messages.push(assistantMsg);

        // Handle text content
        if (assistantMsg.content) {
          const text = typeof assistantMsg.content === 'string' ? assistantMsg.content : '';
          if (text) {
            finalOutput = text;
            addExecutionMessage({ executionId, type: 'agent_text', content: text.slice(0, 500) });
            eventBus.emit('execution:message', { executionId, type: 'agent_text', content: text.slice(0, 500) });
            addTaskLog(task.id, 'info', text.slice(0, 800), agent.id);
          }
        }

        // Handle tool calls
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          for (const tc of assistantMsg.tool_calls) {
            const toolCallId = tc.id;
            const toolName = tc.function.name;
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
              eventBus.emit('tool:blocked', {
                toolId: toolName, taskId: task.id, executionId, agentId: agent.id,
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
            eventBus.emit('tool:started', { toolExecutionId: toolExecId, toolId: toolName, taskId: task.id, executionId, agentId: agent.id, inputSummary: summarizeToolPayload(toolInput) });
            eventBus.emit('execution:progress', { executionId, taskId: task.id, agentDefId: agent.id, progress: getProgressSnapshot(tracker) });

            try {
              toolOutput = JSON.stringify({ note: `Tool ${toolName} called with ${JSON.stringify(toolInput)}. For TS-native execution, implement the tool directly or use CrewAI path.` });
            } catch (err: any) {
              toolOutput = err.message || 'Tool execution failed';
              toolStatus = 'failed';
            }

            const durationMs = Date.now() - toolStartTime;

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
      });

      return { output: finalOutput, costUSD, inputTokens, outputTokens, durationMs, numTurns, executionId };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      completeTraceSpan(llmSpan.id, { status: 'failed', error: err.message, metadata: { durationMs } });
      recordModelUsage({
        modelId: selectedModel, agentId: agent.id, taskId: task.id,
        executionId, status: 'failed', latencyMs: durationMs,
        routeReason: modelSelection.reason,
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
    const modelSelection = selectModelForAgent(agent);
    const selectedModel = modelSelection.modelId;

    addTaskLog(task.id, 'info', `Skill Executor: ${parsedSkill.config.steps.length} steps`, 'system');

    const llmCall = async (stepSystemPrompt: string, userPrompt: string): Promise<string> => {
      if (abortController.signal.aborted) throw new Error('Execution aborted');

      const response = await client.chat.completions.create({
        model: selectedModel,
        messages: [
          { role: 'system', content: stepSystemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 4096,
      });

      const content = response.choices[0]?.message?.content || '';
      tracker.cumulativeOutputTokens += response.usage?.completion_tokens || 0;
      tracker.latestInputTokens = response.usage?.prompt_tokens || 0;
      return content;
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
          executionId, taskId: task.id, agentDefId: agent.id,
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
    const costUSD = estimateCost(selectedModel, tracker.latestInputTokens, tracker.cumulativeOutputTokens);

    recordModelUsage({
      modelId: selectedModel,
      agentId: agent.id,
      taskId: task.id,
      executionId,
      status: result.success ? 'success' : 'failed',
      inputTokens: tracker.latestInputTokens,
      outputTokens: tracker.cumulativeOutputTokens,
      costUSD,
      latencyMs: durationMs,
      routeReason: `skill-executor: ${parsedSkill.config.steps.length} steps`,
    });

    if (!result.success) {
      const failedStep = result.steps.find(s => s.status === 'failed');
      throw new Error(`Skill execution failed at step "${failedStep?.name}": ${failedStep?.error}`);
    }

    return {
      output: result.finalOutput,
      costUSD,
      inputTokens: tracker.latestInputTokens,
      outputTokens: tracker.cumulativeOutputTokens,
      durationMs,
      numTurns: result.steps.length,
      executionId,
    };
  }
}

export const tsAgentLoop = new TsAgentLoop();
