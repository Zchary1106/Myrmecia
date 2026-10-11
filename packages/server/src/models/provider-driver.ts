import {
  defaultRuntimeCapabilities,
  type NormalizedContentBlock, type RuntimeCapabilities, type RuntimeEvent,
  type RuntimeEventIdentity, type RuntimeMessage, type RuntimeRequest, type RuntimeResponse,
} from '@myrmecia/shared';
import type { ProviderSessionOptions } from './provider-session.js';

export interface GatewayTransport {
  providerFor(modelId: string): string;
  runtimeCapabilitiesFor?(modelId: string): RuntimeCapabilities;
  completeForModel(modelId: string, params: any, options?: {
    signal?: AbortSignal; timeoutMs?: number; idleTimeoutMs?: number;
    providerSession?: ProviderSessionOptions;
    onDelta?: (text: string) => void;
    onToolCall?: (call: { id: string; function: { name: string; arguments: string }; signal?: AbortSignal }) => Promise<string>;
  }): Promise<any>;
}

export interface ProviderDriverOptions {
  identity: Omit<RuntimeEventIdentity, 'schemaVersion' | 'sequence'>;
  onEvent?: (event: RuntimeEvent) => void;
  onDelta?: (text: string) => void;
  onToolCall?: NonNullable<Parameters<GatewayTransport['completeForModel']>[2]>['onToolCall'];
  timeoutMs?: number;
  idleTimeoutMs?: number;
  providerSession?: ProviderSessionOptions;
}

type EventPayload<T = RuntimeEvent> = T extends RuntimeEvent ? Omit<T, keyof RuntimeEventIdentity> : never;

function textBlocks(content: unknown): NormalizedContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (content == null) return [];
  if (!Array.isArray(content)) throw new Error('MODEL_CONTENT_UNSUPPORTED');
  return content.flatMap(part => {
    if (typeof part === 'string') return [{ type: 'text' as const, text: part }];
    // Never expose arbitrary provider fields or private reasoning.
    if (part?.type === 'text' && typeof part.text === 'string') return [{ type: 'text' as const, text: part.text }];
    throw new Error('MODEL_CONTENT_UNSUPPORTED');
  });
}

function measured(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function validateToolArguments(value: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('MODEL_TOOL_ARGUMENTS_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MODEL_TOOL_ARGUMENTS_INVALID');
}

export function normalizeGatewayRequest(params: any): RuntimeRequest {
  if (!Array.isArray(params.messages)) throw new Error('MODEL_MESSAGES_REQUIRED');
  const { model, messages, tools, max_tokens, stream: _stream, ...tuning } = params;
  return {
    modelId: model,
    messages: messages.map((message: any): RuntimeMessage => ({
      role: message.role, content: textBlocks(message.content),
      toolCallId: message.tool_call_id,
      toolCalls: message.tool_calls?.map((tool: any) => ({ id: tool.id, name: tool.function.name, arguments: tool.function.arguments })),
    })),
    tools: tools?.map((tool: any) => ({ name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters })),
    maxOutputTokens: max_tokens, tuning,
  };
}

export function toGatewayRequest(request: RuntimeRequest, capabilities: RuntimeCapabilities): any {
  return {
    ...request.tuning, model: request.modelId,
    messages: request.messages.map(message => {
      if (message.role === 'tool' && !message.toolCallId) throw new Error('MODEL_TOOL_RESULT_MISSING_ID');
      const content = message.content.map(block => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        if (block.type === 'artifact_reference') return { type: 'text', text: `[Artifact ${block.artifactId}] ${block.label}` };
        if (capabilities.imageInput !== 'supported') throw new Error('PROVIDER_IMAGE_INPUT_UNSUPPORTED');
        return { type: 'image_url', image_url: { url: block.uri } };
      });
      const onlyText = content.every(block => block.type === 'text');
      return {
        role: message.role,
        content: onlyText ? content.map(block => 'text' in block ? block.text : '').join('') : content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(tool => ({
          id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments },
        })) } : {}),
      };
    }),
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({
      type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    })) } : {}),
    ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
  };
}

