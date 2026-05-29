import { describe, expect, it } from 'vitest';
import { createTestReportFromOutput, isTestingStage } from '../src/testing/test-report.js';

describe('test report artifacts', () => {
  it('extracts commands, failures, files, and coverage notes from QA output', () => {
    const report = createTestReportFromOutput(`
      pnpm --filter @agent-factory/server exec vitest run tests/example.test.ts
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
});
