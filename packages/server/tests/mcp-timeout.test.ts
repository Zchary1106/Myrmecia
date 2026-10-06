import { describe, expect, it, afterEach, vi } from 'vitest';
import { McpManager, resetMcpManager } from '../src/tools/mcp-manager.js';

/**
 * The agent loop computes a budget-aware timeout for every MCP tool call
 * (so one slow remote server cannot eat an entire execution's wall clock).
 * These tests pin that the timeout actually reaches the MCP client instead of
 * being silently dropped on the way down.
 */
describe('MCP tool call timeout propagation', () => {
  it('does not interrupt connected servers and rejects unknown reconnect targets', async () => {
    const manager = new McpManager();
    const client = { isConnected: () => true };
    (manager as any).clients.set('connected', client);
    const connect = vi.spyOn(manager, 'addServer');
    expect(await manager.reconnectServer('connected')).toBe(client);
    expect(connect).not.toHaveBeenCalled();
    await expect(manager.reconnectServer('unknown')).rejects.toThrow('not configured');
  });

  it('shares a single connection attempt between simultaneous reconnect requests', async () => {
    const manager = new McpManager();
    (manager as any).startupConfigs.set('retry', { name: 'retry', command: 'unused' });
    const client = { isConnected: () => true };
    const connect = vi.spyOn(manager, 'addServer').mockResolvedValue(client as any);
    const [first, second] = await Promise.all([manager.reconnectServer('retry'), manager.reconnectServer('retry')]);
    expect(first).toBe(client);
    expect(second).toBe(client);
    expect(connect).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    resetMcpManager();
  });

  it('forwards an explicit timeout from callTool to the client', async () => {
    const manager = new McpManager();
    const seen: Array<number | undefined> = [];
    (manager as any).clients.set('demo', {
      config: { name: 'demo' },
      isConnected: () => true,
      tools: [],
      serverInfo: {},
      callTool: async (_name: string, _args: unknown, timeoutMs?: number) => {
        seen.push(timeoutMs);
        return { content: 'ok' };
      },
    });

    await manager.callTool('mcp__demo__search', { q: 'x' }, 1234);
    expect(seen).toEqual([1234]);
  });

  it('leaves the timeout undefined when the caller does not specify one, so the client default applies', async () => {
    const manager = new McpManager();
    const seen: Array<number | undefined> = [];
    (manager as any).clients.set('demo', {
      config: { name: 'demo' },
      isConnected: () => true,
      tools: [],
      serverInfo: {},
      callTool: async (_name: string, _args: unknown, timeoutMs?: number) => {
        seen.push(timeoutMs);
        return { content: 'ok' };
      },
    });

    await manager.callTool('mcp__demo__search', { q: 'x' });
    expect(seen).toEqual([undefined]);
  });
});