export class ProviderDriver {
  readonly capabilities: RuntimeCapabilities;
  private sequence = 0;
  constructor(private readonly transport: GatewayTransport, private readonly modelId: string, private readonly options: ProviderDriverOptions) {
    this.capabilities = transport.runtimeCapabilitiesFor?.(modelId)
      ?? defaultRuntimeCapabilities(transport.providerFor(modelId) === 'copilot' ? 'provider_loop' : 'host_loop');
  }
  private emit(payload: EventPayload): void {
    this.options.onEvent?.({ ...this.options.identity, schemaVersion: 1, sequence: ++this.sequence, ...payload } as RuntimeEvent);
  }
  async complete(request: RuntimeRequest, signal: AbortSignal): Promise<RuntimeResponse> {
    return (await this.completeWithLegacy(request, signal)).response;
  }
  /** Compatibility adapter during staged migration; Core consumes response only. */
  async completeWithLegacy(request: RuntimeRequest, signal: AbortSignal): Promise<{ response: RuntimeResponse; legacy: any }> {
    if (request.modelId !== this.modelId) throw new Error('PROVIDER_MODEL_ID_MISMATCH');
    if (signal.aborted) throw new Error('Request aborted');
    const params = toGatewayRequest(request, this.capabilities);
    let toolCallCount = 0;
    this.emit({ type: 'request.started', modelId: request.modelId });
    try {
      const legacy = await this.transport.completeForModel(this.modelId, params, {
        signal, timeoutMs: this.options.timeoutMs, idleTimeoutMs: this.options.idleTimeoutMs, providerSession: this.options.providerSession,
        ...(this.options.onDelta || this.options.onEvent ? { onDelta: (text: string) => {
          if (signal.aborted) return;
          this.options.onDelta?.(text);
          this.emit({ type: 'assistant.delta', text });
        } } : {}),
        ...(this.options.onToolCall ? { onToolCall: async call => {
          if (signal.aborted || call.signal?.aborted) throw new Error('Request aborted');
          validateToolArguments(call.function.arguments);
          toolCallCount++;
          this.emit({ type: 'tool.started', toolCallId: call.id, toolName: call.function.name });
          try {
            const output = await this.options.onToolCall!(call);
            if (signal.aborted || call.signal?.aborted) throw new Error('Request aborted');
            this.emit({ type: 'tool.completed', toolCallId: call.id, toolName: call.function.name, status: 'done' });
            return output;
          } catch (error) {
            this.emit({ type: 'tool.completed', toolCallId: call.id, toolName: call.function.name, status: 'failed' });
            throw error;
          }
        } } : {}),
      });
      if (signal.aborted) throw new Error('Request aborted');
      const choice = legacy?.choices?.[0];
      if (!choice) throw new Error('AGENT_EMPTY_OUTPUT: no response from model');
      if (choice.message?.role !== 'assistant') throw new Error('MODEL_RESPONSE_ROLE_INVALID');
      const toolCalls = (choice.message.tool_calls || []).map((call: any) => ({
        id: call.id, name: call.function?.name, arguments: call.function?.arguments,
      }));
      if (toolCalls.some((call: any) => typeof call.id !== 'string' || typeof call.name !== 'string' || typeof call.arguments !== 'string')) {
        throw new Error('MODEL_TOOL_CALL_INVALID');
      }
      for (const call of toolCalls) validateToolArguments(call.arguments);
      const reason = ['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason) ? choice.finish_reason : 'unknown';
      const usage = legacy.usage || {};
      const costType = ['exact', 'estimated', 'subscription', 'unavailable'].includes(usage.cost_type)
        ? usage.cost_type : this.capabilities.executionMode === 'provider_loop' ? 'subscription' : 'unavailable';
      const response: RuntimeResponse = {
        content: textBlocks(choice.message.content), toolCalls, stopReason: reason,
        provider: usage.provider || this.transport.providerFor(this.modelId),
        actualModelId: usage.actual_model_id, costType, costUSD: measured(usage.cost_usd),
        metrics: {
          requestCount: 1,
          modelTurnCount: this.capabilities.executionMode === 'host_loop' ? 1 : null,
          toolCallCount: this.capabilities.executionMode === 'host_loop' ? toolCalls.length : toolCallCount,
          inputTokens: usage.input_tokens_observed === false ? null : measured(usage.prompt_tokens),
          outputTokens: usage.output_tokens_observed === false ? null : measured(usage.completion_tokens),
        },
      };
      this.emit({ type: 'assistant.completed', content: response.content });
      this.emit({ type: 'usage', metrics: response.metrics, costType, costUSD: response.costUSD });
      this.emit({ type: 'request.stopped', reason });
      return { response, legacy };
    } catch (error) {
      this.emit({ type: 'diagnostic', code: signal.aborted ? 'REQUEST_CANCELLED' : 'MODEL_REQUEST_FAILED',
        message: signal.aborted ? 'Request cancelled.' : 'Model request failed; inspect the governed server diagnostic.' });
      this.emit({ type: 'request.stopped', reason: signal.aborted ? 'cancelled' : 'failed' });
      throw error;
    }
  }
}
