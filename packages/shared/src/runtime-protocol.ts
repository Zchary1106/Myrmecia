/** Observable runtime protocol. Private model reasoning and credentials are excluded. */
export interface RuntimeCapabilities {
  schemaVersion: 1;
  executionMode: 'host_loop' | 'provider_loop';
  textStreaming: boolean;
  hostToolBatch: boolean;
  steeringBoundary: 'host_turn' | 'request_boundary' | 'unsupported';
  providerSessionResume: boolean;
  usage: 'reported' | 'estimated' | 'unknown';
  imageInput: 'supported' | 'unsupported' | 'unknown';
  audioInput: 'supported' | 'unsupported' | 'unknown';
  toolArgumentStreaming: boolean;
  contextWindowTokens: number | null;
}

export type NormalizedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; uri: string; mediaType?: string }
  | { type: 'artifact_reference'; artifactId: string; label: string };

export interface RuntimeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface RuntimeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: NormalizedContentBlock[];
  toolCalls?: RuntimeToolCall[];
  toolCallId?: string;
}

export interface RuntimeToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface RuntimeRequest {
  modelId: string;
  messages: RuntimeMessage[];
  tools?: RuntimeToolDefinition[];
  maxOutputTokens?: number;
  tuning?: Record<string, unknown>;
}

export interface TurnMetrics {
  requestCount: number;
  /** null means the provider-owned internal loop does not expose this metric. */
  modelTurnCount: number | null;
  toolCallCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface RuntimeResponse {
  content: NormalizedContentBlock[];
  toolCalls: RuntimeToolCall[];
  stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';
  metrics: TurnMetrics;
  provider: string;
  actualModelId?: string;
  costType: 'exact' | 'estimated' | 'subscription' | 'unavailable';
  costUSD: number | null;
}

export interface RuntimeEventIdentity {
  schemaVersion: 1;
  workspaceId: string;
  conversationId: string;
  runId: string;
  requestId: string;
  sequence: number;
}

export type RuntimeEvent = RuntimeEventIdentity & (
  | { type: 'request.started'; modelId: string }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.completed'; content: NormalizedContentBlock[] }
  | { type: 'tool.started'; toolCallId: string; toolName: string }
  | { type: 'tool.completed'; toolCallId: string; toolName: string; status: 'done' | 'failed' }
  | { type: 'usage'; metrics: TurnMetrics; costType: RuntimeResponse['costType']; costUSD: number | null }
  | { type: 'diagnostic'; code: string; message: string }
  | { type: 'request.stopped'; reason: RuntimeResponse['stopReason'] | 'cancelled' | 'failed' }
);

export function defaultRuntimeCapabilities(executionMode: RuntimeCapabilities['executionMode']): RuntimeCapabilities {
  return {
    schemaVersion: 1, executionMode, textStreaming: true,
    hostToolBatch: executionMode === 'host_loop',
    steeringBoundary: executionMode === 'host_loop' ? 'host_turn' : 'request_boundary',
    providerSessionResume: false, usage: 'unknown',
    imageInput: 'unknown', audioInput: 'unsupported',
    toolArgumentStreaming: false, contextWindowTokens: null,
  };
}
