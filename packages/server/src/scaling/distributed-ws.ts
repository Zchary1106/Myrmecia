import type { Server } from 'http';
import { WSHub } from '../ws/ws-hub.js';
import { eventBus, type BusEvent } from '../events/event-bus.js';
import { pubsub, INSTANCE_ID } from './redis-pubsub.js';
import { logger } from '../lib/logger.js';

const WS_BROADCAST_CHANNEL = 'af:ws:broadcast';

/**
 * Creates a distributed WSHub that bridges local WebSocket clients
 * with other instances via Redis pub/sub.
 */
export async function createDistributedWSHub(server: Server): Promise<WSHub> {
  const wsHub = new WSHub(server);

  // When a local event fires, publish to Redis so other instances can broadcast
  eventBus.on('*', (event: BusEvent) => {
    pubsub.publish(WS_BROADCAST_CHANNEL, event).catch(() => {});
  });

  // When a Redis message arrives from another instance, broadcast to local WS clients
  await pubsub.subscribe(WS_BROADCAST_CHANNEL, (data, sourceInstance) => {
    if (sourceInstance === INSTANCE_ID) return; // skip own messages
    const event = data as BusEvent;
    wsHub.broadcast(event);
  });

  logger.info({ instanceId: INSTANCE_ID }, 'Distributed WSHub initialized');
  return wsHub;
}
