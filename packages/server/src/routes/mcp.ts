/**
 * MCP REST API — /api/v1/mcp
 *
 * Inspect connected MCP servers, list aggregated tools, and invoke a tool.
 */

import { Router } from 'express';
import { getMcpManager, isProtectedMcpTool, McpPolicyError, WECHAT_OFFICIAL_ACCOUNT_MCP } from '../tools/mcp-manager.js';
import { xiaohongshuSession } from '../tools/xiaohongshu-session.js';
import { HttpError, requireOperatorRole, sendError } from './http.js';

export function createMcpRoutes(): Router {
  const router = Router();

  router.get('/xiaohongshu/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      requireOperatorRole(req, 'mcp.xiaohongshu.status', ['admin', 'operator']);
      res.json(await xiaohongshuSession.status());
    } catch (err) { sendError(res, err); }
  });

  router.post('/xiaohongshu/login', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // Login changes the shared local MCP account, not only this task.
      requireOperatorRole(req, 'mcp.xiaohongshu.login', ['admin']);
      res.json(await xiaohongshuSession.qrCode());
    } catch (err) { sendError(res, err); }
  });

  router.post('/servers/:name/reconnect', async (req, res) => {
    try {
      requireOperatorRole(req, 'mcp.reconnect', ['admin']);
      const manager = getMcpManager();
      if (!manager.servers().some(server => server.name === req.params.name)) {
        throw new HttpError(404, 'MCP_SERVER_NOT_FOUND', '服务未配置，请检查 MCP_SERVERS 配置。');
      }
      const client = await manager.reconnectServer(req.params.name);
      res.json({ name: req.params.name, connected: client.isConnected() });
    } catch (err) { sendError(res, err); }
  });

  // GET /mcp/servers
  router.get('/servers', (_req, res) => {
    res.json(getMcpManager().servers());
  });

  // GET /mcp/tools
  router.get('/tools', (_req, res) => {
    res.json(getMcpManager().listTools());
  });

  // Safe readiness probe: verifies that the configured credentials can obtain
  // a token, but never returns token/config content to the caller.
  router.get('/wechat/status', async (_req, res) => {
    const connected = getMcpManager().servers()
      .some(server => server.name === WECHAT_OFFICIAL_ACCOUNT_MCP && server.connected);
    if (!connected) {
      return res.status(503).json({ connected: false, authenticated: false });
    }
    try {
      const result = await getMcpManager().callTool(
        'mcp__wechat-official-account__wechat_auth',
        { action: 'get_token' },
        20_000,
        {
          agentId: 'social-preflight',
          taskMode: 'direct',
        },
      );
      res.status(result.isError ? 502 : 200).json({
        connected: true,
        authenticated: !result.isError,
      });
    } catch {
      res.status(502).json({ connected: true, authenticated: false });
    }
  });

  // POST /mcp/servers — register + connect a server { name, command, args?, env? }
  router.post('/servers', async (req, res) => {
    const { name, command, args, env, cwd } = req.body || {};
    if (!name || !command) return res.status(400).json({ error: { message: 'name and command required' } });
    if (name === WECHAT_OFFICIAL_ACCOUNT_MCP) {
      return res.status(409).json({ error: { code: 'RESERVED_MCP_SERVER', message: 'server name is reserved' } });
    }
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
    if (name === 'mcp__xiaohongshu__get_login_qrcode' || name === 'mcp__xiaohongshu__check_login_status') {
      res.setHeader('Cache-Control', 'no-store');
      try {
        requireOperatorRole(req, 'mcp.xiaohongshu.login', name.endsWith('get_login_qrcode') ? ['admin'] : ['admin', 'operator']);
        return res.json(name.endsWith('get_login_qrcode') ? await xiaohongshuSession.qrCode() : await xiaohongshuSession.status());
      } catch (err) { return sendError(res, err); }
    }
    if (isProtectedMcpTool(String(name))) {
      return res.status(403).json({
        error: {
          code: 'GOVERNED_MCP_TOOL',
          message: 'WeChat Official Account tools may only run through an authorized agent pipeline',
        },
      });
    }
    try {
      const result = await getMcpManager().callTool(String(name), args || {});
      res.json(result);
    } catch (err: any) {
      if (err instanceof McpPolicyError) {
        return res.status(403).json({ error: { code: 'GOVERNED_MCP_TOOL', message: err.message } });
      }
      res.status(502).json({ error: { message: err.message } });
    }
  });

  return router;
}
