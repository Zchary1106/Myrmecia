#!/usr/bin/env node
/**
 * Minimal mock MCP server (stdio, newline-delimited JSON-RPC 2.0) for tests.
 * Implements: initialize, tools/list, tools/call (echo + add).
 */

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handle(line);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '0.0.1' },
    }});
    return;
  }
  if (method === 'notifications/initialized') return; // notification, no reply

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'echo', description: 'Echo back text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
    ]}});
    return;
  }
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(args?.text ?? '') }] } });
    } else if (name === 'add') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String((args?.a ?? 0) + (args?.b ?? 0)) }] } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${name}` } });
    }
    return;
  }

  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}
