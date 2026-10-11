import { parseAgentInputRequest, type AgentSessionEvent, type RuntimeMessage, type SessionConversationItem } from '@myrmecia/shared';

function ordered(events: readonly AgentSessionEvent[]): AgentSessionEvent[] {
  const unique = new Map<string, AgentSessionEvent>();
  const sequences = new Map<number, string>();
  let scope: string | undefined;
  for (const event of events) {
    const key = JSON.stringify([event.workspaceId, event.sessionId]);
    if (scope && scope !== key) throw new Error('SESSION_PROJECTION_SCOPE_MISMATCH');
    scope = key;
    const previous = unique.get(event.eventId);
    const atSequence = sequences.get(event.sequence);
    if ((previous && previous.payloadHash !== event.payloadHash)
      || (atSequence && atSequence !== event.eventId)) throw new Error('SESSION_PROJECTION_CONFLICT');
    unique.set(event.eventId, event);
    sequences.set(event.sequence, event.eventId);
  }
  return [...unique.values()].sort((left, right) => left.sequence - right.sequence);
}

/** Pure projection of the exact host request/SDK envelope, not private SDK internal turns. */
export function deriveModelMessages(events: readonly AgentSessionEvent[], requestId?: string): RuntimeMessage[] {
  let messages: RuntimeMessage[] = [];
  let activeRequest: string | undefined;
  for (const event of ordered(events)) {
    const payload = event.payload;
    if (payload.type === 'context.recorded' || payload.type === 'context.checkpoint') {
      if (requestId && event.requestId !== requestId) continue;
      messages = structuredClone(payload.messages);
      activeRequest = event.requestId;
      continue;
    }
    if (requestId && (activeRequest !== requestId || event.requestId !== requestId)) continue;
    if (payload.type === 'model.message') {
      messages.push({ role: payload.role, content: structuredClone(payload.content),
        toolCalls: payload.toolCalls ? structuredClone(payload.toolCalls) : undefined, toolCallId: payload.toolCallId });
    }
  }
  return messages;
}

/** UI history does not expose system prompts, compaction scaffolding or request tuning. */
export function deriveConversationView(events: readonly AgentSessionEvent[]): SessionConversationItem[] {
  const result = new Map<string, SessionConversationItem>();
  for (const event of ordered(events)) {
    const payload = event.payload;
    const base = { runId: event.runId, requestId: event.requestId, createdAt: event.createdAt };
    if (payload.type === 'user.submitted') {
      result.set(event.eventId, { ...base, id: event.eventId, role: 'user', content: payload.content });
    } else if (payload.type === 'inbox.submitted' || payload.type === 'inbox.applied') {
      const id = `inbox:${payload.inboxId}`;
      const previous = result.get(id);
      result.set(id, { ...base, createdAt: previous?.createdAt || base.createdAt, id, role: 'user', content: payload.content,
        state: payload.type === 'inbox.submitted' ? 'pending' : 'applied' });
    } else if (payload.type === 'inbox.delivery') {
      const item = result.get(`inbox:${payload.inboxId}`);
      if (item) result.set(item.id, { ...item, state: payload.status });
    } else if (payload.type === 'assistant.delta' || payload.type === 'assistant.completed') {
      const id = `assistant:${event.requestId || event.runId}`;
      const previous = result.get(id);
      const content = payload.type === 'assistant.delta' ? (previous?.content || '') + payload.text
        : payload.content.filter(block => block.type === 'text').map(block => block.text).join('');
      const question = payload.type === 'assistant.completed' ? parseAgentInputRequest(content) : undefined;
      result.set(id, { ...base, createdAt: previous?.createdAt || base.createdAt, id, role: 'assistant', content: question || content,
        state: question ? 'waiting_for_user' : payload.type === 'assistant.delta' ? 'streaming' : 'completed' });
    } else if (payload.type === 'model.message' && payload.role === 'assistant') {
      const id = `assistant:${event.requestId || event.runId}`;
      if (!result.has(id)) {
        const content = payload.content.filter(block => block.type === 'text').map(block => block.text).join('');
        result.set(id, { ...base, id, role: 'assistant', content: parseAgentInputRequest(content) || content, state: 'completed' });
      }
    } else if (payload.type === 'tool.started' || payload.type === 'tool.completed') {
      const id = `tool:${event.runId}:${payload.toolCallId}`;
      const previous = result.get(id);
      result.set(id, { ...base, createdAt: previous?.createdAt || base.createdAt, id, role: 'tool', content: '',
        toolName: payload.toolName, state: payload.type === 'tool.started' ? 'running' : payload.status });
    } else if (payload.type === 'diagnostic') {
      result.set(event.eventId, { ...base, id: event.eventId, role: 'diagnostic', content: payload.message, state: payload.code });
    }
  }
  return [...result.values()];
}
