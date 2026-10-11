import { createHash, randomUUID } from 'node:crypto';
import type { AgentInboxEntry, RuntimeEvent, RuntimeMessage, RuntimeRequest, Task } from '../types.js';
import { getDb } from '../db/database.js';
import { agentSessionForTask, appendSessionEvent, listSessionEvents } from '../db/models/agent-session-event.js';
import { ackInbox, applyInbox, bindAssignedFollowUps, claimInbox, getInboxEntry, markInboxDeliveryUncertain } from '../db/models/agent-inbox.js';
import { deriveModelMessages } from './session-projector.js';
import { normalizeGatewayRequest, toGatewayRequest } from '../models/provider-driver.js';
import { defaultRuntimeCapabilities } from '@myrmecia/shared';
import { boundedModelOutput, markBudgetDispatched, reserveBudget, settleUsage } from './budget-service.js';
import { getModel } from '../models/model-registry.js';
import { getExecution } from '../db/models/execution.js';
import { estimateContextTokens } from './context-compactor.js';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Journal authority for a host request. Buffer arrays are disposable compatibility views. */
export class SessionHarness {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly requestId = randomUUID();
  private applied: AgentInboxEntry[] = [];
  private modelId?: string;
  private providerMode: 'host_loop' | 'provider_loop' = 'host_loop';
  constructor(readonly task: Task, readonly runId: string) {
    this.workspaceId = task.workspaceId || 'default';
    this.sessionId = agentSessionForTask(task);
  }
  events() {
    const result = [];
    let cursor = 0;
    for (;;) {
      const page = listSessionEvents({ workspaceId: this.workspaceId, sessionId: this.sessionId, afterSequence: cursor, limit: 1000 });
      result.push(...page);
      if (page.length < 1000) break;
      cursor = page.at(-1)!.sequence;
    }
    return result;
  }
  messages(requestId: string = this.requestId): RuntimeMessage[] {
    return deriveModelMessages(this.events(), requestId);
  }
  appendTool(message: any): void {
    if (message.role !== 'tool') return;
    const normalized = normalizeGatewayRequest({ model: 'journal', messages: [message] }).messages[0];
    appendSessionEvent({ workspaceId: this.workspaceId, sessionId: this.sessionId, runId: this.runId,
      requestId: this.requestId, eventKey: `${this.requestId}:tool-result:${normalized.toolCallId}`,
      payload: { type: 'model.message', role: 'tool', content: normalized.content, toolCallId: normalized.toolCallId } });
  }
  /** Apply + persist the request atomically, before any external model dispatch. */
  prepare(request: RuntimeRequest, transform: (request: RuntimeRequest) => RuntimeRequest, providerMode: 'host_loop' | 'provider_loop' = 'host_loop'): RuntimeRequest {
    return getDb().transaction(() => {
      appendSessionEvent({ workspaceId: this.workspaceId, sessionId: this.sessionId, runId: this.runId,
        eventKey: `${this.runId}:user`, payload: { type: 'user.submitted', taskId: this.task.id, content: this.task.input } });
      this.applied = claimInbox({ workspaceId: this.workspaceId, sessionId: this.sessionId,
        targetExecutionId: this.runId, mode: 'steer', owner: this.requestId });
      const messages = [...request.messages, ...this.applied.map(entry => ({
        role: 'user' as const, content: [{ type: 'text' as const, text: entry.content }],
      }))];
      const prepared = transform({ ...request, messages });
      this.modelId = prepared.modelId;
      this.providerMode = providerMode;
      const model = getModel(prepared.modelId);
      const input = estimateContextTokens(JSON.stringify(prepared.messages)) + estimateContextTokens(JSON.stringify(prepared.tools || []));
      const agentId = this.task.assigneeId || getExecution(this.runId)!.agentDefId;
      const output = boundedModelOutput(this.workspaceId, agentId, this.task.id, input, prepared.maxOutputTokens || 8192);
      prepared.maxOutputTokens = output;
      const subscription = providerMode === 'provider_loop';
      const pricing = model?.costProfile.pricing as { inputPer1k?: number; outputPer1k?: number } | undefined;
      const cost = !subscription && typeof pricing?.inputPer1k === 'number' && typeof pricing.outputPer1k === 'number'
        ? input / 1000 * pricing.inputPer1k + output / 1000 * pricing.outputPer1k : null;
      reserveBudget({
        workspaceId: this.workspaceId, taskId: this.task.id, agentId: this.task.assigneeId || getExecution(this.runId)!.agentDefId,
        key: this.requestId, kind: 'model', tokens: input + output, toolCalls: 0, runtimeMs: 0,
        costType: subscription ? 'subscription' : cost === null ? 'unavailable' : 'estimated', costUSD: cost,
      });
      for (const entry of this.applied) applyInbox({
        workspaceId: this.workspaceId, id: entry.id, owner: this.requestId, requestId: this.requestId,
      });
      this.applied.push(...bindAssignedFollowUps({ workspaceId: this.workspaceId, sessionId: this.sessionId,
        taskId: this.task.id, executionId: this.runId, requestId: this.requestId }));
      appendSessionEvent({ workspaceId: this.workspaceId, sessionId: this.sessionId, runId: this.runId,
        requestId: this.requestId, eventKey: `${this.requestId}:context`,
        payload: { type: 'context.recorded', projectionVersion: 1, kind: providerMode === 'provider_loop' ? 'provider_envelope' : 'host_request',
          modelId: prepared.modelId, messages: prepared.messages,
          toolsFingerprint: fingerprint(prepared.tools || []),
          configFingerprint: fingerprint({ modelId: prepared.modelId, maxOutputTokens: prepared.maxOutputTokens, tuning: prepared.tuning, providerMode }) } });
      // The actual transport reads the persisted (DLP-checked) projection.
      return { ...prepared, messages: this.messages() };
    });
  }
  record(event: RuntimeEvent): void {
    if (event.type === 'request.started') markBudgetDispatched(this.workspaceId, this.requestId);
    appendSessionEvent({ workspaceId: this.workspaceId, sessionId: this.sessionId, runId: this.runId,
      requestId: this.requestId, eventKey: `${this.requestId}:provider:${event.sequence}`, payload: event });
    if (['assistant.delta', 'assistant.completed', 'tool.started', 'usage'].includes(event.type)) {
      for (const entry of this.applied) {
        const current = getInboxEntry(entry.id, this.workspaceId);
        if (current?.status === 'applied') ackInbox({ workspaceId: this.workspaceId, id: entry.id, requestId: this.requestId });
      }
    }
    if (event.type === 'usage') {
      const tokens = event.metrics.inputTokens === null || event.metrics.outputTokens === null ? null
        : event.metrics.inputTokens + event.metrics.outputTokens;
      const pricing = this.modelId ? getModel(this.modelId)?.costProfile.pricing as { inputPer1k?: number; outputPer1k?: number } | undefined : undefined;
      const estimatedCost = this.providerMode === 'host_loop' && event.costType !== 'subscription' && tokens !== null
        && typeof pricing?.inputPer1k === 'number' && typeof pricing.outputPer1k === 'number'
        ? event.metrics.inputTokens! / 1000 * pricing.inputPer1k + event.metrics.outputTokens! / 1000 * pricing.outputPer1k : null;
      settleUsage({ workspaceId: this.workspaceId, key: this.requestId, eventKey: `${this.requestId}:usage`,
        mode: 'cumulative', tokens, costType: event.costUSD === null && estimatedCost !== null ? 'estimated' : event.costType,
        costUSD: event.costUSD ?? estimatedCost });
    }
    if (event.type === 'request.stopped' && ['failed', 'cancelled'].includes(event.reason)) {
      for (const entry of this.applied) markInboxDeliveryUncertain(this.workspaceId, entry.id);
    }
  }
  recordAssistant(message: any): void {
    const normalized = normalizeGatewayRequest({ model: 'journal', messages: [message] }).messages[0];
    appendSessionEvent({ workspaceId: this.workspaceId, sessionId: this.sessionId, runId: this.runId,
      requestId: this.requestId, eventKey: `${this.requestId}:assistant`,
      payload: { type: 'model.message', role: 'assistant', content: normalized.content, toolCalls: normalized.toolCalls } });
  }
  legacyMessages(): any[] {
    return toGatewayRequest({ modelId: 'journal', messages: this.messages() }, defaultRuntimeCapabilities('host_loop')).messages;
  }
}
