// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WSClient } from '../src/lib/ws';

class FakeSocket {
  static OPEN = 1; static CONNECTING = 0; static instances: FakeSocket[] = [];
  readyState = 0;
  onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: string }) => void;
  send = vi.fn();
  constructor(_url: string) { FakeSocket.instances.push(this); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
}
beforeEach(() => {
  vi.useFakeTimers(); FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('WebSocket lifecycle', () => {
  it('replays state and resubscribes on reconnect, but not after intentional disconnect', () => {
    const client = new WSClient(), connected = vi.fn();
    client.onConnected(connected); client.subscribe('executions'); client.connect();
    FakeSocket.instances[0].open();
    expect(connected).toHaveBeenCalledOnce();
    FakeSocket.instances[0].close();
    vi.advanceTimersByTime(2000);
    FakeSocket.instances[1].open();
    expect(connected).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances[1].send).toHaveBeenCalledWith('{"type":"subscribe","channel":"executions"}');
    client.disconnect(); vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores events from stale or disconnected sockets', () => {
    const client = new WSClient(), handler = vi.fn();
    client.on('execution:message', handler); client.connect();
    const old = FakeSocket.instances[0];
    old.open(); old.close(); vi.advanceTimersByTime(2000);
    old.onmessage?.({ data: '{"type":"execution:message","payload":{}}' });
    client.disconnect();
    FakeSocket.instances[1].onmessage?.({ data: '{"type":"execution:message","payload":{}}' });
    expect(handler).not.toHaveBeenCalled();
  });
});
