import { eventBus, type BusEvent } from './event-bus.js';
import { recordPlatformEvent } from '../db/models/platform-event.js';
import { logger } from '../lib/logger.js';

export class EventRecorder {
  private handler = (event: BusEvent) => {
    try {
      recordPlatformEvent(event);
    } catch (err: any) {
      logger.warn({ type: event.type, err: err.message }, 'Failed to persist platform event');
    }
  };

  start() {
    eventBus.on('*', this.handler);
  }

  stop() {
    eventBus.off('*', this.handler);
  }
}
