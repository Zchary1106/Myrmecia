/**
 * MCP integration tests against a mock stdio MCP server.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { buildMcpChildEnv, McpClient } from '../src/tools/mcp-client.js';
import {
  buildWeChatMcpConfig,
  configureWeChatMcpClient,
  McpManager,
  parseMcpServersEnv,
  takeWeChatMcpBootstrap,
} from '../src/tools/mcp-manager.js';

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

describe('WeChat MCP credential boundary', () => {
  it('removes credentials from the server environment and keeps them out of the MCP launch surface', () => {
    const serverEnv = {
      PATH: '/usr/bin',
      MYRMECIA_API_KEY: 'must-not-reach-mcp',
      WECHAT_OFFICIAL_ACCOUNT_APP_ID: 'wx-real-app-id',
      WECHAT_OFFICIAL_ACCOUNT_APP_SECRET: 'real-app-secret',
      WECHAT_MCP_SECRET_KEY: 'database-encryption-key',
    };
    const bootstrap = takeWeChatMcpBootstrap(serverEnv);
    expect(serverEnv.WECHAT_OFFICIAL_ACCOUNT_APP_ID).toBeUndefined();
    expect(serverEnv.WECHAT_OFFICIAL_ACCOUNT_APP_SECRET).toBeUndefined();
    expect(serverEnv.WECHAT_MCP_SECRET_KEY).toBeUndefined();

    const config = buildWeChatMcpConfig(bootstrap)!;
    expect(config.args?.join(' ')).not.toContain('wx-real-app-id');
    expect(config.args?.join(' ')).not.toContain('real-app-secret');
    expect(config.env?.WECHAT_MCP_SECRET_KEY).toBe('database-encryption-key');
    expect(config.env?.WECHAT_MCP_DB_PATH).toBeTruthy();

    const childEnv = buildMcpChildEnv(config, {
      PATH: '/usr/bin',
      MYRMECIA_API_KEY: 'must-not-reach-mcp',
      WECHAT_OFFICIAL_ACCOUNT_APP_ID: 'wx-real-app-id',
      WECHAT_OFFICIAL_ACCOUNT_APP_SECRET: 'real-app-secret',
    });
    expect(childEnv.PATH).toBe('/usr/bin');
    expect(childEnv.MYRMECIA_API_KEY).toBeUndefined();
    expect(childEnv.WECHAT_OFFICIAL_ACCOUNT_APP_ID).toBeUndefined();
    expect(childEnv.WECHAT_OFFICIAL_ACCOUNT_APP_SECRET).toBeUndefined();
  });

  it('sends real credentials only through the private tool call', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    await configureWeChatMcpClient({
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { content: [] };
      },
    }, { appId: 'wx-real-app-id', appSecret: 'real-app-secret' });

    expect(calls).toEqual([{
      name: 'wechat_auth',
      args: {
        action: 'configure',
        appId: 'wx-real-app-id',
        appSecret: 'real-app-secret',
      },
    }]);
  });

  it('refuses to create a WeChat MCP config without encrypted database storage', () => {
    expect(buildWeChatMcpConfig({
      credentials: { appId: 'wx-real-app-id', appSecret: 'real-app-secret' },
    })).toBeUndefined();
  });

  it('starts the real MCP package with an encrypted database at the configured path', async () => {
    const appSecret = '0123456789abcdef0123456789abcdef';
    const dbPath = join(mkdtempSync(join(tmpdir(), 'wechat-mcp-real-')), 'wechat-mcp.db');
    const baseConfig = buildWeChatMcpConfig({
      credentials: { appId: 'wx1234567890abcdef', appSecret },
      storageKey: 'test-database-encryption-key',
    })!;
    const client = new McpClient({
      ...baseConfig,
      env: { ...baseConfig.env, WECHAT_MCP_DB_PATH: dbPath },
    });

    try {
      await client.connect(20_000);
      await configureWeChatMcpClient(client, {
        appId: 'wx1234567890abcdef',
        appSecret,
      });
      expect(client.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'wechat_auth',
        'wechat_permanent_media',
        'wechat_draft',
        'wechat_publish',
      ]));
    } finally {
      client.dispose();
    }

    expect(existsSync(dbPath)).toBe(true);
    expect(readFileSync(dbPath).includes(Buffer.from(appSecret))).toBe(false);
  }, 30_000);

  it('rejects external registration of the reserved WeChat server name', async () => {
    manager = new McpManager();
    await expect(manager.addServer({
      name: 'wechat-official-account',
      command: process.execPath,
      args: [MOCK],
    })).rejects.toThrow(/reserved/);
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
