import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve, sep } from 'path';
import type {
  ExternalAgent,
  ExternalAgentAdapter,
  ExternalAgentAdapterResult,
  ExternalAgentHealth,
  ExternalAgentInvocationContext,
  ExternalAgentRun,
} from '@myrmecia/shared';
import { getSecretProvider } from '../security/secrets.js';

const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

type CliProfile = Exclude<Extract<ExternalAgent['adapter'], { kind: 'local_cli' }>['profile'], 'custom_profile'>;

const CLI_COMMANDS: Record<CliProfile, { command: string; args: (objective: string) => string[] }> = {
  codex: { command: 'codex', args: objective => ['exec', '--skip-git-repo-check', objective] },
  claude_code: { command: 'claude', args: objective => ['-p', objective] },
  gemini_cli: { command: 'gemini', args: objective => ['-p', objective] },
  opencode: { command: 'opencode', args: objective => ['run', objective] },
};

function errorResult(error: unknown): ExternalAgentAdapterResult {
  return {
    status: 'failed',
    error: error instanceof Error ? error.message : 'External Agent execution failed',
  };
}

function assertLocalWorkdir(agent: ExternalAgent, invocation: ExternalAgentInvocationContext): string {
  if (agent.adapter.kind !== 'local_cli') throw new Error('Expected a local CLI Agent.');
  if (!invocation.workdir) throw new Error('A workdir is required for a local CLI Agent.');
  const workdir = resolve(invocation.workdir);
  if (!existsSync(workdir)) throw new Error('The requested workdir does not exist.');
  const roots = (agent.adapter.allowedWorkspaceRoots || []).map(root => resolve(root));
  if (!roots.length) throw new Error('Local CLI Agent has no allowed workspace roots.');
  if (!roots.some(root => workdir === root || workdir.startsWith(`${root}${sep}`))) {
    throw new Error('The requested workdir is outside this Agent’s allowed workspace roots.');
  }
  return workdir;
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ExternalAgentAdapterResult> {
  return new Promise(resolveResult => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: process.env.CI || 'true' },
    });
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (Buffer.byteLength(output) >= MAX_OUTPUT_BYTES) return;
      output += chunk.toString('utf8').slice(0, MAX_OUTPUT_BYTES - Buffer.byteLength(output));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => {
      clearTimeout(timer);
      resolveResult(errorResult(error));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return resolveResult({ status: 'timed_out', error: `CLI Agent exceeded ${Math.round(timeoutMs / 1000)}s.`, outputSummary: output });
      if (code === 0) return resolveResult({ status: 'succeeded', outputSummary: output });
      return resolveResult({ status: 'failed', error: `CLI Agent exited with code ${code ?? 'unknown'}.`, outputSummary: output });
    });
  });
}

export class LocalCliAgentAdapter implements ExternalAgentAdapter {
  readonly kind = 'local_cli' as const;

  async validate(agent: ExternalAgent): Promise<void> {
    if (agent.adapter.kind !== this.kind) throw new Error('Local CLI Adapter received an incompatible Agent.');
    if (agent.adapter.profile === 'custom_profile') {
      throw new Error('custom_profile requires a server-owned profile registry and is not enabled.');
    }
    if (!agent.adapter.allowedWorkspaceRoots?.length) {
      throw new Error('At least one allowed workspace root is required for a local CLI Agent.');
    }
  }

  async healthCheck(agent: ExternalAgent): Promise<ExternalAgentHealth> {
    await this.validate(agent);
    const profile = agent.adapter.kind === this.kind ? agent.adapter.profile : 'custom_profile';
    if (profile === 'custom_profile') return { status: 'unreachable', checkedAt: new Date().toISOString(), detail: 'Unsupported CLI profile.' };
    const startedAt = Date.now();
    const result = await runCommand(CLI_COMMANDS[profile].command, ['--version'], process.cwd(), 10_000);
    return {
      status: result.status === 'succeeded' ? 'healthy' : 'unreachable',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      detail: result.error || result.outputSummary?.slice(0, 400),
    };
  }

