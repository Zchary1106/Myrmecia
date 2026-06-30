/**
 * Sandbox Profile — resolves how strongly the in-process tool sandbox is locked
 * down, based on the runtime environment and executor mode.
 *
 * The in-process tools (`shell_exec`, `web.*`, `crawler.*`) always run inside the
 * server process on the host, regardless of EXECUTOR_MODE (which only governs the
 * agent/python subprocess executor). So the real host-safety lever is here:
 *
 *   - strict     → production default: no host shell, network tools gated, high-risk
 *                  tools require approval. Suitable when agents are untrusted.
 *   - standard   → development default: host shell + web tools allowed, with
 *                  guardrails/DLP still applied.
 *   - permissive → explicit opt-in: everything allowed (use only on trusted machines).
 *
 * Selection precedence:
 *   1. SANDBOX_PROFILE=strict|standard|permissive (explicit override)
 *   2. NODE_ENV=production → strict, otherwise standard
 *
 * Individual levers can still be flipped with focused env flags so operators can
 * grant a controlled exception without dropping the whole profile.
 */

export type SandboxProfileName = 'strict' | 'standard' | 'permissive';

export interface SandboxProfile {
  name: SandboxProfileName;
  executorMode: string;
  production: boolean;
  /** Whether `shell_exec` (host shell) is allowed to run. */
  allowLocalShell: boolean;
  /** Whether network tools (`web.*`, `crawler.*`) are allowed to run. */
  allowNetworkTools: boolean;
  /** Whether high-risk tools must be operator-approved before running. */
  requireApprovalForHighRisk: boolean;
  reason: string;
}

function envFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  return ['1', 'true', 'yes'].includes(raw.toLowerCase());
}

function resolveProfileName(production: boolean): SandboxProfileName {
  const explicit = (process.env.SANDBOX_PROFILE || '').toLowerCase();
  if (explicit === 'strict' || explicit === 'standard' || explicit === 'permissive') {
    return explicit;
  }
  return production ? 'strict' : 'standard';
}

export function getSandboxProfile(): SandboxProfile {
  const production = process.env.NODE_ENV === 'production';
  const executorMode = process.env.EXECUTOR_MODE || 'local';
  const name = resolveProfileName(production);

  // Base defaults per profile.
  let allowLocalShell = name !== 'strict';
  let allowNetworkTools = name !== 'strict';
  let requireApprovalForHighRisk = name === 'strict';

  // Focused operator overrides (granted exceptions without changing the profile).
  const shellOverride = envFlag('ALLOW_LOCAL_SHELL') ?? envFlag('ALLOW_LOCAL_EXECUTOR_IN_PRODUCTION');
  if (shellOverride !== undefined) allowLocalShell = shellOverride;

  // WEB_TOOLS_ENABLED is the established lever for network tools; honor it both ways.
  const webOverride = envFlag('WEB_TOOLS_ENABLED');
  if (webOverride !== undefined) allowNetworkTools = webOverride;

  const approvalOverride = envFlag('REQUIRE_APPROVAL_FOR_HIGH_RISK');
  if (approvalOverride !== undefined) requireApprovalForHighRisk = approvalOverride;

  const reason = `profile=${name} env=${production ? 'production' : 'development'} executor=${executorMode}`;
  return { name, executorMode, production, allowLocalShell, allowNetworkTools, requireApprovalForHighRisk, reason };
}

/** Throw if the host shell is not permitted by the active sandbox profile. */
export function assertLocalShellAllowed(): void {
  const profile = getSandboxProfile();
  if (!profile.allowLocalShell) {
    throw new Error(
      `shell_exec is disabled by the "${profile.name}" sandbox profile (${profile.reason}). ` +
      'Run agents under EXECUTOR_MODE=docker, or grant a controlled exception with ALLOW_LOCAL_SHELL=true.',
    );
  }
}

/** Throw if network tools are not permitted by the active sandbox profile. */
export function assertNetworkToolAllowed(toolName = 'network'): void {
  const profile = getSandboxProfile();
  if (!profile.allowNetworkTools) {
    throw new Error(
      `Network tool "${toolName}" is disabled by the "${profile.name}" sandbox profile (${profile.reason}). ` +
      'Set WEB_TOOLS_ENABLED=true to allow web research tools.',
    );
  }
}
