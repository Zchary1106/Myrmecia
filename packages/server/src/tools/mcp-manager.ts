/**
 * MCP Manager — connects configured MCP servers and aggregates their tools.
 *
 * Config comes from the `MCP_SERVERS` env var (a JSON array of McpServerConfig)
 * or is registered programmatically. Tools are exposed with a qualified name
 * `mcp__<server>__<tool>` so they can be surfaced to agents alongside built-ins.
 */

import { McpClient, type McpServerConfig, type McpToolDef, type McpCallResult } from './mcp-client.js';
import { logger } from '../lib/logger.js';

export interface QualifiedMcpTool {
  server: string;
  name: string;
  qualifiedName: string;   // mcp__<server>__<tool>
  description?: string;
  inputSchema?: unknown;
}

const PREFIX = 'mcp__';

export function parseMcpServersEnv(raw?: string): McpServerConfig[] {
  const value = raw ?? process.env.MCP_SERVERS;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter(s => s && s.name && s.command);
    return [];
  } catch (err: any) {
    logger.warn({ err: err.message }, 'invalid MCP_SERVERS JSON');
    return [];
  }
}

export class McpManager {
  private clients = new Map<string, McpClient>();

  /** Connect all servers from config (best-effort; failures are logged, not thrown). */
  async init(configs?: McpServerConfig[]): Promise<void> {
    const list = configs ?? parseMcpServersEnv();
    for (const cfg of list) {
      await this.addServer(cfg).catch(err =>
        logger.warn({ server: cfg.name, err: err.message }, 'MCP server connect failed')
      );
    }
    if (this.clients.size > 0) {
      logger.info({ servers: this.servers(), tools: this.listTools().length }, 'MCP servers connected');
    }
  }

  async addServer(cfg: McpServerConfig): Promise<McpClient> {
    const existing = this.clients.get(cfg.name);
    if (existing) existing.dispose();
    const client = new McpClient(cfg);
    await client.connect();
    this.clients.set(cfg.name, client);
    return client;
  }

  removeServer(name: string): boolean {
    const client = this.clients.get(name);
    if (!client) return false;
    client.dispose();
    return this.clients.delete(name);
  }

  servers(): Array<{ name: string; connected: boolean; toolCount: number; serverInfo: unknown }> {
    return [...this.clients.values()].map(c => ({
      name: c.config.name,
      connected: c.isConnected(),
      toolCount: c.tools.length,
      serverInfo: c.serverInfo,
    }));
  }

  listTools(): QualifiedMcpTool[] {
    const out: QualifiedMcpTool[] = [];
    for (const client of this.clients.values()) {
      for (const tool of client.tools) {
        out.push({
          server: client.config.name,
          name: tool.name,
          qualifiedName: `${PREFIX}${client.config.name}__${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return out;
  }

  /** Call a tool by qualified name (`mcp__server__tool`) or `server` + `tool`. */
  async callTool(qualifiedName: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    const { server, tool } = splitQualified(qualifiedName);
    const client = this.clients.get(server);
    if (!client) throw new Error(`MCP server not connected: ${server}`);
    return client.callTool(tool, args);
  }

  dispose(): void {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
  }
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(PREFIX);
}

function splitQualified(qualifiedName: string): { server: string; tool: string } {
  const rest = qualifiedName.startsWith(PREFIX) ? qualifiedName.slice(PREFIX.length) : qualifiedName;
  const sep = rest.indexOf('__');
  if (sep < 0) throw new Error(`invalid MCP tool name: ${qualifiedName}`);
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

// ---------- Singleton ----------

let manager: McpManager | null = null;

export function getMcpManager(): McpManager {
  if (!manager) manager = new McpManager();
  return manager;
}

export function resetMcpManager(): void {
  manager?.dispose();
  manager = null;
}
