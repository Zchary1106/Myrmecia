import { EventEmitter } from 'events';
import type { WSEventType } from '../types.js';

export interface BusEvent {
  type: WSEventType;
  payload: unknown;
  timestamp: string;
}

class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(type: WSEventType, payload: unknown) {
    const event: BusEvent = { type, payload, timestamp: new Date().toISOString() };
    this.emitter.emit(type, event);
    this.emitter.emit('*', event); // wildcard for WS bridge
  }

  on(type: WSEventType | '*', handler: (event: BusEvent) => void) {
    this.emitter.on(type, handler);
  }

  off(type: WSEventType | '*', handler: (event: BusEvent) => void) {
    this.emitter.off(type, handler);
  }
}

// Singleton
export const eventBus = new EventBus();
