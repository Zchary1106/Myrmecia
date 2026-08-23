import { describe, expect, it } from 'vitest';
import { createTestReportFromOutput, extractStructuredTestEvidence, hasVerifiedTestEvidence, isTestingStage } from '../src/testing/test-report.js';

describe('test report artifacts', () => {
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
