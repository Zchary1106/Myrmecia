import { Check, CircleAlert, FileSearch, TerminalSquare } from 'lucide-react';
import { cn } from '../../lib/utils';

type ReviewFinding = {
  severity?: string;
  file?: string;
  line?: number;
  evidence?: string;
  requiredFix?: string;
};

type ReviewResult = {
  kind: 'review';
  approved: boolean;
  summary?: string;
  findings: ReviewFinding[];
};

type ValidationResult = {
  kind: 'validation';
  command?: string;
  cwd?: string;
  exitCode: number;
  failedTests: string[];
};

type StructuredResult = ReviewResult | ValidationResult;

function parseRecord(value: string): Record<string, unknown> | null {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // A partially streamed result can still be recognized by its fields below.
    }
  }
  return null;
}

function partialString(value: string, key: string): string | undefined {
  const match = value.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"])*)"`));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
}

function partialBoolean(value: string, key: string): boolean | undefined {
  const match = value.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`));
  return match ? match[1] === 'true' : undefined;
}

function partialNumber(value: string, key: string): number | undefined {
  const match = value.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`));
  return match ? Number(match[1]) : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

export function parseStructuredTaskResult(value: string): StructuredResult | null {
  const record = parseRecord(value);
  const approved = typeof record?.approved === 'boolean' ? record.approved : partialBoolean(value, 'approved');
  if (approved !== undefined) {
    const findings = Array.isArray(record?.findings)
      ? record.findings.filter((finding): finding is ReviewFinding => Boolean(finding && typeof finding === 'object'))
      : [];
    return {
      kind: 'review',
      approved,
      summary: typeof record?.summary === 'string' ? record.summary : partialString(value, 'summary'),
      findings,
    };
  }

  const exitCode = typeof record?.exitCode === 'number' ? record.exitCode : partialNumber(value, 'exitCode');
  if (exitCode !== undefined) {
    return {
      kind: 'validation',
      command: typeof record?.command === 'string' ? record.command : partialString(value, 'command'),
      cwd: typeof record?.cwd === 'string' ? record.cwd : partialString(value, 'cwd'),
      exitCode,
      failedTests: stringList(record?.failedTests),
    };
  }

  return null;
}

export function looksLikeStructuredResult(value: string): boolean {
  return value.trimStart().startsWith('{') || value.trimStart().startsWith('```json');
}

/** A single-line, human-readable signal for compact dashboard surfaces. */
export function structuredResultSummary(output: string): string | null {
  const result = parseStructuredTaskResult(output);
  if (!result) {
    return looksLikeStructuredResult(output) ? 'Structured result available' : null;
  }

  if (result.kind === 'validation') {
    const passed = result.exitCode === 0 && result.failedTests.length === 0;
    const label = passed ? 'Validation passed' : 'Validation needs attention';
    const failures = result.failedTests.length > 0
      ? ` · ${result.failedTests.length} failed test${result.failedTests.length === 1 ? '' : 's'}`
      : '';
    return `${label} · Exit code ${result.exitCode}${failures}`;
  }

  const label = result.approved ? 'Review approved' : 'Changes requested';
  const findings = !result.approved && result.findings.length > 0
    ? ` · ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}`
    : '';
  return `${label}${findings}${result.summary ? ` · ${result.summary}` : ''}`;
}

function severityTone(severity?: string): string {
  if (severity === 'critical' || severity === 'high') return 'border-red-400/25 bg-red-400/[0.05] text-red-500';
  if (severity === 'medium') return 'border-amber-400/25 bg-amber-400/[0.06] text-amber-600';
  return 'border-border bg-background/45 text-app-secondary';
}

