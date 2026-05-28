import { EventEmitter } from 'events';
import { logger } from '../lib/logger.js';

export interface PubSubMessage {
  channel: string;
  data: unknown;
  sourceInstance: string;
}

type MessageHandler = (data: unknown, sourceInstance: string) => void;

interface PubSubBackend {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: MessageHandler): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  shutdown(): Promise<void>;
}

class LocalPubSub implements PubSubBackend {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  async publish(channel: string, message: string): Promise<void> {
    this.emitter.emit(channel, message);
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<void> {
    this.emitter.on(channel, (raw: string) => {
      try {
        const parsed = JSON.parse(raw) as PubSubMessage;
        handler(parsed.data, parsed.sourceInstance);
      } catch {}
    });
  }

  async unsubscribe(channel: string): Promise<void> {
    this.emitter.removeAllListeners(channel);
  }

  async shutdown(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

class RedisPubSubBackend implements PubSubBackend {
  private pub: import('ioredis').default | null = null;
  private sub: import('ioredis').default | null = null;
  private handlers = new Map<string, MessageHandler[]>();

  constructor(private redisUrl: string) {}

  private async ensureConnected() {
    if (this.pub) return;
    const { default: Redis } = await import('ioredis');
    this.pub = new Redis(this.redisUrl, { maxRetriesPerRequest: 3 });
    this.sub = new Redis(this.redisUrl, { maxRetriesPerRequest: 3 });

    this.sub.on('message', (channel: string, message: string) => {
      const handlers = this.handlers.get(channel) || [];
      try {
        const parsed = JSON.parse(message) as PubSubMessage;
        for (const h of handlers) {
          h(parsed.data, parsed.sourceInstance);
        }
      } catch {}
    });
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.ensureConnected();
    await this.pub!.publish(channel, message);
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<void> {
    await this.ensureConnected();
    const existing = this.handlers.get(channel);
    if (existing) {
      existing.push(handler);
    } else {
      this.handlers.set(channel, [handler]);
      await this.sub!.subscribe(channel);
    }
  }

  async unsubscribe(channel: string): Promise<void> {
    this.handlers.delete(channel);
    if (this.sub) await this.sub.unsubscribe(channel);
  }

  async shutdown(): Promise<void> {
    if (this.sub) { this.sub.disconnect(); this.sub = null; }
    if (this.pub) { this.pub.disconnect(); this.pub = null; }
    this.handlers.clear();
  }
}

export class RedisPubSub {
  private backend: PubSubBackend;
  public readonly instanceId: string;

  constructor(instanceId: string) {
    this.instanceId = instanceId;
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      logger.info('PubSub: using Redis backend');
      this.backend = new RedisPubSubBackend(redisUrl);
    } else {
      logger.info('PubSub: using local EventEmitter (single-instance mode)');
      this.backend = new LocalPubSub();
    }
  }

  async publish(channel: string, event: unknown): Promise<void> {
    const message: PubSubMessage = {
      channel,
      data: event,
      sourceInstance: this.instanceId,
    };
    await this.backend.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<void> {
    await this.backend.subscribe(channel, handler);
  }

  async unsubscribe(channel: string): Promise<void> {
    await this.backend.unsubscribe(channel);
  }

  async shutdown(): Promise<void> {
    await this.backend.shutdown();
  }
}

const INSTANCE_ID = `inst_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;

export const pubsub = new RedisPubSub(INSTANCE_ID);
export { INSTANCE_ID };
