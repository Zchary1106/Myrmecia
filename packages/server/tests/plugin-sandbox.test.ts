import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginSandbox } from '../src/plugins/sandbox.js';

describe('PluginSandbox', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

  it('runs an exported method from a trusted local module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-plugin-'));
    roots.push(root);
    const entry = join(root, 'entry.mjs');
    writeFileSync(entry, 'export const add = (a, b) => a + b;');
    await expect(pluginSandbox.execute('math', 'add', [2, 3], { modulePath: entry, allowedRoot: root })).resolves.toBe(5);
  });

  it('does not let a module escape its installed source root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-plugin-'));
    const outside = mkdtempSync(join(tmpdir(), 'myrmecia-plugin-outside-'));
    roots.push(root, outside);
    const entry = join(outside, 'entry.mjs');
    writeFileSync(entry, 'export const run = () => 1;');
    await expect(pluginSandbox.execute('bad', 'run', [], { modulePath: entry, allowedRoot: root })).rejects.toThrow('escapes');
  });
});
