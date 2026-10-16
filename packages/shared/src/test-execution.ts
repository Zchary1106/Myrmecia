export interface TestRunEvidence {
  command: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
}
export type TestRunStatus = 'passed' | 'failed' | 'skipped' | 'unknown';

/** Process success is not proof that a test command executed any cases. */
export function testExecutionStatus(evidence: TestRunEvidence): TestRunStatus {
  if (evidence.exitCode !== 0) return 'failed';
  if (!/(?:^|\s)(?:test(?::[\w-]+)?|pytest|vitest|jest|mocha|--test)(?:\s|$)/i.test(evidence.command)) return 'passed';
  const text = `${evidence.stdout || ''}\n${evidence.stderr || ''}`
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  // npm's banner "...@1.0.0 test" is not a zero-test summary.
  if (/(?:^|\n)\s*(?:#\s*|ℹ\s*)?(?:no tests?(?: files?| cases?)? (?:found|collected|to run)|0 tests?(?: collected)?)\s*(?=\n|$)/i.test(text)) return 'skipped';
  const totals = [...text.matchAll(/(?:^|\n)\s*(?:#\s*|ℹ\s*)?tests\s+(\d+)\s*(?=\n|$)/gi)];
  if (totals.length) {
    const total = Number(totals.at(-1)![1]);
    const skipped = [...text.matchAll(/(?:^|\n)\s*(?:#\s*|ℹ\s*)?skipped\s+(\d+)\b/gi)];
    if (total === 0 || skipped.length && Number(skipped.at(-1)![1]) >= total) return 'skipped';
    return 'passed';
  }
  // Vitest/Jest, pytest/Mocha and Rust summaries expose numeric executed cases.
  const passed = [...text.matchAll(/\b(\d+)\s+pass(?:ed|ing)\b/gi)];
  const failed = [...text.matchAll(/\b(\d+)\s+fail(?:ed|ing)\b/gi)];
  if (failed.some(match => Number(match[1]) > 0)) return 'failed';
  if (passed.length) return Number(passed.at(-1)![1]) > 0 ? 'passed' : 'skipped';
  if (/\b\d+\s+(?:skipped|pending|ignored)\b/i.test(text)) return 'skipped';
  return 'unknown';
}
