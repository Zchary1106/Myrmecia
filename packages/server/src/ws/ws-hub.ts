import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { eventBus, type BusEvent } from '../events/event-bus.js';
import type { WSCommand, WSEventType } from '../types.js';
import { isApiAuthEnabled, isTokenAuthorized, tokenFromAuthorizationHeader } from '../auth/token-auth.js';

interface ClientState {
  ws: WebSocket;
  channels: Set<string>;
}

export class WSHub {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientState>();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      if (isApiAuthEnabled()) {
        const requestUrl = new URL(req.url || '/ws', 'http://localhost');
        const token = requestUrl.searchParams.get('token') || tokenFromAuthorizationHeader(req.headers.authorization);
        if (!isTokenAuthorized(token || undefined)) {
          ws.close(1008, 'AUTH_REQUIRED');
          return;
        }
      }

      const state: ClientState = { ws, channels: new Set() };
      this.clients.set(ws, state);

      ws.on('message', (raw) => {
        try {
          const cmd: WSCommand = JSON.parse(raw.toString());
          if (cmd.type === 'subscribe') state.channels.add(cmd.channel);
          else if (cmd.type === 'unsubscribe') state.channels.delete(cmd.channel);
        } catch {}
      });

      ws.on('close', () => this.clients.delete(ws));
    });

    // Bridge all events from EventBus to subscribed WS clients
    eventBus.on('*', (event: BusEvent) => {
      const channels = this.getChannelsForEvent(event);
      for (const [, client] of this.clients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        const subscribed = channels.some(ch => client.channels.has(ch));
        if (subscribed) {
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
    return channels;
  }

  broadcast(event: BusEvent) {
    const msg = JSON.stringify(event);
    for (const [, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
