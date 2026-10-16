import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchWorkspace } from '../src/skills/workspace-search.js';
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'myrmecia-search-')); roots.push(path); return path; };
const options = { timeoutMs: 3000, maxOutputChars: 4000 };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe('bounded workspace search', () => {
  it('finds Python, Go, Rust, JSON, YAML and Markdown instead of only JS/TS', async () => {
    const path = root();
    for (const name of ['main.py', 'main.go', 'main.rs', 'package.json', 'config.yaml', 'README.md', 'main.ts']) {
      writeFileSync(join(path, name), 'first\nneedle\n');
    }
    const result = await searchWorkspace(path, { pattern: 'needle' }, options);
    for (const name of ['main.py', 'main.go', 'main.rs', 'package.json', 'config.yaml', 'README.md', 'main.ts']) {
      expect(result.output).toContain(`${name}:2:needle`);
    }
  });
  it('excludes dependency/secret paths and external symlinks', async () => {
    const path = root(), outside = root();
    writeFileSync(join(path, '.env'), 'needle-secret');
    mkdirSync(join(path, 'node_modules')); writeFileSync(join(path, 'node_modules', 'dep.py'), 'needle-dependency');
    writeFileSync(join(outside, 'outside.py'), 'needle-outside');
    symlinkSync(join(outside, 'outside.py'), join(path, 'link.py'));
    symlinkSync(outside, join(path, 'linked-directory'));
    expect((await searchWorkspace(path, { pattern: 'needle' }, options)).output).toBe('No matches');
    await expect(searchWorkspace(path, { pattern: 'needle', path: '../' }, options)).rejects.toThrow('WORKSPACE_PATH_ESCAPE');
  });
  it('supports glob/path scoping, literal metacharacters and case-insensitive matching', async () => {
    const path = root(); mkdirSync(join(path, 'src'));
    writeFileSync(join(path, 'src', 'main.py'), 'Needle [literal]');
    writeFileSync(join(path, 'main.rs'), 'Needle [literal]');
    const result = await searchWorkspace(path, { pattern: '[LITERAL]', path: 'src', glob: '*.py', ignoreCase: true }, options);
    expect(result.output).toContain('src/main.py:1:Needle [literal]');
    expect(result.output).not.toContain('main.rs');
  });
  it('labels partial matches and oversized files instead of claiming an exhaustive result', async () => {
    const path = root(); writeFileSync(join(path, 'main.py'), 'needle\nneedle\n');
    expect((await searchWorkspace(path, { pattern: 'needle', maxMatches: 1 }, options)).output).toContain('Search incomplete');
    writeFileSync(join(path, 'large.py'), 'x'.repeat(1024 * 1024 + 1));
    expect((await searchWorkspace(path, { pattern: 'absent' }, options)).output).toContain('No matches in the scanned portion');
  });
  it('honors cancellation before scanning', async () => {
    const signal = AbortSignal.abort();
    await expect(searchWorkspace(root(), { pattern: 'needle' }, { ...options, signal })).rejects.toThrow('Request aborted');
  });
  it('runs regex only on authorized snapshot bytes and rejects invalid patterns', async () => {
    const path = root(); writeFileSync(join(path, 'main.py'), 'needle 42\nneedle text\n');
    expect((await searchWorkspace(path, { pattern: 'needle \\d+', regex: true }, options)).output).toContain('main.py:1:needle 42');
    await expect(searchWorkspace(path, { pattern: '[', regex: true }, options)).rejects.toThrow('Regex is invalid');
  });
  it('terminates pathological regex without blocking the application event loop', async () => {
    const path = root(); writeFileSync(join(path, 'main.py'), `${'a'.repeat(50_000)}!`);
    await expect(searchWorkspace(path, { pattern: '(a+)+$', regex: true }, { ...options, timeoutMs: 50 })).rejects.toThrow('bounded time');
  });
});
