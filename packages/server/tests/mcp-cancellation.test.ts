import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '../src/tools/mcp-client.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const write = vi.fn();
  const client = new McpClient({ name: 'fixture', command: 'not-executed' });
  (client as any).proc = { stdin: { write }, kill: vi.fn() };
  return { client, write };
}
describe('MCP cancellation lifecycle', () => {
  it('sends cancellation, cleans listeners/timers and ignores a late response', async () => {
    vi.useFakeTimers();
    const { client, write } = fixture();
    const controller = new AbortController();
    const pending = client.callTool('read', {}, 60000, controller.signal);
    const rejection = expect(pending).rejects.toThrow('Request aborted');
    controller.abort();
    await rejection;
    expect(write.mock.calls.map(call => JSON.parse(call[0]).method)).toEqual(['tools/call', 'notifications/cancelled']);
    (client as any).onData(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"content":"late"}}\n'));
    expect((client as any).pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not dispatch an already-cancelled request', async () => {
    const { client, write } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(client.callTool('write', {}, 1000, controller.signal)).rejects.toThrow('aborted');
    expect(write).not.toHaveBeenCalled();
  });
  it('settles pending calls when the shared client is disposed', async () => {
    vi.useFakeTimers();
    const { client } = fixture();
    const pending = client.callTool('read');
    const rejection = expect(pending).rejects.toThrow('disposed');
    client.dispose(); await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
