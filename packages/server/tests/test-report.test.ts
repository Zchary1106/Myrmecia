import { describe, expect, it } from 'vitest';
import { createTestReportFromOutput, extractStructuredTestEvidence, hasVerifiedTestEvidence, isTestingStage } from '../src/testing/test-report.js';

describe('test report artifacts', () => {
  it.each(['ℹ tests 0\nℹ pass 0', '# tests 0\n# pass 0', 'Tests  3 skipped (3)',
    'Tests: 2 skipped, 2 total', '0 passing (10ms)', ''])(
    'does not verify a successful test command without executed cases: %s', stdout => {
      const report = createTestReportFromOutput(JSON.stringify({
        command: 'npm test', cwd: '/repo', exitCode: 0, stdout, stderr: '',
      }));
      expect(report.status).not.toBe('passed');
      expect(hasVerifiedTestEvidence(report)).toBe(false);
    });
  it('keeps a successful non-test validation command verifiable', () => {
    const report = createTestReportFromOutput(JSON.stringify({
      command: 'npm run lint', cwd: '/repo', exitCode: 0, stdout: '', stderr: '',
    }));
    expect(report.status).toBe('passed');
    expect(hasVerifiedTestEvidence(report)).toBe(true);
  });
  it.each(['ℹ tests 9\nℹ pass 9\nℹ fail 0\nℹ skipped 0', '# tests 9\n# pass 9\n# fail 0\n# skipped 0'])(
    'does not mistake an npm package-version banner for zero executed tests: %s', summary => {
      const report = createTestReportFromOutput(JSON.stringify({
        command: 'npm test', cwd: '/repo', exitCode: 0,
        stdout: `\n> myrmecia-task-board-pilot@1.0.0 test\n> node --test test/*.test.mjs\n\n${summary}\n`, stderr: '',
      }));
      expect(report.status).toBe('passed');
      expect(hasVerifiedTestEvidence(report)).toBe(true);
    });
  it.each(['0 tests', 'No tests found', 'ℹ tests 0\nℹ pass 0'])(
    'still rejects genuinely empty tests behind an npm version banner: %s', summary => {
      const report = createTestReportFromOutput(JSON.stringify({
        command: 'npm test', cwd: '/repo', exitCode: 0,
        stdout: `> pilot@1.0.0 test\n> node --test\n${summary}\n`,
      }));
      expect(report.status).not.toBe('passed');
    });
  it('extracts commands, failures, files, and coverage notes from QA output', () => {
    const report = createTestReportFromOutput(`
      pnpm --filter @myrmecia/server exec vitest run tests/example.test.ts
      FAIL tests/example.test.ts > rejects invalid token
      src/auth/token-auth.ts
      Coverage: lines 82%
    `);

    expect(report.status).toBe('failed');
    expect(report.commands[0]).toContain('pnpm --filter');
    expect(report.failures[0]).toContain('FAIL');
    expect(report.changedFiles).toContain('src/auth/token-auth.ts');
    expect(report.coverageNotes).toContain('Coverage');
    expect(report.nextFix).toBeTruthy();
  });

  it('detects testing stages by role or name', () => {
    expect(isTestingStage('Run Focused Validation', 'qa-automation')).toBe(true);
    expect(isTestingStage('Security Review', 'security-reviewer')).toBe(false);
  });

  it('uses structured execution evidence over ambiguous textual output', () => {
    const report = createTestReportFromOutput(`\`\`\`json
{"command":"pnpm test","cwd":"/repo","exitCode":0,"stdout":"12 passed","stderr":"","failedTests":[]}
\`\`\``);

    expect(extractStructuredTestEvidence(JSON.stringify(report.evidence))).toMatchObject({ command: 'pnpm test', cwd: '/repo', exitCode: 0 });
    expect(report.status).toBe('passed');
    expect(report.commands).toContain('pnpm test');
    expect(hasVerifiedTestEvidence(report)).toBe(true);
  });

  it('keeps legacy output compatible but does not treat it as verified evidence', () => {
    const report = createTestReportFromOutput('pnpm test\nPASS tests/example.test.ts');
    expect(report.status).toBe('passed');
    expect(hasVerifiedTestEvidence(report)).toBe(false);
  });

  it('marks a structured non-zero exit as a failed validation', () => {
    const report = createTestReportFromOutput(JSON.stringify({
      command: 'pnpm test', cwd: '/repo', exitCode: 1, stderr: 'FAIL tests/example.test.ts', failedTests: ['tests/example.test.ts'],
    }));
    expect(report.status).toBe('failed');
    expect(report.failures).toContain('tests/example.test.ts');
  });
});