export function StructuredTaskResult({ output, compact = false }: { output: string; compact?: boolean }) {
  const result = parseStructuredTaskResult(output);
  if (!result) {
    if (!looksLikeStructuredResult(output)) return null;
    return (
      <div className="rounded-xl border border-border/80 bg-background/40 px-3.5 py-3">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-app-muted"><FileSearch size={13} /> Structured result</div>
        <p className="mt-1.5 text-xs leading-5 text-app-secondary">The Agent returned structured evidence. Open execution details to inspect the raw payload.</p>
      </div>
    );
  }

  if (result.kind === 'validation') {
    const passed = result.exitCode === 0 && result.failedTests.length === 0;
    return (
      <div className={cn('rounded-xl border px-3.5 py-3', passed ? 'border-emerald-400/25 bg-emerald-400/[0.045]' : 'border-red-400/25 bg-red-400/[0.05]')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className={cn('flex items-center gap-2 text-xs font-semibold', passed ? 'text-emerald-600' : 'text-red-500')}>
            {passed ? <Check size={15} /> : <CircleAlert size={15} />}
            {passed ? 'Validation completed' : 'Validation needs attention'}
          </div>
          <span className={cn('rounded-md px-2 py-0.5 text-[10px] font-medium', passed ? 'bg-emerald-400/10 text-emerald-600' : 'bg-red-400/10 text-red-500')}>Exit code {result.exitCode}</span>
        </div>
        {compact && result.failedTests.length > 0 && (
          <p className="mt-1.5 truncate text-[11px] text-app-secondary">
            {result.failedTests.length} failed test{result.failedTests.length === 1 ? '' : 's'} · Open the task conversation for details
          </p>
        )}
        {!compact && result.command && <div className="mt-3 rounded-lg bg-background/55 px-3 py-2 font-mono text-[11px] text-app-secondary">{result.command}</div>}
        {!compact && result.failedTests.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-red-500">Failed tests</div>
            <ul className="mt-1.5 space-y-1 text-xs leading-5 text-app-secondary">
              {result.failedTests.map(test => <li key={test}>• {test}</li>)}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn('rounded-xl border px-3.5 py-3', result.approved ? 'border-emerald-400/25 bg-emerald-400/[0.045]' : 'border-amber-400/30 bg-amber-400/[0.055]')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={cn('flex items-center gap-2 text-xs font-semibold', result.approved ? 'text-emerald-600' : 'text-amber-700')}>
          {result.approved ? <Check size={15} /> : <CircleAlert size={15} />}
          {result.approved ? 'Review approved' : 'Changes requested'}
        </div>
        {!result.approved && result.findings.length > 0 && <span className="rounded-md bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-700">{result.findings.length} finding{result.findings.length === 1 ? '' : 's'}</span>}
      </div>
      {result.summary && (
        <p className={cn('text-app-secondary', compact ? 'mt-1.5 truncate text-[11px]' : 'mt-2.5 text-sm leading-6')}>
          {result.summary}
        </p>
      )}
      {!compact && result.findings.length > 0 && (
        <div className="mt-3 space-y-2">
          {result.findings.map((finding, index) => (
            <article key={`${finding.file || 'finding'}:${finding.line || index}`} className={cn('rounded-lg border px-3 py-2.5', severityTone(finding.severity))}>
              <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.11em]">
                <span>{finding.severity || 'finding'}</span>
                {finding.file && <span className="normal-case tracking-normal text-app-muted">{finding.file}{finding.line ? `:${finding.line}` : ''}</span>}
              </div>
              {finding.evidence && <p className="mt-1.5 text-xs leading-5 text-app-secondary">{finding.evidence}</p>}
              {finding.requiredFix && <p className="mt-2 border-t border-current/10 pt-2 text-xs leading-5 text-app-secondary"><span className="font-medium">Required fix: </span>{finding.requiredFix}</p>}
            </article>
          ))}
        </div>
      )}
      {!compact && !result.approved && result.findings.length === 0 && <p className="mt-2 text-xs leading-5 text-app-secondary">The reviewer did not provide a structured finding. Check the execution details for the raw evidence.</p>}
    </div>
  );
}
