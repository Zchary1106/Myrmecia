import type { NormalizedContentBlock, RuntimeEvent, RuntimeMessage, RuntimeToolCall } from './runtime-protocol.js';

export type AgentSessionPayload =
  | { type: 'user.submitted'; taskId: string; content: string }
  | { type: 'context.recorded'; projectionVersion: 1; kind: 'host_request' | 'provider_envelope';
    modelId: string; messages: RuntimeMessage[]; toolsFingerprint: string; configFingerprint: string }
  | { type: 'context.checkpoint'; projectionVersion: 1; messages: RuntimeMessage[];
    developmentStage?: DevelopmentStageState;
    skillSteps?: Array<{ name: string; status: 'done' | 'failed' | 'skipped'; output?: string; retries: number; validationOutput?: string }> }
  | { type: 'model.message'; role: 'assistant' | 'tool'; content: NormalizedContentBlock[];
    toolCalls?: RuntimeToolCall[]; toolCallId?: string }
  | { type: 'inbox.submitted'; inboxId: string; mode: AgentInboxMode; content: string }
  | { type: 'inbox.applied'; inboxId: string; mode: AgentInboxMode; content: string }
  | { type: 'inbox.delivery'; inboxId: string; status: AgentInboxStatus; reason?: string }
  | RuntimeEvent;

export interface AgentSessionEvent {
  eventId: string;
  schemaVersion: 1;
  workspaceId: string;
  sessionId: string;
  sequence: number;
  eventKey: string;
  runId: string;
  requestId?: string;
  type: AgentSessionPayload['type'];
  payload: AgentSessionPayload;
  payloadHash: string;
  createdAt: string;
}

export type AgentInboxMode = 'steer' | 'follow_up';
export type AgentInboxStatus = 'pending' | 'claimed' | 'applied' | 'acknowledged' | 'rejected';
export interface AgentInboxEntry {
  id: string;
  workspaceId: string;
  sessionId: string;
  targetExecutionId: string;
  sourceMessageId?: number;
  userMessageId?: number;
  idempotencyKey: string;
  mode: AgentInboxMode;
  content: string;
  status: AgentInboxStatus;
  claimOwner?: string;
  claimUntil?: number;
  appliedEventId?: string;
  acknowledgedRequestId?: string;
  assignedTaskId?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionConversationItem {
  id: string;
  runId: string;
  requestId?: string;
  role: 'user' | 'assistant' | 'tool' | 'diagnostic';
  content: string;
  toolName?: string;
  state?: string;
  createdAt: string;
}
import type { DevelopmentStageState } from './agent-run.js';
