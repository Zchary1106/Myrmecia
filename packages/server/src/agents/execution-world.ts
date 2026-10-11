import type { ToolResult } from '../skills/tool-sandbox.js';
import { DockerWorld } from './docker-world.js';
export type ExecutionWorldMode = 'host_policy' | 'docker_isolated';
export interface ExecutionWorldCapabilities {
  mode: ExecutionWorldMode;
  available: boolean;
  isolation: { filesystem: boolean; process: boolean; network: boolean; credentials: boolean };
  supportedTools: string[];
  externalMcpIsolated: false;
  diagnostics: string[];
}
export interface ExecutionWorld {
  capabilities: ExecutionWorldCapabilities;
  execute(tool: string, input: Record<string, unknown>, workdir: string,
    options: { signal?: AbortSignal; timeoutMs: number; maxOutputChars: number }): Promise<ToolResult>;
}
export function executionWorldMode(): ExecutionWorldMode {
  const value = process.env.MYRMECIA_EXECUTION_WORLD || 'host_policy';
  if (!['host_policy', 'docker_isolated'].includes(value)) throw new Error('EXECUTION_WORLD_INVALID');
  return value as ExecutionWorldMode;
}
export function hostWorldCapabilities(): ExecutionWorldCapabilities {
  return { mode: 'host_policy', available: true,
    isolation: { filesystem: false, process: false, network: false, credentials: false },
    supportedTools: [], externalMcpIsolated: false,
    diagnostics: ['Host policy checks are not a filesystem, process, network or credential security boundary.'] };
}
export async function resolveExecutionWorld(mode = executionWorldMode(), backend?: ExecutionWorld): Promise<ExecutionWorldCapabilities | ExecutionWorld> {
  if (mode === 'host_policy') return hostWorldCapabilities();
  const world = backend || new DockerWorld();
  if (world instanceof DockerWorld) await world.probe();
  if (!world.capabilities.available || world.capabilities.mode !== 'docker_isolated'
    || !Object.values(world.capabilities.isolation).every(Boolean)) {
    throw new Error('SANDBOX_UNAVAILABLE: requested isolated execution world is not available');
  }
  return world;
}
