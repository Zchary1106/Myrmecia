import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceFileReadOutput } from '../src/skills/workspace-file-read.js';
import { buildSandboxToolDefinition, executeTool } from '../src/skills/tool-sandbox.js';
import { closeDb } from '../src/db/database.js';

const roots: string[] = [];
afterEach(() => {
  closeDb(); delete process.env.DB_PATH;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('lossless bounded workspace source reading', () => {
  it('leaves short default reads unchanged', () => {
    expect(workspaceFileReadOutput('small\nfile', 'file.mjs', {}, 8000)).toBe('small\nfile');
  });
  it('reconstructs every character via pages that fit the inline output budget, including escaped source', () => {
    const source = 'const s = "\\\\\\""; // 中文🙂\n'.repeat(500);
    let offset = 0, expectedSha256: string | undefined, reconstructed = '', pages = 0;
    while (true) {
      const raw = workspaceFileReadOutput(source, 'src/source.mjs', { offset, expectedSha256 }, 8000);
      expect(raw.length).toBeLessThanOrEqual(1900);
      const page = JSON.parse(raw);
      expect(page.offset).toBe(offset);
      expect(page.totalChars).toBe(source.length);
      reconstructed += page.content; pages++;
      if (page.eof) { expect(page.nextOffset).toBeNull(); break; }
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset; expectedSha256 = page.sha256;
    }
    expect(pages).toBeGreaterThan(1);
    expect(reconstructed).toBe(source);
  });
  it('refuses changed evidence, unsafe page arguments and insufficient output space', () => {
    const page = JSON.parse(workspaceFileReadOutput('original'.repeat(500), 'file', {}, 8000));
    expect(() => workspaceFileReadOutput('changed', 'file', { expectedSha256: page.sha256 }, 8000)).toThrow('SOURCE_CHANGED');
    for (const input of [{ offset: -1 }, { offset: 0.5 }, { offset: 9000 }, { maxChars: 0 }, { maxChars: 1601 }, { offset: '0' }]) {
      expect(() => workspaceFileReadOutput('source'.repeat(500), 'file', input, 8000)).toThrow('RANGE_INVALID');
    }
    expect(() => workspaceFileReadOutput('long'.repeat(500), 'file', {}, 10)).toThrow('OUTPUT_QUOTA');
    const emoji = JSON.parse(workspaceFileReadOutput('🙂next', 'file', { maxChars: 1 }, 8000));
    expect(emoji.content).toBe('🙂');
    expect(emoji.nextOffset).toBe(2);
    expect(() => workspaceFileReadOutput('🙂next', 'file', { offset: 1 }, 8000)).toThrow('RANGE_INVALID');
  });
  it('exposes pagination on the same approved read tool and retains workspace/secret/symlink guards', async () => {
    process.env.DB_PATH = ':memory:';
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-source-pages-')); roots.push(root);
    writeFileSync(join(root, 'source.mjs'), 'const value = 1;\n'.repeat(300));
    writeFileSync(join(root, '.env'), 'dummy fixture value');
    symlinkSync('source.mjs', join(root, 'alias.mjs'));
    const schema = buildSandboxToolDefinition('file_read').function.parameters as any;
    expect(schema.properties.offset).toMatchObject({ type: 'integer', minimum: 0 });
    const first = await executeTool('file_read', { path: 'source.mjs' }, root, { allowedTools: ['file_read'] });
    expect(first.status).toBe('done');
    const page = JSON.parse(first.output);
    const next = await executeTool('file_read', { path: 'source.mjs', offset: page.nextOffset,
      expectedSha256: page.sha256 }, root, { allowedTools: ['file_read'] });
    expect(JSON.parse(next.output).offset).toBe(page.nextOffset);
    for (const path of ['../outside.mjs', '.env', 'alias.mjs']) {
      expect((await executeTool('file_read', { path }, root, { allowedTools: ['file_read'] })).status).toBe('failed');
    }
    expect((await executeTool('file_read', { path: 'source.mjs' }, root, { allowedTools: [] })).status).toBe('failed');
  });
});
