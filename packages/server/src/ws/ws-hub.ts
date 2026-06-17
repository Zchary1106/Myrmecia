import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { eventBus, type BusEvent } from '../events/event-bus.js';
import type { WSCommand } from '../types.js';
import { resolveApiAuthContext, tokenFromAuthorizationHeader, type ApiAuthContext } from '../auth/token-auth.js';
import { getTask } from '../db/models/task.js';
import { getPipeline } from '../db/models/pipeline.js';
import { getExecution } from '../db/models/execution.js';

interface ClientState {
  ws: WebSocket;
  channels: Set<string>;
  auth: ApiAuthContext;
  workspaceId: string;
}

export class WSHub {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientState>();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      const requestUrl = new URL(req.url || '/ws', 'http://localhost');
      const token = requestUrl.searchParams.get('token') || tokenFromAuthorizationHeader(req.headers.authorization);
      const auth = resolveApiAuthContext(token || undefined);
      if (!auth) {
        ws.close(1008, 'AUTH_REQUIRED');
        return;
      }

      const requestedWorkspaceId = requestUrl.searchParams.get('workspaceId') || auth.workspaceId;
      if (auth.kind === 'api-key' && requestedWorkspaceId !== auth.workspaceId) {
        ws.close(1008, 'WORKSPACE_FORBIDDEN');
        return;
      }

      const state: ClientState = { ws, channels: new Set(), auth, workspaceId: requestedWorkspaceId || 'default' };
      this.clients.set(ws, state);

      ws.on('message', (raw) => {
        try {
          const cmd: WSCommand = JSON.parse(raw.toString());
          if (cmd.type === 'subscribe') {
            if (!this.canSubscribe(state, cmd.channel)) {
              ws.close(1008, 'CHANNEL_FORBIDDEN');
              return;
            }
            state.channels.add(cmd.channel);
          }
          else if (cmd.type === 'unsubscribe') state.channels.delete(cmd.channel);
        } catch {
          ws.close(1003, 'INVALID_COMMAND');
        }
      });

