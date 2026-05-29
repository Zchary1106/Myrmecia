/**
 * Executor Interface — abstracts where/how agent processes run.
 *
 * Implementations:
 * - LocalExecutor: spawn process directly on host (current behavior, dev mode)
 * - DockerExecutor: spawn process inside an isolated container (production)
 *
 * Set EXECUTOR_MODE=docker to use container isolation.
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../lib/logger.js';

export interface ExecutorConfig {
  /** Working directory inside the execution environment */
  workdir: string;
  /** Environment variables to pass */
  env: Record<string, string>;
  /** Command to run */
  command: string;
  /** Arguments */
  args: string[];
  /** Abort signal */
  signal?: AbortSignal;
  /** Resource limits */
  limits?: ResourceLimits;
  /** Unique execution ID for container naming */
  executionId: string;
}

export interface ResourceLimits {
  /** Max CPU cores (e.g., 2.0) */
  cpus?: number;
  /** Max memory in MB (e.g., 2048) */
  memoryMB?: number;
  /** Max execution time in seconds */
  timeoutSec?: number;
  /** Network mode: 'none' | 'host' | 'bridge' */
  network?: 'none' | 'host' | 'bridge';
  /** Read-only filesystem */
  readonlyFs?: boolean;
}

export interface ExecutorProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  kill(signal?: string): boolean;
  readonly pid: number | undefined;
}

export interface Executor {
  readonly name: string;
  spawn(config: ExecutorConfig): ExecutorProcess;
}

// ---------- Local Executor ----------

class LocalExecutor implements Executor {
  readonly name = 'local';

  spawn(config: ExecutorConfig): ExecutorProcess {
    logger.debug(`[LocalExecutor] spawning: ${config.command} ${config.args.join(' ')}`);
    const proc = spawn(config.command, config.args, {
      cwd: config.workdir,
      env: { ...process.env, ...config.env },
      signal: config.signal,
    });
    return proc as ExecutorProcess;
  }
}

// ---------- Docker Executor ----------

class DockerExecutor implements Executor {
  readonly name = 'docker';
  private image: string;

  constructor() {
    this.image = process.env.AGENT_DOCKER_IMAGE || 'agent-factory/sandbox:latest';
  }

  spawn(config: ExecutorConfig): ExecutorProcess {
    const containerName = `af-exec-${config.executionId}`;
    const limits = config.limits || {};

    const dockerArgs: string[] = [
      'run',
      '--rm',
      '--name', containerName,
      // Resource limits
      ...(limits.cpus ? ['--cpus', String(limits.cpus)] : ['--cpus', '2']),
      ...(limits.memoryMB ? ['--memory', `${limits.memoryMB}m`] : ['--memory', '2048m']),
      '--pids-limit', '256',
      // Network isolation
      ...(limits.network === 'none' ? ['--network', 'none'] : []),
      ...(limits.network === 'bridge' ? ['--network', 'bridge'] : []),
      // Security
      '--security-opt', 'no-new-privileges',
      ...(process.env.AGENT_DOCKER_APPARMOR_PROFILE ? ['--security-opt', `apparmor=${process.env.AGENT_DOCKER_APPARMOR_PROFILE}`] : []),
      ...(process.env.AGENT_DOCKER_SECCOMP_PROFILE ? ['--security-opt', `seccomp=${process.env.AGENT_DOCKER_SECCOMP_PROFILE}`] : []),
      '--cap-drop', 'ALL',
      ...(limits.readonlyFs ? ['--read-only', '--tmpfs', '/tmp'] : []),
      // Working directory mount
      '-v', `${config.workdir}:/workspace:rw`,
      '-w', '/workspace',
      // Environment variables
      ...Object.entries(config.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      // Image
      this.image,
      // Command
      config.command,
      ...config.args,
    ];

    logger.info({ containerName, image: this.image }, '[DockerExecutor] spawning container');

    const proc = spawn('docker', dockerArgs, {
      env: process.env,
      signal: config.signal,
    });

    // Ensure container cleanup on abort
    if (config.signal) {
      config.signal.addEventListener('abort', () => {
        spawn('docker', ['kill', containerName], { stdio: 'ignore' });
      }, { once: true });
    }

    return proc as ExecutorProcess;
  }
}

// ---------- Factory ----------

let executor: Executor | undefined;

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production';
}

function localExecutorAllowedInProduction(): boolean {
  return ['1', 'true', 'yes'].includes((process.env.ALLOW_LOCAL_EXECUTOR_IN_PRODUCTION || '').toLowerCase());
}

export function getExecutor(): Executor {
  if (!executor) {
    const mode = process.env.EXECUTOR_MODE || 'local';
    if (mode === 'docker') {
      executor = new DockerExecutor();
      logger.info('Using Docker executor (container isolation enabled)');
    } else if (mode === 'local') {
      if (isProductionRuntime() && !localExecutorAllowedInProduction()) {
        throw new Error(
          'Local executor is not allowed in production because agent subprocesses would run with host privileges. ' +
          'Set EXECUTOR_MODE=docker or explicitly set ALLOW_LOCAL_EXECUTOR_IN_PRODUCTION=true for a controlled exception.',
        );
      }
      executor = new LocalExecutor();
      if (isProductionRuntime()) {
        logger.warn('Using local executor in production because ALLOW_LOCAL_EXECUTOR_IN_PRODUCTION=true');
      } else {
        logger.info('Using local executor (runner resource limits enabled; set EXECUTOR_MODE=docker for container isolation)');
      }
    } else {
      throw new Error(`Unsupported EXECUTOR_MODE "${mode}". Use "docker" or "local".`);
    }
  }
  return executor;
}

export function resetExecutorForTests(): void {
  executor = undefined;
}

/** Default resource limits for agent execution */
export const DEFAULT_LIMITS: ResourceLimits = {
  cpus: 2,
  memoryMB: 2048,
  timeoutSec: 300,
  network: 'bridge',
  readonlyFs: false,
};