  async execute(agent: ExternalAgent, invocation: ExternalAgentInvocationContext): Promise<ExternalAgentAdapterResult> {
    try {
      await this.validate(agent);
      const profile = agent.adapter.kind === this.kind ? agent.adapter.profile : 'custom_profile';
      if (profile === 'custom_profile') throw new Error('Unsupported CLI profile.');
      return await runCommand(CLI_COMMANDS[profile].command, CLI_COMMANDS[profile].args(invocation.objective), assertLocalWorkdir(agent, invocation));
    } catch (error) {
      return errorResult(error);
    }
  }

  async cancel(): Promise<void> {
    // Child-process cancellation is owned by the runtime in the next iteration.
  }
}

function parseHttpAgentResponse(body: string): Pick<ExternalAgentAdapterResult, 'outputSummary' | 'artifactIds' | 'externalRunId'> {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    return {
      outputSummary: typeof json.output === 'string' ? json.output : typeof json.summary === 'string' ? json.summary : body,
      artifactIds: Array.isArray(json.artifactIds) ? json.artifactIds.filter((value): value is string => typeof value === 'string') : [],
      externalRunId: typeof json.runId === 'string' ? json.runId : undefined,
    };
  } catch {
    return { outputSummary: body };
  }
}

export class HttpAgentAdapter implements ExternalAgentAdapter {
  readonly kind = 'http' as const;

  async validate(agent: ExternalAgent): Promise<void> {
    if (agent.adapter.kind !== this.kind) throw new Error('HTTP Adapter received an incompatible Agent.');
    let endpoint: URL;
    try {
      endpoint = new URL(agent.adapter.endpoint);
    } catch {
      throw new Error('HTTP Agent endpoint must be a valid URL.');
    }
    const testLocalhost = process.env.NODE_ENV === 'test' && ['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !testLocalhost) throw new Error('HTTP Agent endpoint must use HTTPS.');
    if (!agent.adapter.allowedHosts?.includes(endpoint.hostname)) {
      throw new Error('HTTP Agent endpoint host is not in allowedHosts.');
    }
  }

  async healthCheck(agent: ExternalAgent): Promise<ExternalAgentHealth> {
    const startedAt = Date.now();
    try {
      await this.validate(agent);
      const endpoint = new URL(agent.adapter.kind === this.kind ? agent.adapter.endpoint : '');
      endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/health';
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
      return {
        status: response.ok ? 'healthy' : 'degraded',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        detail: response.ok ? undefined : `Health check returned ${response.status}.`,
      };
    } catch (error) {
      return { status: 'unreachable', checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt, detail: error instanceof Error ? error.message : 'Health check failed.' };
    }
  }

  async execute(agent: ExternalAgent, invocation: ExternalAgentInvocationContext): Promise<ExternalAgentAdapterResult> {
    try {
      await this.validate(agent);
      if (agent.adapter.kind !== this.kind) throw new Error('Invalid HTTP Agent.');
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/plain;q=0.9' };
      if (agent.adapter.credentialRef) {
        const secret = await getSecretProvider().get(agent.adapter.credentialRef.key);
        if (!secret) throw new Error(`Credential reference "${agent.adapter.credentialRef.key}" could not be resolved.`);
        headers.authorization = `Bearer ${secret}`;
      }
      const response = await fetch(agent.adapter.endpoint, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ agent: { id: agent.id, name: agent.name, capabilities: agent.capabilities }, invocation }),
      });
      const body = (await response.text()).slice(0, MAX_OUTPUT_BYTES);
      const parsed = parseHttpAgentResponse(body);
      if (!response.ok) return { status: 'failed', ...parsed, error: `HTTP Agent returned ${response.status}.` };
      return { status: 'succeeded', ...parsed };
    } catch (error) {
      return errorResult(error);
    }
  }

  async cancel(_agent: ExternalAgent, _run: ExternalAgentRun): Promise<void> {
    // Callback-based cancellation is adapter-specific and intentionally omitted from V1.
  }
}
