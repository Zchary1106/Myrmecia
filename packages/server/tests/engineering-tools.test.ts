import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeTool, isSandboxTool, buildSandboxToolDefinition } from '../src/skills/tool-sandbox.js';

describe('engineering sandbox tools', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'myrmecia-eng-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('registers the new tools as sandbox tools with schemas', () => {
    for (const t of ['file_read', 'file_write', 'file_list', 'apply_patch', 'shell_exec', 'grep']) {
      expect(isSandboxTool(t)).toBe(true);
    }
    const def = buildSandboxToolDefinition('apply_patch');
    expect(def.function.parameters.required).toEqual(['path', 'old_str', 'new_str']);
    expect((def.function.parameters.properties as any).old_str).toBeDefined();
  });

  it('file_write then file_read round-trips inside the workspace', async () => {
    const w = await executeTool('file_write', { path: 'src/app.ts', content: 'export const x = 1;\n' }, workdir);
    expect(w.status).toBe('done');
    expect(readFileSync(join(workdir, 'src/app.ts'), 'utf-8')).toContain('export const x = 1;');
    const r = await executeTool('file_read', { path: 'src/app.ts' }, workdir);
    expect(r.status).toBe('done');
    expect(r.output).toContain('export const x = 1;');
  });

  it('apply_patch replaces a unique occurrence', async () => {
    writeFileSync(join(workdir, 'f.ts'), 'const a = 1;\nconst b = 2;\n');
    const p = await executeTool('apply_patch', { path: 'f.ts', old_str: 'const b = 2;', new_str: 'const b = 42;' }, workdir);
    expect(p.status).toBe('done');
    expect(readFileSync(join(workdir, 'f.ts'), 'utf-8')).toContain('const b = 42;');
  });

  it('apply_patch fails clearly when old_str is missing or ambiguous', async () => {
    writeFileSync(join(workdir, 'f.ts'), 'x\nx\n');
    const missing = await executeTool('apply_patch', { path: 'f.ts', old_str: 'zzz', new_str: 'y' }, workdir);
    expect(missing.status).toBe('failed');
    expect(missing.output).toMatch(/not found/i);
    const ambiguous = await executeTool('apply_patch', { path: 'f.ts', old_str: 'x', new_str: 'y' }, workdir);
    expect(ambiguous.status).toBe('failed');
    expect(ambiguous.output).toMatch(/multiple/i);
  });

  it('file_list enumerates workspace files and skips noise dirs', async () => {
    mkdirSync(join(workdir, 'src'), { recursive: true });
    mkdirSync(join(workdir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(workdir, 'src/a.ts'), '1');
    writeFileSync(join(workdir, 'node_modules/pkg/index.js'), '1');
    const l = await executeTool('file_list', {}, workdir);
    expect(l.status).toBe('done');
    expect(l.output).toContain('src/a.ts');
    expect(l.output).not.toContain('node_modules');
  });

  it('blocks path traversal outside the workspace', async () => {
    const r = await executeTool('file_read', { path: '../../../etc/passwd' }, workdir);
    expect(r.status).toBe('failed');
    expect(r.output).toMatch(/traversal|outside/i);
  });

  it('shell_exec runs a confined command and blocks dangerous ones', async () => {
    const ok = await executeTool('shell_exec', { command: 'echo hello-colony' }, workdir);
    expect(ok.status).toBe('done');
    expect(ok.output).toContain('hello-colony');
    const bad = await executeTool('shell_exec', { command: 'sudo rm -rf /' }, workdir);
    expect(bad.status).toBe('failed');
  });
});
