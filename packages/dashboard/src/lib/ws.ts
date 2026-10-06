import type { WSEvent, WSCommand } from '@myrmecia/shared';
import { getApiAuthToken } from './auth';

type EventHandler = (event: WSEvent) => void;

export class WSClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private channels = new Set<string>();
  private reconnectTimer: number | null = null;
  private shouldReconnect = false;
  private connectedHandlers = new Set<() => void>();

  connect() {
    this.shouldReconnect = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getApiAuthToken();
    const url = `${protocol}//${window.location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;

    this.ws = new WebSocket(url);
    const socket = this.ws;

    this.ws.onopen = () => {
      if (this.ws !== socket || !this.shouldReconnect) return;
      console.log('[WS] Connected');
      // Re-subscribe
      for (const ch of this.channels) {
        this.sendCommand({ type: 'subscribe', channel: ch });
      }
      for (const handler of this.connectedHandlers) handler();
    };

    this.ws.onmessage = (e) => {
      if (this.ws !== socket || !this.shouldReconnect) return;
      try {
        const event = JSON.parse(e.data);
        if (!event?.type) {
          console.warn('[WS] Ignoring event without type', event);
          return;
        }
        // Dispatch to handlers by event type
        const typeHandlers = this.handlers.get(event.type);
        if (typeHandlers) {
          for (const h of typeHandlers) h(event);
        }
        // Wildcard handlers
        const allHandlers = this.handlers.get('*');
        if (allHandlers) {
          for (const h of allHandlers) h(event);
        }
      } catch (err) {
        console.warn('[WS] Failed to process message', err);
      }
    };

    this.ws.onclose = () => {
      if (this.ws !== socket || !this.shouldReconnect) return;
      console.log('[WS] Disconnected, reconnecting...');
      this.reconnectTimer = window.setTimeout(() => this.connect(), 2000);
    };
  }

  onConnected(handler: () => void): () => void {
    this.connectedHandlers.add(handler);
    return () => { this.connectedHandlers.delete(handler); };
  }

  subscribe(channel: string) {
    this.channels.add(channel);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendCommand({ type: 'subscribe', channel });
    }
  }

  unsubscribe(channel: string) {
    this.channels.delete(channel);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendCommand({ type: 'unsubscribe', channel });
    }
  }

  on(eventType: string, handler: EventHandler) {
    if (!this.handlers.has(eventType)) this.handlers.set(eventType, new Set());
    this.handlers.get(eventType)!.add(handler);
  }

  off(eventType: string, handler: EventHandler) {
    this.handlers.get(eventType)?.delete(handler);
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private sendCommand(command: WSCommand) {
    this.ws?.send(JSON.stringify(command));
  }
}

export const wsClient = new WSClient();
