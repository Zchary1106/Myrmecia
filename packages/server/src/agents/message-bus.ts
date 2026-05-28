import { getDb } from '../db/database.js';
import type { AgentMessage, AgentMessageType } from '../types.js';
import { eventBus } from '../events/event-bus.js';
import { getExecution } from '../db/models/execution.js';
import { createInboxEntry } from '../db/models/inbox.js';
import { createNotification } from '../db/models/notification.js';

/**
 * Agent Message Bus — inter-agent mailbox communication
 * Inspired by Claude Code's SendMessageTool + pendingMessages queue.
 * Messages are queued and consumed at tool-round boundaries.
 */
export class AgentMessageBus {

  /** Send a message from one execution to another */
  send(fromExecution: string | null, toExecution: string, messageType: AgentMessageType, content: string): AgentMessage {
    const db = getDb();
    const result = db.run(`
      INSERT INTO agent_messages (from_execution, to_execution, message_type, content)
      VALUES (?, ?, ?, ?)
    `, fromExecution, toExecution, messageType, content);

    const msg: AgentMessage = {
      id: Number(result.lastInsertRowid),
      fromExecution: fromExecution || undefined,
      toExecution,
      messageType,
      content,
      consumed: false,
      createdAt: new Date().toISOString(),
    };

    eventBus.emit('agent:message', { message: msg });
    if (messageType === 'approval_request') {
      const sourceExecution = fromExecution ? getExecution(fromExecution) : undefined;
      const targetExecution = getExecution(toExecution);
      const entry = createInboxEntry({
        type: 'approval',
        title: 'Agent approval request',
        message: content,
        options: ['Approve', 'Reject'],
        taskId: sourceExecution?.taskId || targetExecution?.taskId,
        executionId: fromExecution || toExecution,
        createdBy: 'agent',
      });
      const notification = createNotification({
        type: 'needs_input',
        title: entry.title,
        message: entry.message,
        taskId: entry.taskId,
      });
      eventBus.emit('inbox:created', { inboxEntryId: entry.id, entry });
      eventBus.emit('notification', { notification });
    }
    return msg;
  }

  /** Broadcast a message to all running executions */
  broadcast(fromExecution: string, messageType: AgentMessageType, content: string): void {
    const db = getDb();
    const executions = db.all(
      "SELECT id FROM task_executions WHERE status = 'running' AND id != ?",
      fromExecution
    ) as { id: string }[];

    for (const exec of executions) {
      this.send(fromExecution, exec.id, messageType, content);
    }
  }

  /** Drain (consume) all pending messages for an execution */
  drain(executionId: string): AgentMessage[] {
    const db = getDb();
    const rows = db.all(
      'SELECT * FROM agent_messages WHERE to_execution = ? AND consumed = 0 ORDER BY id ASC',
      executionId
    ) as any[];

    if (rows.length > 0) {
      db.run(
        'UPDATE agent_messages SET consumed = 1 WHERE to_execution = ? AND consumed = 0',
        executionId
      );
    }

    return rows.map(row => ({
      id: row.id,
      fromExecution: row.from_execution || undefined,
      toExecution: row.to_execution,
      messageType: row.message_type,
      content: row.content,
      consumed: true,
      createdAt: row.created_at,
    }));
  }

  /** Get pending message count for an execution */
  pendingCount(executionId: string): number {
    const db = getDb();
    const row = db.get(
      'SELECT COUNT(*) as count FROM agent_messages WHERE to_execution = ? AND consumed = 0',
      executionId
    ) as any;
    return row?.count || 0;
  }

  /** List all messages for an execution (both sent and received) */
  listForExecution(executionId: string): AgentMessage[] {
    const db = getDb();
    const rows = db.all(
      'SELECT * FROM agent_messages WHERE from_execution = ? OR to_execution = ? ORDER BY id ASC',
      executionId, executionId
    ) as any[];

    return rows.map(row => ({
      id: row.id,
      fromExecution: row.from_execution || undefined,
      toExecution: row.to_execution,
      messageType: row.message_type,
      content: row.content,
      consumed: !!row.consumed,
      createdAt: row.created_at,
    }));
  }
}

export const messageBus = new AgentMessageBus();
