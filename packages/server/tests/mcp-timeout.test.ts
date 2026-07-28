import { describe, expect, it, afterEach } from 'vitest';
import { McpManager, resetMcpManager } from '../src/tools/mcp-manager.js';

/**
 * The agent loop computes a budget-aware timeout for every MCP tool call
 * (so one slow remote server cannot eat an entire execution's wall clock).
 * These tests pin that the timeout actually reaches the MCP client instead of
 * being silently dropped on the way down.
 */
describe('MCP tool call timeout propagation', () => {
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