      ws.on('close', () => this.clients.delete(ws));
    });

    // Bridge all events from EventBus to subscribed WS clients
    eventBus.on('*', (event: BusEvent) => {
      const channels = this.getChannelsForEvent(event);
      for (const [, client] of this.clients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        const subscribed = channels.some(ch => client.channels.has(ch));
        if (subscribed && this.canReceiveEvent(client, event)) {
          client.ws.send(JSON.stringify(event));
        }
      }
    });
  }

  // Map event types to channels
  private getChannelsForEvent(event: BusEvent): string[] {
    const channels: string[] = [];
    const p = event.payload as any;

    if (event.type.startsWith('task:')) {
      channels.push('tasks');
      if (p?.taskId) channels.push(`task:${p.taskId}`);
      if (p?.agentId) channels.push(`agent:${p.agentId}`);
    }
    if (event.type.startsWith('agent:')) {
      channels.push('agents');
      if (p?.agentId) channels.push(`agent:${p.agentId}`);
    }
    if (event.type.startsWith('pipeline:')) {
      channels.push('pipelines');
      if (p?.pipelineId) channels.push(`pipeline:${p.pipelineId}`);
    }
    if (event.type === 'notification') {
      channels.push('notifications');
    }
    if (event.type.startsWith('inbox:')) {
      channels.push('inbox');
      if (p?.inboxEntryId) channels.push(`inbox:${p.inboxEntryId}`);
    }
    if (event.type === 'quality:updated') {
      channels.push('quality');
      if (p?.taskId) channels.push(`task:${p.taskId}`);
    }
    // Execution events
    if (event.type.startsWith('execution:')) {
      channels.push('executions');
      if (p?.executionId) channels.push(`execution:${p.executionId}`);
      if (p?.taskId) channels.push(`task:${p.taskId}`);
      if (p?.agentDefId) channels.push(`agent:${p.agentDefId}`);
    }
    if (event.type.startsWith('tool:')) {
      channels.push('tools');
      if (p?.toolId) channels.push(`tool:${p.toolId}`);
      if (p?.executionId) channels.push(`execution:${p.executionId}`);
      if (p?.taskId) channels.push(`task:${p.taskId}`);
      if (p?.agentId) channels.push(`agent:${p.agentId}`);
    }
    if (event.type.startsWith('skill:')) {
      channels.push('skills');
      if (p?.skillId) channels.push(`skill:${p.skillId}`);
      if (p?.agentId) channels.push(`agent:${p.agentId}`);
    }
    // Agent inter-messages
    if (event.type === 'agent:message') {
      channels.push('agents');
      channels.push('executions');
    }
    // Visual graph workflows
    if (event.type.startsWith('graph:')) {
      channels.push('graphs');
      if (p?.workflowId) channels.push(`graph:${p.workflowId}`);
    }
    // Agent teams (parallel shared board)
    if (event.type.startsWith('team:')) {
      channels.push('teams');
      if (p?.runId) channels.push(`team:${p.runId}`);
    }
    // Token streaming from agent executions
    if (event.type.startsWith('token:')) {
      channels.push('executions');
      if (p?.executionId) channels.push(`execution:${p.executionId}`);
      if (p?.taskId) channels.push(`task:${p.taskId}`);
    }
    return channels;
  }

  private canSubscribe(client: ClientState, channel: string): boolean {
    const [kind, id] = channel.split(':', 2);
    if (!id) return true;
    if (!['task', 'pipeline', 'execution'].includes(kind)) return true;

    const workspaceId = this.workspaceIdForChannel(kind, id);
    if (!workspaceId) return false;
    return workspaceId === client.workspaceId;
  }

  private workspaceIdForChannel(kind: string, id: string): string | undefined {
    if (kind === 'task') return getTask(id)?.workspaceId || 'default';
    if (kind === 'pipeline') return getPipeline(id)?.workspaceId || 'default';
    if (kind === 'execution') {
      const execution = getExecution(id);
      if (!execution) return undefined;
      return execution.workspaceId || getTask(execution.taskId)?.workspaceId || 'default';
    }
    return 'default';
  }

  private canReceiveEvent(client: ClientState, event: BusEvent): boolean {
    const workspaceId = this.workspaceIdForEvent(event);
    if (!workspaceId) return !this.isWorkspaceScopedEvent(event);
    return workspaceId === client.workspaceId;
  }

  private workspaceIdForEvent(event: BusEvent): string | undefined {
    const p = event.payload as any;
    if (p?.workspaceId) return p.workspaceId;
    if (p?.task?.workspaceId) return p.task.workspaceId;
    if (p?.pipeline?.workspaceId) return p.pipeline.workspaceId;
    if (p?.taskId) return getTask(p.taskId)?.workspaceId || 'default';
    if (p?.pipelineId) return getPipeline(p.pipelineId)?.workspaceId || 'default';
    if (p?.executionId) {
      const execution = getExecution(p.executionId);
      if (!execution) return undefined;
      return execution.workspaceId || getTask(execution.taskId)?.workspaceId || 'default';
    }
    if (p?.entry?.workspaceId) return p.entry.workspaceId;
    if (p?.notification?.workspaceId) return p.notification.workspaceId;
    return undefined;
  }

  private isWorkspaceScopedEvent(event: BusEvent): boolean {
    return event.type.startsWith('task:')
      || event.type.startsWith('pipeline:')
      || event.type.startsWith('execution:')
      || event.type.startsWith('tool:')
      || event.type.startsWith('quality:')
      || event.type.startsWith('inbox:')
      || event.type === 'notification'
      || event.type === 'agent:message';
  }

  broadcast(event: BusEvent) {
    for (const [, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN && this.canReceiveEvent(client, event)) {
        client.ws.send(JSON.stringify(event));
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
