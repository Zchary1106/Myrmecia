import { spawn, type ChildProcess } from 'child_process';
import { connect } from 'node:net';

/** Trusted local startup configuration, not accepted from the MCP REST API. */
export interface McpLocalServiceConfig {
  command: string;
  args?: string[];
  cwd?: string;
  port: number;
  startupTimeoutMs?: number;
}

export function parseLocalServices(raw = process.env.MCP_LOCAL_SERVICES): Record<string, McpLocalServiceConfig> {
  if (!raw) return {};
  const entries = JSON.parse(raw);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('MCP_LOCAL_SERVICES must be an object');
  for (const config of Object.values(entries) as McpLocalServiceConfig[]) {
    if (!config || typeof config.command !== 'string' || !config.command.trim()
      || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
      || (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string')))
      || (config.cwd !== undefined && typeof config.cwd !== 'string')
      || (config.startupTimeoutMs !== undefined && (!Number.isFinite(config.startupTimeoutMs) || config.startupTimeoutMs < 100 || config.startupTimeoutMs > 60_000))) {
      throw new Error('Invalid MCP_LOCAL_SERVICES entry: command, loopback port and valid startup timeout are required');
    }
  }
  return entries;
}

function isListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

/** Own only the direct child we spawned; never kill a process found by port. */
export class McpLocalService {
  private process?: ChildProcess;
  private stopped = false;

  constructor(private config: McpLocalServiceConfig) {}

  async ensureStarted(): Promise<void> {
    if (this.stopped) throw new Error('Local MCP service has been stopped');
    if (await isListening(this.config.port)) return;
    if (this.stopped) throw new Error('Local MCP service has been stopped');
    let failure: string | undefined;
    if (!this.process) {
      const child = spawn(this.config.command, this.config.args || [], {
        cwd: this.config.cwd,
        shell: false,
        stdio: 'ignore',
      });
      this.process = child;
      child.on('error', (error: NodeJS.ErrnoException) => {
        failure = `Local MCP process could not start (${error.code || 'spawn error'})`;
        if (this.process === child) this.process = undefined;
      });
      child.on('exit', (code: number | null) => {
        failure = `Local MCP process exited (${code})`;
        if (this.process === child) this.process = undefined;
      });
    }
    const deadline = Date.now() + (this.config.startupTimeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      if (this.stopped) throw new Error('Local MCP service has been stopped');
      if (failure) throw new Error(failure);
      if (await isListening(this.config.port)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await this.stopProcess();
    throw new Error(`Local MCP service did not listen on 127.0.0.1:${this.config.port} before startup timeout`);
  }

  private stopProcess(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.on('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }

  dispose(): Promise<void> {
    this.stopped = true;
    return this.stopProcess();
  }
}
