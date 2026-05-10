import { eventBus, type BusEvent } from './event-bus.js';
import { recordPlatformEvent } from '../db/models/platform-event.js';

export class EventRecorder {
  private handler = (event: BusEvent) => {
    try {
      recordPlatformEvent(event);
    } catch (err: any) {
      console.warn(`[event-recorder] Failed to persist ${event.type}: ${err.message}`);
    }
  };

  start() {
    eventBus.on('*', this.handler);
  }

  stop() {
    eventBus.off('*', this.handler);
  }
}
