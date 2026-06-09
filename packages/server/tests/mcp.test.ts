/**
 * MCP integration tests against a mock stdio MCP server.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { McpManager, parseMcpServersEnv } from '../src/tools/mcp-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = join(__dirname, 'fixtures', 'mock-mcp-server.mjs');

let manager: McpManager | null = null;
afterEach(() => { manager?.dispose(); manager = null; });

describe('parseMcpServersEnv', () => {
  it('parses a valid JSON array and ignores invalid entries', () => {
    const cfg = parseMcpServersEnv(JSON.stringify([
      { name: 'a', command: 'node', args: ['x.js'] },
      { name: 'bad' }, // missing command → filtered
    ]));
    expect(cfg.length).toBe(1);
    expect(cfg[0].name).toBe('a');
  });

  it('returns [] on garbage', () => {
    expect(parseMcpServersEnv('not json')).toEqual([]);
  });
});

describe('McpManager', () => {
  it('connects, lists tools, and calls a tool', async () => {
    manager = new McpManager();
    await manager.init([{ name: 'mock', command: process.execPath, args: [MOCK] }]);

    const servers = manager.servers();
    expect(servers.length).toBe(1);
    expect(servers[0].connected).toBe(true);

    const tools = manager.listTools();
    const names = tools.map(t => t.qualifiedName);
    expect(names).toContain('mcp__mock__echo');
    expect(names).toContain('mcp__mock__add');

    const echo = await manager.callTool('mcp__mock__echo', { text: 'hello mcp' });
    expect(JSON.stringify(echo.content)).toContain('hello mcp');

    const add = await manager.callTool('mcp__mock__add', { a: 2, b: 3 });
    expect(JSON.stringify(add.content)).toContain('5');
  });

  it('throws for unknown server', async () => {
    manager = new McpManager();
    await expect(manager.callTool('mcp__nope__x', {})).rejects.toThrow(/not connected/);
  });
});
