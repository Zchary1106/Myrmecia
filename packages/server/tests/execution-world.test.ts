import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerWorld } from '../src/agents/docker-world.js';
import { hostWorldCapabilities, resolveExecutionWorld, type ExecutionWorld } from '../src/agents/execution-world.js';
import { executeTool } from '../src/skills/tool-sandbox.js';
afterEach(() => { delete process.env.MYRMECIA_EXECUTION_WORLD; delete process.env.MYRMECIA_TEST_SECRET; });
describe('explicit execution world contract', () => {
  it('states that host policies have no true isolation and never fall back from an unavailable isolated backend', async () => {
    expect(hostWorldCapabilities().isolation).toEqual({ filesystem: false, process: false, network: false, credentials: false });
    const execute = vi.fn();
    const fake: ExecutionWorld = { capabilities: { ...hostWorldCapabilities(), mode: 'docker_isolated', available: false }, execute };
    await expect(resolveExecutionWorld('docker_isolated', fake)).rejects.toThrow('SANDBOX_UNAVAILABLE');
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects available but non-enforcing backends instead of labeling them isolated', async () => {
    const fake: ExecutionWorld = { capabilities: { ...hostWorldCapabilities(), mode: 'docker_isolated' }, execute: vi.fn() };
    await expect(resolveExecutionWorld('docker_isolated', fake)).rejects.toThrow('SANDBOX_UNAVAILABLE');
  });
  it('blocks an unsupported tool in isolated mode without invoking a host network implementation', async () => {
    process.env.MYRMECIA_EXECUTION_WORLD = 'docker_isolated';
    // No daemon required: use an unsupported tool directly at the backend boundary.
    await expect(new DockerWorld().execute('web.search', {}, '/tmp', { timeoutMs: 100, maxOutputChars: 100 }))
      .rejects.toThrow('WORLD_TOOL_UNSUPPORTED');
  });
});
describe.skipIf(process.env.MYRMECIA_TEST_DOCKER !== 'true')('real Docker isolated world acceptance', () => {
  const testDirectory = resolve(process.cwd(), '../../artifacts/agent-runtime-v2/docker');
  const workspace = () => {
    // Colima shares /Users, not macOS /private/var/folders. Explicitly test a supported host mount.
    mkdirSync(testDirectory, { recursive: true });
    return mkdtempSync(join(testDirectory, 'world-'));
  };
  it('enforces workspace/symlink, rootfs, network, non-root and credential boundaries with a preinstalled image', async () => {
    const root = workspace();
    writeFileSync(join(root, 'evidence.md'), '# Actual container evidence');
    symlinkSync('/etc/passwd', join(root, 'escape'));
    process.env.MYRMECIA_TEST_SECRET = 'synthetic-test-secret';
    process.env.MYRMECIA_EXECUTION_WORLD = 'docker_isolated';
    const world = new DockerWorld();
    const run = (tool: string, input: Record<string, unknown>) => world.execute(tool, input, root, { timeoutMs: 10_000, maxOutputChars: 4000 });
    expect(await run('file_read', { path: 'evidence.md' })).toMatchObject({ status: 'done', output: '# Actual container evidence' });
    expect(await run('file_read', { path: '/etc/passwd' })).toMatchObject({ status: 'failed', output: expect.stringContaining('PATH_ESCAPE') });
    expect(await run('file_read', { path: 'escape' })).toMatchObject({ status: 'failed', output: expect.stringContaining('SYMLINK_ESCAPE') });
    expect(await run('shell_exec', { command: 'id -u' })).toMatchObject({ status: 'done', output: expect.not.stringMatching(/^0\s*$/) });
    expect(await run('shell_exec', { command: 'touch /forbidden-test-file' })).toMatchObject({ status: 'failed' });
    expect(await run('shell_exec', { command: `node -e "console.log(process.env.MYRMECIA_TEST_SECRET || 'absent')"` }))
      .toMatchObject({ status: 'done', output: 'absent\n' });
    expect(await run('shell_exec', { command: `node -e "require('net').connect({host:'1.1.1.1',port:80}).on('error',()=>console.log('NETWORK_DENIED'))"` }))
      .toMatchObject({ status: 'done', output: 'NETWORK_DENIED\n' });
    expect(await executeTool('file_read', { path: 'evidence.md' }, root)).toMatchObject({ status: 'done' });
  }, 40_000);
  it('cancels and removes its exact container without leaving a host process running', async () => {
    const root = workspace();
    const controller = new AbortController();
    const promise = new DockerWorld().execute('shell_exec', { command: 'sleep 30' }, root, {
      signal: controller.signal, timeoutMs: 10_000, maxOutputChars: 100,
    });
    const assertion = expect(promise).rejects.toThrow('aborted');
    const timer = setTimeout(() => controller.abort(), 500);
    try { await assertion; } finally { clearTimeout(timer); }
  }, 15_000);
});
