import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSandboxProfile, assertLocalShellAllowed, assertNetworkToolAllowed } from '../src/agents/sandbox-profile.js';
import { executeTool } from '../src/skills/tool-sandbox.js';

const SANDBOX_ENV = ['NODE_ENV', 'SANDBOX_PROFILE', 'EXECUTOR_MODE', 'ALLOW_LOCAL_SHELL', 'ALLOW_LOCAL_EXECUTOR_IN_PRODUCTION', 'WEB_TOOLS_ENABLED', 'REQUIRE_APPROVAL_FOR_HIGH_RISK'] as const;

describe('sandbox profile', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of SANDBOX_ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  });

  afterEach(() => {
    for (const key of SANDBOX_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to standard in development (shell + network allowed)', () => {
    const profile = getSandboxProfile();
    expect(profile.name).toBe('standard');
    expect(profile.allowLocalShell).toBe(true);
    expect(profile.allowNetworkTools).toBe(true);
    expect(() => assertLocalShellAllowed()).not.toThrow();
    expect(() => assertNetworkToolAllowed('web')).not.toThrow();
  });

  it('defaults to strict in production (shell + network denied, approval required)', () => {
    process.env.NODE_ENV = 'production';
    const profile = getSandboxProfile();
    expect(profile.name).toBe('strict');
    expect(profile.allowLocalShell).toBe(false);
    expect(profile.allowNetworkTools).toBe(false);
    expect(profile.requireApprovalForHighRisk).toBe(true);
    expect(() => assertLocalShellAllowed()).toThrow(/disabled by the "strict" sandbox profile/);
    expect(() => assertNetworkToolAllowed('web')).toThrow(/disabled by the "strict" sandbox profile/);
  });

  it('honors focused operator overrides in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_LOCAL_SHELL = 'true';
    process.env.WEB_TOOLS_ENABLED = 'true';
    const profile = getSandboxProfile();
    expect(profile.allowLocalShell).toBe(true);
    expect(profile.allowNetworkTools).toBe(true);
    expect(() => assertLocalShellAllowed()).not.toThrow();
  });

  it('explicit SANDBOX_PROFILE=permissive allows everything', () => {
    process.env.NODE_ENV = 'production';
    process.env.SANDBOX_PROFILE = 'permissive';
    const profile = getSandboxProfile();
    expect(profile.name).toBe('permissive');
    expect(profile.allowLocalShell).toBe(true);
    expect(profile.allowNetworkTools).toBe(true);
  });

  it('blocks shell_exec at execution time under the strict profile', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'myrmecia-sandbox-'));
    process.env.NODE_ENV = 'production';
    const result = await executeTool('shell_exec', { command: 'echo blocked' }, workdir);
    expect(result.status).toBe('failed');
    expect(result.output).toContain('strict');
  });
});
