import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectQualityWorkspaceEvidence, createReviewPrompt } from '../src/pipelines/quality-loop.js';
import { createTestReportFromOutput } from '../src/testing/test-report.js';
import type { Task } from '../src/types.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'myrmecia-complete-review-'));
  writeFileSync(join(root, 'README.md'), 'Baseline\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local',
    'commit', '-qm', 'Fixture'], { cwd: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const task = () => ({ id: 'fixture-review', workdir: root } as Task);

describe('complete bounded implementation review evidence', () => {
  it('keeps full files and their trailing code above the old 12000-character clipping threshold', () => {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    const server = '// server\n'.repeat(1500) + 'SERVER_FINAL_LINE\n';
    const store = '// store\n'.repeat(900) + 'STORE_FINAL_LINE\n';
    const tests = '// tests\n'.repeat(1000) + 'TESTS_FINAL_LINE\n';
    writeFileSync(join(root, 'src/server.mjs'), server);
    writeFileSync(join(root, 'src/store.mjs'), store);
    writeFileSync(join(root, 'test/board.test.mjs'), tests);
    mkdirSync(join(root, 'output/executions'), { recursive: true });
    writeFileSync(join(root, 'output/summary.md'), 'Not implementation'.repeat(10_000));
    writeFileSync(join(root, 'output/executions/exec_deadbeef.md'), 'Not implementation'.repeat(10_000));
    const evidence = collectQualityWorkspaceEvidence(task());
    expect(evidence.changedFiles).toEqual(['src/server.mjs', 'src/store.mjs', 'test/board.test.mjs']);
    const report = createTestReportFromOutput(JSON.stringify({ command: 'npm test', exitCode: 0, stdout: 'ℹ tests 9\nℹ pass 9' }));
    const prompt = createReviewPrompt(task(), report, evidence);
    for (const full of [server, store, tests]) {
      expect(evidence.diff).toContain(full);
      expect(prompt).toContain(full);
    }
    expect(evidence.diff).not.toContain('[truncated]');
    expect(evidence.diff).not.toContain('Not implementation');
  });

  it('refuses over-quota snapshots instead of sending truncated implementation to Review or Fix', () => {
    writeFileSync(join(root, 'large.mjs'), 'x'.repeat(65_000));
    expect(() => collectQualityWorkspaceEvidence(task())).toThrow('QUALITY_IMPLEMENTATION_EVIDENCE_QUOTA');
    const report = createTestReportFromOutput(JSON.stringify({ command: 'npm test', exitCode: 0, stdout: '1 passed' }));
    expect(() => createReviewPrompt(task(), report, { changedFiles: ['large.mjs'], diff: 'x'.repeat(65_000) }))
      .toThrow('QUALITY_IMPLEMENTATION_EVIDENCE_QUOTA');
  });

  it('fails closed on unavailable safe file reads rather than hiding a missing file in an evidence summary', () => {
    symlinkSync('README.md', join(root, 'alias.mjs'));
    expect(() => collectQualityWorkspaceEvidence(task())).toThrow('QUALITY_IMPLEMENTATION_FILE_UNAVAILABLE');
  });

  it('does not silently drop changed files exceeding the file count quota', () => {
    for (let i = 0; i < 101; i++) writeFileSync(join(root, `new-${i}.mjs`), '// code\n');
    expect(() => collectQualityWorkspaceEvidence(task())).toThrow('QUALITY_IMPLEMENTATION_FILE_QUOTA');
  });
  it.each(['.env', 'secrets.json'])('never sends excluded paths to the complete review snapshot: %s', path => {
    writeFileSync(join(root, path), 'Dummy fixture value, not a real credential');
    expect(() => collectQualityWorkspaceEvidence(task())).toThrow('QUALITY_IMPLEMENTATION_UNSAFE_PATH');
  });
});
