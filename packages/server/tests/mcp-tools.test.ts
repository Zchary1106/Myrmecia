/**
 * Tests for the MCP → agent tool-loop bridge.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { McpManager } from '../src/tools/mcp-manager.js';
import { getMcpManager, resetMcpManager } from '../src/tools/mcp-manager.js';
import { getMcpToolDefinitions, executeMcpTool, mcpResultToString } from '../src/tools/mcp-tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = join(__dirname, 'fixtures', 'mock-mcp-server.mjs');

afterEach(() => { resetMcpManager(); });

describe('mcpResultToString', () => {
  it('flattens text content blocks', () => {
    expect(mcpResultToString([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(mcpResultToString('plain')).toBe('plain');
  });
});

describe('MCP tool-loop bridge', () => {
  it('builds model tool defs and executes via the manager', async () => {
    // Connect a server through the singleton manager (used by the bridge).
    const mgr = getMcpManager();
    await mgr.init([{ name: 'mock', command: process.execPath, args: [MOCK] }]);

    const { defs, nameToQualified } = getMcpToolDefinitions();
    const names = defs.map(d => d.function.name);
    expect(names).toContain('mcp__mock__echo');
    expect(nameToQualified.get('mcp__mock__echo')).toBe('mcp__mock__echo');
    // Each def carries a JSON-schema parameters object.
    expect(defs[0].function.parameters).toBeTypeOf('object');

    const res = await executeMcpTool('mcp__mock__add', { a: 4, b: 5 });
    expect(res.status).toBe('done');
    expect(res.output).toContain('9');
  });

  it('respects MCP_TOOLS_IN_AGENTS=false', async () => {
    process.env.MCP_TOOLS_IN_AGENTS = 'false';
    try {
      const mgr = getMcpManager();
      await mgr.init([{ name: 'mock', command: process.execPath, args: [MOCK] }]);
      const { defs } = getMcpToolDefinitions();
      expect(defs.length).toBe(0);
    } finally {
      delete process.env.MCP_TOOLS_IN_AGENTS;
    }
  });
});
