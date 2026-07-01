import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { jsonToCsv } from '../src/json2csv.ts';

test('jsonToCsv converts a basic array of objects to CSV', () => {
  const csv = jsonToCsv([
    { name: 'Alice', age: 30 },
    { name: 'Bob', age: 25 },
  ]);

  assert.equal(csv, 'name,age\nAlice,30\nBob,25');
});

test('jsonToCsv includes headers from all rows and leaves missing values empty', () => {
  const csv = jsonToCsv([
    { name: 'Alice' },
    { age: 25 },
  ]);

  assert.equal(csv, 'name,age\nAlice,\n,25');
});

test('jsonToCsv quotes commas, quotes, and newlines correctly', () => {
  const csv = jsonToCsv([
    {
      comma: 'a,b',
      quote: 'he said "hi"',
      newline: 'line1\nline2',
    },
  ]);

  assert.equal(
    csv,
    'comma,quote,newline\n"a,b","he said ""hi""","line1\nline2"',
  );
});

test('jsonToCsv stringifies nested top-level objects and arrays', () => {
  const csv = jsonToCsv([
    {
      id: 1,
      meta: { active: true },
      tags: ['a', 'b'],
      empty: null,
    },
  ]);

  assert.equal(csv, 'id,meta,tags,empty\n1,"{""active"":true}","[""a"",""b""]",');
});

test('jsonToCsv returns an empty string for an empty array', () => {
  assert.equal(jsonToCsv([]), '');
});

test('jsonToCsv throws for non-object rows', () => {
  assert.throws(
    () => jsonToCsv([{ valid: true }, 'bad-row' as unknown as object]),
    /Row at index 1 must be an object\./,
  );
});

function runCli(args: string[], options?: { input?: string }) {
  const cliPath = resolve('src/json2csv.ts');
  const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    cwd: resolve('.'),
    input: options?.input,
    encoding: 'utf8',
  });

  return result;
}

test('CLI prints help text', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: json2csv \[file\]/);
  assert.equal(result.stderr, '');
});

test('CLI reads JSON from a file path', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'json2csv-'));

  try {
    const filePath = join(tempDir, 'data.json');
    writeFileSync(filePath, JSON.stringify([{ name: 'Alice' }, { name: 'Bob' }]), 'utf8');

    const result = runCli([filePath]);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'name\nAlice\nBob\n');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI reads JSON from stdin', () => {
  const result = runCli([], {
    input: JSON.stringify([{ name: 'Alice', age: 30 }]),
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'name,age\nAlice,30\n');
  assert.equal(result.stderr, '');
});

test('CLI exits non-zero for malformed JSON', () => {
  const result = runCli([], { input: '{not-json}' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Error: Input is not valid JSON\./);
});

test('CLI exits non-zero for non-array JSON input', () => {
  const result = runCli([], { input: JSON.stringify({ name: 'Alice' }) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Error: Input JSON must be an array of objects\./);
});

test('CLI exits non-zero for non-object items in the input array', () => {
  const result = runCli([], { input: JSON.stringify([{ name: 'Alice' }, 42]) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Error: Item at index 1 must be an object\./);
});
