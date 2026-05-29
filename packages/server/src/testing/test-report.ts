import type { TestReport, TestReportStatus } from '../types.js';

const COMMAND_PATTERNS = [
  /\bpnpm\s+[^\n`]+/g,
  /\bnpm\s+(?:run\s+)?[^\n`]+/g,
  /\bvitest\s+[^\n`]+/g,
  /\bplaywright\s+test[^\n`]*/g,
];

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function inferStatus(output: string): TestReportStatus {
  const lower = output.toLowerCase();
  if (/\b(0 tests?|no tests?)\b/.test(lower) || /\bskipped\b/.test(lower)) return 'skipped';
  if (/\b(fail|failed|failing|error|exception|timeout)\b/.test(lower)) return 'failed';
  if (/\b(pass|passed|success|succeeded|ok)\b/.test(lower)) return 'passed';
  return 'unknown';
}

function extractCommands(output: string): string[] {
  const commands: string[] = [];
  for (const pattern of COMMAND_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      commands.push(match[0].replace(/\s+/g, ' ').trim());
    }
  }
  return unique(commands).slice(0, 20);
}

function extractFailures(output: string): string[] {
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => /\b(fail|failed|error|exception|timeout)\b/i.test(line))
    .slice(0, 20);
}

function extractChangedFiles(output: string): string[] {
  return unique(
    output.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|py|json|yaml|yml|md|sql|css)\b/g) || [],
  ).slice(0, 50);
}

function extractCoverageNotes(output: string): string | undefined {
  const coverageLines = output
    .split('\n')
    .filter(line => /\bcoverage\b|%\s*$|\bbranches\b|\blines\b/i.test(line))
    .slice(0, 12)
    .join('\n')
    .trim();
  return coverageLines || undefined;
}

export function createTestReportFromOutput(output: string, fallbackSummary = 'QA validation completed'): TestReport {
  const status = inferStatus(output);
  const failures = extractFailures(output);
  const summaryLine = output.split('\n').map(line => line.trim()).find(Boolean);
  return {
    schemaVersion: 1,
    status,
    commands: extractCommands(output),
    failures,
    changedFiles: extractChangedFiles(output),
    coverageNotes: extractCoverageNotes(output),
    summary: summaryLine || fallbackSummary,
    nextFix: status === 'failed' ? failures[0] || 'Inspect failing test output and fix the reported regression.' : undefined,
    createdAt: new Date().toISOString(),
  };
}

export function isTestingStage(stageName: string, agentRole: string): boolean {
  return /qa|test|验证|测试/i.test(`${stageName} ${agentRole}`);
}
