import { execFile, spawn } from 'child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ExecutionWorld, ExecutionWorldCapabilities } from './execution-world.js';
import type { ToolResult } from '../skills/tool-sandbox.js';
import { WORLD_WORKER_SOURCE } from './execution-world-worker.js';
const exec = promisify(execFile);

/** No image pulls, Docker startup, host socket mount or host credential environment injection. */
export class DockerWorld implements ExecutionWorld {
  readonly image: string;
  readonly capabilities: ExecutionWorldCapabilities = {
    mode: 'docker_isolated', available: true,
    isolation: { filesystem: true, process: true, network: true, credentials: true },
    supportedTools: ['file_read', 'file_write', 'shell_exec'], externalMcpIsolated: false,
    diagnostics: ['Local tools only. External MCP, plugins, host browsers and remote tools are not protected by this container.'],
  };
  constructor(image = process.env.MYRMECIA_WORLD_IMAGE || 'node:22-alpine') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(image)) throw new Error('WORLD_IMAGE_INVALID');
    this.image = image;
  }
  async probe(): Promise<void> {
    try {
      await exec('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 });
      await exec('docker', ['image', 'inspect', this.image, '--format', '{{.Id}}'], { timeout: 5000 });
    } catch {
      this.capabilities.available = false;
      throw new Error('SANDBOX_UNAVAILABLE: Docker daemon or preinstalled Node image is unavailable; no host fallback');
    }
  }
  async execute(tool: string, input: Record<string, unknown>, workdir: string,
    options: { signal?: AbortSignal; timeoutMs: number; maxOutputChars: number }): Promise<ToolResult> {
    if (!this.capabilities.supportedTools.includes(tool)) throw new Error(`WORLD_TOOL_UNSUPPORTED: ${tool}`);
    if (options.signal?.aborted) throw new Error('Request aborted');
    await this.probe();
    const workspace = realpathSync(workdir);
    if (workspace === '/' || workspace === process.env.HOME || workspace.includes(',')) throw new Error('WORLD_WORKSPACE_INVALID');
    const name = `myrmecia-world-${randomUUID()}`;
    const args = ['run', '--rm', '--pull', 'never', '--name', name, '-i',
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '64', '--cpus', '1', '--memory', '256m', '--memory-swap', '256m',
      '--user', `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
      '--mount', `type=bind,source=${workspace},target=/workspace`,
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m,mode=1777',
      '--tmpfs', '/scratch:rw,noexec,nosuid,size=16m,mode=1777',
      '--workdir', '/workspace', this.image, 'node', '--eval', WORLD_WORKER_SOURCE];
    try {
      return await new Promise<ToolResult>((resolve, reject) => {
        const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = ''; let stopped: Error | undefined;
        const stop = (reason: Error) => { stopped ??= reason; child.kill('SIGKILL'); };
        const timer = setTimeout(() => stop(new Error('WORLD_TOOL_TIMEOUT: remote side effects may require reconciliation')),
          Math.max(1, Math.min(options.timeoutMs, 600_000)));
        const abort = () => stop(new Error('Request aborted'));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        child.stdout.on('data', chunk => {
          stdout += chunk.toString();
          if (stdout.length > 1_000_000) stop(new Error('WORLD_OUTPUT_TOO_LARGE'));
        });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
        const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
        child.on('error', error => { cleanup(); reject(error); });
        child.on('close', code => {
          cleanup();
          if (stopped) return reject(stopped);
          if (code !== 0) return reject(new Error(`WORLD_TOOL_FAILED: ${stderr.slice(0, 1000)}`));
          try {
            const result = JSON.parse(stdout);
            if (!['done', 'failed'].includes(result.status) || typeof result.output !== 'string') throw new Error();
            resolve(result);
          } catch { reject(new Error('WORLD_RESULT_INVALID')); }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify({ tool, input, timeoutMs: Math.max(1, Math.min(options.timeoutMs, 600_000)),
          maxOutputChars: options.maxOutputChars }));
      });
    } finally {
      // Killing the Docker client alone is not container cancellation. Remove only our exact generated container.
      await exec('docker', ['rm', '-f', name], { timeout: 5000 }).catch(() => undefined);
    }
  }
}
