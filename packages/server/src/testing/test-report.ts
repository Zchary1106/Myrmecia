import type { TestReport, TestReportStatus } from '../types.js';

/**
 * Evidence emitted by a test runner.  It is deliberately kept alongside the
 * legacy text parser: old agents can still produce a useful report, while a
 * quality gate can require this stronger, machine-verifiable form.
 */
export interface TestExecutionEvidence {
  command: string;
  cwd: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  failedTests?: string[];
}

export type TestReportWithEvidence = TestReport & {
  evidence?: TestExecutionEvidence;
};

const MAX_EVIDENCE_TEXT = 12_000;

const COMMAND_PATTERNS = [
  /\bpnpm\s+[^\n`]+/g,
  /\bnpm\s+(?:run\s+)?[^\n`]+/g,
  /\bvitest\s+[^\n`]+/g,
  /\bplaywright\s+test[^\n`]*/g,
];

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function truncate(value: string | undefined, limit = MAX_EVIDENCE_TEXT): string | undefined {
  if (!value) return undefined;
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? unique(value.filter((item): item is string => typeof item === 'string')) : [];
}

/** Accept a JSON object directly or in a fenced `json` block. */
export function extractStructuredTestEvidence(output: string): TestExecutionEvidence | undefined {
  const candidates = [
    output.trim(),
    ...Array.from(output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi), match => match[1].trim()),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const source = parsed.evidence && typeof parsed.evidence === 'object'
        ? parsed.evidence as Record<string, unknown>
        : parsed;
      if (typeof source.command !== 'string' || typeof source.cwd !== 'string' ||
          typeof source.exitCode !== 'number' || !Number.isFinite(source.exitCode)) continue;
      return {
        command: source.command.trim(),
        cwd: source.cwd.trim(),
        exitCode: source.exitCode,
        stdout: truncate(typeof source.stdout === 'string' ? source.stdout : undefined),
        stderr: truncate(typeof source.stderr === 'string' ? source.stderr : undefined),
        failedTests: asStringArray(source.failedTests).slice(0, 50),
      };
    } catch {
      // A legacy textual report is expected to be non-JSON.
    }
  }
  return undefined;
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

export function createTestReportFromOutput(output: string, fallbackSummary = 'QA validation completed'): TestReportWithEvidence {
  const evidence = extractStructuredTestEvidence(output);
  const status = evidence ? (evidence.exitCode === 0 ? 'passed' : 'failed') : inferStatus(output);
  const failures = unique([
    ...(evidence?.failedTests || []),
    ...extractFailures(evidence?.stderr || ''),
    ...extractFailures(output),
  ]).slice(0, 50);
  const summaryLine = output.split('\n').map(line => line.trim()).find(Boolean);
  return {
    schemaVersion: 1,
    status,
    commands: unique([evidence?.command || '', ...extractCommands(output)]).slice(0, 20),
    failures,
    changedFiles: extractChangedFiles(`${output}\n${evidence?.stdout || ''}\n${evidence?.stderr || ''}`),
    coverageNotes: extractCoverageNotes(output),
    summary: summaryLine || fallbackSummary,
    nextFix: status === 'failed' ? failures[0] || 'Inspect failing test output and fix the reported regression.' : undefined,
    createdAt: new Date().toISOString(),
    ...(evidence ? { evidence } : {}),
  };
}

/** A passed legacy text report is informative, but not sufficient for a hard QA gate. */
export function hasVerifiedTestEvidence(report: TestReportWithEvidence): boolean {
  return report.status === 'passed' && Boolean(
    report.evidence && report.evidence.command && report.evidence.cwd && Number.isFinite(report.evidence.exitCode),
  );
}

export function isTestingStage(stageName: string, agentRole: string): boolean {
  return /qa|test|验证|测试/i.test(`${stageName} ${agentRole}`);
}
