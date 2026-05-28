/**
 * Agent-to-Agent Collaboration Protocol (A2A)
 *
 * Defines standardized communication patterns between agents:
 * 1. Delegation — parent assigns sub-task to child agent
 * 2. Broadcast — agent notifies all interested parties
 * 3. Request/Response — agent asks another agent for information
 * 4. Vote — multiple agents vote on a decision
 *
 * Messages flow through a typed protocol with delivery guarantees.
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database.js';
import { eventBus } from '../events/event-bus.js';
import { logger } from '../lib/logger.js';

// ---------- Protocol Types ----------

export type MessageType =
  | 'delegate'        // Assign work to another agent
  | 'delegate_result' // Return result from delegated work
  | 'query'           // Ask a question
  | 'query_response'  // Answer to a query
  | 'broadcast'       // Notify all listeners
  | 'vote_request'    // Request votes from multiple agents
  | 'vote_cast'       // Individual vote
  | 'handoff'         // Transfer ownership of a task
  | 'progress';       // Status update

export type DeliveryStatus = 'pending' | 'delivered' | 'acknowledged' | 'failed' | 'expired';

export interface A2AMessage {
  id: string;
  type: MessageType;
  fromAgentId: string;
  fromExecutionId?: string;
  toAgentId: string | '*';  // '*' = broadcast
  toExecutionId?: string;
  correlationId?: string;   // Links request/response pairs
  payload: A2APayload;
  priority: 'low' | 'normal' | 'high';
  status: DeliveryStatus;
  expiresAt?: string;
  createdAt: string;
  deliveredAt?: string;
}

export type A2APayload =
  | DelegatePayload
  | DelegateResultPayload
  | QueryPayload
  | QueryResponsePayload
  | BroadcastPayload
  | VoteRequestPayload
  | VoteCastPayload
  | HandoffPayload
  | ProgressPayload;

export interface DelegatePayload {
  type: 'delegate';
  taskDescription: string;
  context?: string;
  constraints?: {
    timeout?: number;
    maxCost?: number;
    requiredTools?: string[];
  };
}

export interface DelegateResultPayload {
  type: 'delegate_result';
  output: string;
  success: boolean;
  costUSD?: number;
  durationMs?: number;
}

export interface QueryPayload {
  type: 'query';
  question: string;
  context?: string;
  responseFormat?: 'text' | 'json' | 'boolean';
}

export interface QueryResponsePayload {
  type: 'query_response';
  answer: string;
  confidence?: number;
}

export interface BroadcastPayload {
  type: 'broadcast';
  topic: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface VoteRequestPayload {
  type: 'vote_request';
  question: string;
  options: string[];
  quorum: number;       // Minimum votes needed
  deadline: string;     // ISO timestamp
}

export interface VoteCastPayload {
  type: 'vote_cast';
  choice: string;
  reasoning?: string;
}

export interface HandoffPayload {
  type: 'handoff';
  taskId: string;
  reason: string;
  context?: string;
}

export interface ProgressPayload {
  type: 'progress';
  stage: string;
  percent?: number;
  message: string;
}

// ---------- Schema ----------

export const A2A_SCHEMA = `
CREATE TABLE IF NOT EXISTS a2a_messages (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  from_execution_id TEXT,
  to_agent_id TEXT NOT NULL,
  to_execution_id TEXT,
  correlation_id TEXT,
  payload JSON NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','acknowledged','failed','expired')),
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_a2a_to_agent ON a2a_messages(to_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_a2a_correlation ON a2a_messages(correlation_id);
CREATE INDEX IF NOT EXISTS idx_a2a_from_agent ON a2a_messages(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_a2a_type ON a2a_messages(type);
`;

// ---------- Protocol Service ----------

export class A2AProtocol {

  /** Send a message from one agent to another */
  send(msg: Omit<A2AMessage, 'id' | 'status' | 'createdAt'>): A2AMessage {
    const db = getDb();
    const id = `a2a_${uuid().slice(0, 8)}`;
    const createdAt = new Date().toISOString();

    db.run(
      `INSERT INTO a2a_messages (id, type, from_agent_id, from_execution_id, to_agent_id, to_execution_id, correlation_id, payload, priority, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id, msg.type, msg.fromAgentId, msg.fromExecutionId || null,
      msg.toAgentId, msg.toExecutionId || null, msg.correlationId || null,
      JSON.stringify(msg.payload), msg.priority || 'normal',
      msg.expiresAt || null, createdAt
    );

    const message: A2AMessage = { id, status: 'pending', createdAt, ...msg };
    eventBus.emit('a2a:message' as any, { message });
    logger.debug({ id, type: msg.type, from: msg.fromAgentId, to: msg.toAgentId }, 'A2A message sent');
    return message;
  }

  /** Delegate a task to another agent */
  delegate(fromAgentId: string, toAgentId: string, task: DelegatePayload['taskDescription'], opts?: {
    fromExecutionId?: string;
    context?: string;
    timeout?: number;
    maxCost?: number;
  }): A2AMessage {
    return this.send({
      type: 'delegate',
      fromAgentId,
      fromExecutionId: opts?.fromExecutionId,
      toAgentId,
      correlationId: `del_${uuid().slice(0, 8)}`,
      payload: {
        type: 'delegate',
        taskDescription: task,
        context: opts?.context,
        constraints: { timeout: opts?.timeout, maxCost: opts?.maxCost },
      },
      priority: 'normal',
    });
  }

  /** Query another agent for information */
  query(fromAgentId: string, toAgentId: string, question: string, opts?: {
    fromExecutionId?: string;
    responseFormat?: 'text' | 'json' | 'boolean';
  }): A2AMessage {
    return this.send({
      type: 'query',
      fromAgentId,
      fromExecutionId: opts?.fromExecutionId,
      toAgentId,
      correlationId: `qry_${uuid().slice(0, 8)}`,
      payload: { type: 'query', question, responseFormat: opts?.responseFormat },
      priority: 'normal',
    });
  }

  /** Broadcast to all agents */
  broadcast(fromAgentId: string, topic: string, message: string, data?: Record<string, unknown>): A2AMessage {
    return this.send({
      type: 'broadcast',
      fromAgentId,
      toAgentId: '*',
      payload: { type: 'broadcast', topic, message, data },
      priority: 'low',
    });
  }

  /** Receive pending messages for an agent */
  receive(agentId: string, opts?: { type?: MessageType; limit?: number }): A2AMessage[] {
    const db = getDb();
    let sql = "SELECT * FROM a2a_messages WHERE (to_agent_id = ? OR to_agent_id = '*') AND status = 'pending'";
    const params: any[] = [agentId];

    if (opts?.type) { sql += ' AND type = ?'; params.push(opts.type); }
    sql += ' ORDER BY CASE priority WHEN \'high\' THEN 0 WHEN \'normal\' THEN 1 ELSE 2 END, created_at ASC';
    sql += ` LIMIT ?`;
    params.push(opts?.limit || 10);

    const rows = db.all(sql, ...params);
    return rows.map((row: any) => ({
      id: row.id,
      type: row.type,
      fromAgentId: row.from_agent_id,
      fromExecutionId: row.from_execution_id || undefined,
      toAgentId: row.to_agent_id,
      toExecutionId: row.to_execution_id || undefined,
      correlationId: row.correlation_id || undefined,
      payload: JSON.parse(row.payload),
      priority: row.priority,
      status: row.status,
      expiresAt: row.expires_at || undefined,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at || undefined,
    }));
  }

  /** Acknowledge receipt of a message */
  acknowledge(messageId: string): void {
    const db = getDb();
    db.run(
      "UPDATE a2a_messages SET status = 'acknowledged', delivered_at = ? WHERE id = ?",
      new Date().toISOString(), messageId
    );
  }

  /** Respond to a correlated message */
  respond(originalMessage: A2AMessage, payload: A2APayload, fromAgentId: string): A2AMessage {
    return this.send({
      type: payload.type as MessageType,
      fromAgentId,
      toAgentId: originalMessage.fromAgentId,
      toExecutionId: originalMessage.fromExecutionId,
      correlationId: originalMessage.correlationId,
      payload,
      priority: originalMessage.priority,
    });
  }

  /** Clean up expired messages */
  expireOld(): number {
    const db = getDb();
    const result = db.run(
      "UPDATE a2a_messages SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?",
      new Date().toISOString()
    );
    return result.changes;
  }
}

export const a2aProtocol = new A2AProtocol();
