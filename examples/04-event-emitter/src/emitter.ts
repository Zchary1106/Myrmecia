export type EventMap = Record<string, unknown>;

export type EventHandler<Payload> = (payload: Payload) => void;

export interface Emitter<Events extends EventMap> {
  on<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): () => void;
  once<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): () => void;
  off<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): void;
  emit<K extends keyof Events>(event: K, payload: Events[K]): void;
  removeAllListeners(event?: keyof Events): void;
}

export function createEmitter<Events extends EventMap>(): Emitter<Events> {
  const listeners = new Map<keyof Events, Set<EventHandler<Events[keyof Events]>>>();

  const on = <K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): (() => void) => {
    const eventListeners = listeners.get(event);

    if (eventListeners) {
      eventListeners.add(handler as EventHandler<Events[keyof Events]>);
    } else {
      listeners.set(event, new Set([handler as EventHandler<Events[keyof Events]>]));
    }

    return () => {
      off(event, handler);
    };
  };

  const once = <K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): (() => void) => {
    let isSubscribed = true;

    const wrappedHandler: EventHandler<Events[K]> = (payload) => {
      if (!isSubscribed) {
        return;
      }

      isSubscribed = false;
      off(event, wrappedHandler);
      handler(payload);
    };

    on(event, wrappedHandler);

    return () => {
      if (!isSubscribed) {
        return;
      }

      isSubscribed = false;
      off(event, wrappedHandler);
    };
  };

  const off = <K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): void => {
    const eventListeners = listeners.get(event);

    if (!eventListeners) {
      return;
    }

    eventListeners.delete(handler as EventHandler<Events[keyof Events]>);

    if (eventListeners.size === 0) {
      listeners.delete(event);
    }
  };

  const emit = <K extends keyof Events>(event: K, payload: Events[K]): void => {
    const eventListeners = listeners.get(event);

    if (!eventListeners || eventListeners.size === 0) {
      return;
    }

    const handlers = Array.from(eventListeners) as Array<EventHandler<Events[K]>>;
    const errors: unknown[] = [];

    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, `Multiple errors occurred while emitting event ${String(event)}`);
    }
  };

  const removeAllListeners = (event?: keyof Events): void => {
    if (typeof event === 'undefined') {
      listeners.clear();
      return;
    }

    listeners.delete(event);
  };

  return {
    on,
    once,
    off,
    emit,
    removeAllListeners,
  };
}
