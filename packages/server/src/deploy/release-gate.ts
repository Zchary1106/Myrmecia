import type { ExecutionAuditReport, ExecutionAuditEvent } from '../audit/execution-audit.js';
import type { TestReport } from '../types.js';

export interface ReleaseGateInput {
  testReports: TestReport[];
  auditReports: ExecutionAuditReport[];
  allowDependencyWarnings?: boolean;
}

export interface ReleaseGateResult {
  passed: boolean;
  blockers: string[];
  warnings: string[];
}

function auditEvents(reports: ExecutionAuditReport[]): ExecutionAuditEvent[] {
  return reports.flatMap(report => report.events || []);
}

export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const report of input.testReports) {
    if (report.status === 'failed') {
      blockers.push(`QA failed: ${report.summary}`);
    } else if (report.status === 'unknown') {
      warnings.push(`QA status unknown: ${report.summary}`);
    }
  }

  for (const event of auditEvents(input.auditReports)) {
    if (event.severity === 'block' || event.severity === 'error') {
      blockers.push(`Audit ${event.type}: ${event.message}`);
    } else if (event.severity === 'warn') {
      warnings.push(`Audit ${event.type}: ${event.message}`);
    }
  }

  const dependencyWarnings = warnings.filter(warning => /dependency|license|supply-chain/i.test(warning));
  if (!input.allowDependencyWarnings && dependencyWarnings.length > 0) {
    blockers.push(...dependencyWarnings.map(warning => `Release gate requires dependency/license review: ${warning}`));
  }

  return { passed: blockers.length === 0, blockers, warnings };
}
