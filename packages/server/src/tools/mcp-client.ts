/**
 * Minimal MCP (Model Context Protocol) stdio client — dependency-free.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over a spawned server process's stdio,
 * performs the `initialize` handshake, then lists and calls tools. Lets agents
 * use the large ecosystem of MCP tool servers without bundling the SDK.
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../lib/logger.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallResult {
  content: unknown;
  isError?: boolean;
}

const PROTOCOL_VERSION = '2024-11-05';

export class McpClient {
  private proc?: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private connected = false;
  readonly tools: McpToolDef[] = [];
  serverInfo: { name?: string; version?: string } = {};

  constructor(readonly config: McpServerConfig) {}

  isConnected(): boolean {
    return this.connected;
  }

  async connect(timeoutMs = 15000): Promise<void> {
    this.proc = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (d: Buffer) => this.onData(d));
    this.proc.stderr!.on('data', (d: Buffer) => logger.debug({ mcp: this.config.name, stderr: String(d).slice(0, 200) }, 'mcp stderr'));
    this.proc.on('exit', (code) => {
      this.connected = false;
      for (const p of this.pending.values()) p.reject(new Error(`mcp "${this.config.name}" exited (${code})`));
      this.pending.clear();
    });
    this.proc.on('error', (err) => logger.warn({ mcp: this.config.name, err: err.message }, 'mcp spawn error'));

    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'agent-factory', version: '1.0' },
    }, timeoutMs);
    this.serverInfo = init?.serverInfo ?? {};
    this.notify('notifications/initialized', {});
    this.connected = true;
    await this.refreshTools();
  }

  async refreshTools(): Promise<McpToolDef[]> {
    const res = await this.request('tools/list', {});
    this.tools.length = 0;
    for (const t of (res?.tools ?? [])) {
      this.tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    }
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 60000): Promise<McpCallResult> {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return { content: res?.content ?? res, isError: !!res?.isError };
  }

  dispose(): void {
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.connected = false;
  }

  // ---- transport ----

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'mcp error'));
        else p.resolve(msg.result);
      }
      // Server-initiated requests/notifications are ignored for now.
    }
  }

  private request(method: string, params: unknown, timeoutMs = 15000): Promise<any> {
    if (!this.proc || !this.proc.stdin) return Promise.reject(new Error('mcp not started'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp "${this.config.name}" ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc!.stdin!.write(payload);
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}
