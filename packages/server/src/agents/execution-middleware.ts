import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentDefinition, Task } from '../types.js';
import { addTaskLog } from '../db/models/task.js';
import { recordLedgerEntry } from '../db/models/execution-ledger.js';
import { appendExecutionAuditEvent } from '../audit/execution-audit.js';
import { eventBus } from '../events/event-bus.js';
import type { RuntimeLimits } from './runtime-limits.js';
import { assertRuntimeKnowledgeCurrent } from '../knowledge/runtime-knowledge.js';
import { DevelopmentWorkflow, checkDevelopmentArtifacts } from './development-workflow.js';
import { AgentRunStopped } from './run-state.js';
import { builtinInputErrors } from '../tools/builtin-input.js';

type ToolStatus = 'done' | 'failed';

export interface ToolMiddlewareDecision {
  allowed: boolean;
  reason?: string;
  terminal?: boolean;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function fingerprint(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(stableValue(input))}`;
}

function targetPath(input: Record<string, unknown>, workdir: string): string | undefined {
  const raw = input.path ?? input.file_path;
  const path = typeof raw === 'string' ? raw.trim() : '';
  return path ? resolve(workdir, path) : undefined;
}

/**
 * Stateful policy chain shared by every runtime adapter. Adapter-independent
 * lifecycle hooks live here; turn/tool hooks are consumed by the TS loop.
 */
export class ExecutionMiddlewareChain {
  private readonly readPaths = new Set<string>();
  private readonly failureCounts = new Map<string, number>();
  private readonly unreadWriteRefusals = new Map<string, number>();
  private unreadWriteRefusalCount = 0;
  private lastFingerprint = '';
  private repeatedCalls = 0;
  private turnCount = 0;
  private adapterName = 'unknown';
  private readonly development: DevelopmentWorkflow;

  constructor(
    private readonly agent: AgentDefinition,
    private readonly task: Task,
    private readonly executionId: string,
    private readonly limits: RuntimeLimits,
  ) {
    this.development = new DevelopmentWorkflow(agent, task);
  }

  beforeExecution(adapterName: string): void {
    this.adapterName = adapterName;
    this.note('middleware.started', 'allowed', `Execution middleware enabled for ${adapterName}`, {
      adapterName,
      limits: this.limits,
      developmentProfile: this.development.profile,
    });
  }

  beforeModelTurn(input: {
    estimatedContextTokens: number;
    maxContextTokens?: number;
    turn: number;
    compacted?: boolean;
  }): void {
    assertRuntimeKnowledgeCurrent(this.executionId);
    this.turnCount = Math.max(this.turnCount, input.turn);
    const maxContextTokens = input.maxContextTokens || this.limits.maxExecutionTokens;
    if (input.estimatedContextTokens > maxContextTokens) {
      const message = `Context budget exceeded (${input.estimatedContextTokens}/${maxContextTokens})`;
      this.note('middleware.context_budget', 'blocked', message, input, 'block');
      throw new Error(message);
    }
    if (input.compacted) {
      this.note('middleware.context_compacted', 'degraded', 'Context compacted before model turn', input);
    }
  }

  beforeToolCall(toolName: string, input: Record<string, unknown>, workdir: string): ToolMiddlewareDecision {
    assertRuntimeKnowledgeCurrent(this.executionId);
    const callFingerprint = fingerprint(toolName, input);
    if (callFingerprint === this.lastFingerprint) this.repeatedCalls++;
    else {
      this.lastFingerprint = callFingerprint;
      this.repeatedCalls = 1;
    }

    if (this.repeatedCalls >= 3) {
      const reason = `Loop detector blocked repeated call #${this.repeatedCalls} to ${toolName}; change strategy or input.`;
      this.note('middleware.loop_detected', 'blocked', reason, { toolName, repeatedCalls: this.repeatedCalls }, 'block');
      return { allowed: false, reason, terminal: true };
    }

    const inputErrors = builtinInputErrors(toolName, input);
    if (inputErrors.length) {
      const reason = `TOOL_INPUT_INVALID: ${inputErrors.join('; ')}. Correct the required parameters; no tool effects were executed.`;
      this.note('middleware.tool_input_invalid', 'blocked', reason, { toolName, executed: false }, 'warn');
      return { allowed: false, reason };
    }

    if ((this.failureCounts.get(toolName) || 0) >= 2) {
      const reason = `Tool ${toolName} failed repeatedly; use an alternative tool or ask for operator input.`;
      this.note('middleware.tool_degraded', 'blocked', reason, { toolName, failures: this.failureCounts.get(toolName) }, 'warn');
      return { allowed: false, reason };
    }

    if (toolName === 'file_write' || toolName === 'apply_patch') {
      const path = targetPath(input, workdir);
      if (path && existsSync(path) && !this.readPaths.has(path)) {
        const refusals = (this.unreadWriteRefusals.get(path) || 0) + 1;
        this.unreadWriteRefusals.set(path, refusals);
        this.unreadWriteRefusalCount++;
        const terminal = refusals >= 3 || this.unreadWriteRefusalCount >= 6;
        const reason = JSON.stringify({
          error: terminal ? 'TOOL_REJECTION_LIMIT' : 'READ_BEFORE_WRITE',
          message: `Read-before-write gate: inspect ${String(input.path ?? input.file_path)} with file_read in THIS execution before modifying it.`,
          recovery: { tool: 'file_read', input: { path: input.path ?? input.file_path } },
          priorTurnReadsAreNotCurrent: true, terminal,
        });
        this.note('middleware.read_before_write', 'blocked', reason,
          { toolName, path: input.path, refusals, terminal }, 'block');
        return { allowed: false, reason, terminal };
      }
    }

    const development = this.development.beforeTool(toolName, input, workdir);
    if (!development.allowed) this.note('middleware.development_gate', 'blocked', development.reason!,
      { toolName, terminal: development.terminal, profile: this.development.profile.kind }, 'warn');
    return development;
  }

  afterToolCall(
    toolName: string,
    input: Record<string, unknown>,
    status: ToolStatus,
    output: string,
    workdir: string,
    durationMs: number,
  ): void {
    this.development.afterTool(toolName, status, output, input);
    const path = targetPath(input, workdir);
    if (status === 'done') {
      this.failureCounts.delete(toolName);
      if (toolName === 'file_read' && path) {
        this.readPaths.add(path);
        this.unreadWriteRefusals.delete(path);
        this.unreadWriteRefusalCount = 0;
      }
    } else {
      this.failureCounts.set(toolName, (this.failureCounts.get(toolName) || 0) + 1);
    }
    this.note('middleware.tool_observed', status, `Observed ${toolName} ${status}`, {
      toolName,
      status,
      durationMs,
      outputSummary: output.slice(0, 240),
    });
  }

  /** Guidance is separate from the immutable raw tool output/receipt. */
  modelToolResult(output: string): string {
    return this.development.modelResult(output);
  }

  validateDevelopmentDelivery(workdir: string, partialOutput = ''): void {
    if (!this.development.profile.designPaths.length) return;
    const check = checkDevelopmentArtifacts(this.development.profile, workdir, true);
    this.note('middleware.development_delivery', check.valid ? 'passed' : 'blocked',
      check.valid ? 'Design schema and declared implementation files verified; tests and visual acceptance are separate'
        : `DEVELOPMENT_DELIVERY_INCOMPLETE: ${check.errors.join('; ')}`,
      { ...check, uiVisualAcceptance: 'not_verified_by_this_gate' }, check.valid ? 'info' : 'block');
    if (!check.valid) throw new AgentRunStopped('failed', `DEVELOPMENT_DELIVERY_INCOMPLETE: ${check.errors.join('; ')}`, partialOutput);
  }

  afterExecution(metadata: Record<string, unknown>): void {
    this.note('middleware.completed', 'done', 'Execution middleware completed', {
      adapterName: this.adapterName,
      turns: this.turnCount,
      ...metadata,
    });
  }

  onError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.note('middleware.failed', 'failed', message, { adapterName: this.adapterName, turns: this.turnCount }, 'warn');
  }

  private note(
    type: string,
    decision: string,
    summary: string,
    metadata: Record<string, unknown>,
    severity: 'info' | 'warn' | 'block' = 'info',
  ): void {
    recordLedgerEntry({
      executionId: this.executionId,
      taskId: this.task.id,
      agentId: this.agent.id,
      workspaceId: this.task.workspaceId,
      type,
      decision,
      summary,
      metadata,
    });
    appendExecutionAuditEvent(this.executionId, {
      type,
      severity,
      message: summary,
      metadata,
    });
    if (severity !== 'info') addTaskLog(this.task.id, severity === 'block' ? 'warn' : severity, summary, 'middleware');
    eventBus.emit('execution:middleware', {
      executionId: this.executionId,
      taskId: this.task.id,
      agentId: this.agent.id,
      workspaceId: this.task.workspaceId,
      type,
      decision,
      summary,
      metadata,
    });
  }
}
