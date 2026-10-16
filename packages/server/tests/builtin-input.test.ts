import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinInputErrors } from '../src/tools/builtin-input.js';
import { executeTool } from '../src/skills/tool-sandbox.js';

describe('server-owned builtin tool input validation', () => {
  it.each([{}, null, [], { path: 'note.txt' }, { path: 'note.txt', content: 9 },
    { path: '  ', content: 'x' }, { path: 8, content: 'x' }])('rejects an invalid file write before effects: %j', input => {
    expect(builtinInputErrors('file_write', input).length).toBeGreaterThan(0);
  });
  it('accepts an intentional empty file and unambiguous legacy aliases without coercion', () => {
    expect(builtinInputErrors('file_write', { path: 'note.txt', content: '' })).toEqual([]);
    expect(builtinInputErrors('file_read', { file_path: 'note.txt' })).toEqual([]);
    expect(builtinInputErrors('shell_exec', { cmd: 'npm test' })).toEqual([]);
    expect(builtinInputErrors('file_write', { path: 'a', file_path: 'b', content: 'x' })[0]).toContain('Conflicting');
  });
  it('does not alter or apply server schemas to custom tools', () => {
    expect(builtinInputErrors('external.custom', { custom: 'data' })).toEqual([]);
  });
  it('guards direct sandbox callers so a missing content never truncates an existing file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-invalid-write-'));
    writeFileSync(join(root, 'note.txt'), 'preserve');
    const bad = await executeTool('file_write', { path: 'note.txt' }, root, { allowedTools: ['file_write'] });
    expect(bad).toMatchObject({ status: 'failed', output: expect.stringContaining('TOOL_INPUT_INVALID') });
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('preserve');
  });
});
