/**
 * MCP REST API — /api/v1/mcp
 *
 * Inspect connected MCP servers, list aggregated tools, and invoke a tool.
 */

import { Router } from 'express';
import { getMcpManager } from '../tools/mcp-manager.js';

export function createMcpRoutes(): Router {
  const router = Router();

  // GET /mcp/servers
  router.get('/servers', (_req, res) => {
    res.json(getMcpManager().servers());
  });

  // GET /mcp/tools
  router.get('/tools', (_req, res) => {
    res.json(getMcpManager().listTools());
  });

  // POST /mcp/servers — register + connect a server { name, command, args?, env? }
  router.post('/servers', async (req, res) => {
    const { name, command, args, env, cwd } = req.body || {};
    if (!name || !command) return res.status(400).json({ error: { message: 'name and command required' } });
    try {
      const client = await getMcpManager().addServer({ name, command, args, env, cwd });
      res.status(201).json({ name, connected: client.isConnected(), tools: client.tools });
    } catch (err: any) {
      res.status(502).json({ error: { message: err.message } });
    }
  });

  // DELETE /mcp/servers/:name
  router.delete('/servers/:name', (req, res) => {
    const ok = getMcpManager().removeServer(req.params.name);
    if (!ok) return res.status(404).json({ error: { message: 'server not found' } });
    res.json({ ok: true });
  });

  // POST /mcp/call — { name: 'mcp__server__tool', arguments: {} }
  router.post('/call', async (req, res) => {
    const { name, arguments: args } = req.body || {};
    if (!name) return res.status(400).json({ error: { message: 'tool name required' } });
    try {
      const result = await getMcpManager().callTool(String(name), args || {});
      res.json(result);
    } catch (err: any) {
      res.status(502).json({ error: { message: err.message } });
    }
  });

  return router;
}
