import { describe, expect, it } from 'vitest';
import { evaluateReleaseGate } from '../src/deploy/release-gate.js';
import type { ExecutionAuditReport } from '../src/audit/execution-audit.js';
import type { TestReport } from '../src/types.js';

function testReport(overrides: Partial<TestReport>): TestReport {
  return {
    schemaVersion: 1,
    status: 'passed',
    commands: [],
    failures: [],
    changedFiles: [],
    summary: 'ok',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function auditReport(events: ExecutionAuditReport['events']): ExecutionAuditReport {
  return {
    executionId: 'exec_1',
    taskId: 'task_1',
    agentId: 'agent_1',
    workspaceId: 'default',
    policySnapshot: {},
    events,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('release gate', () => {
  it('blocks failed QA and blocking audit events', () => {
    const result = evaluateReleaseGate({
      testReports: [testReport({ status: 'failed', summary: 'regression failed' })],
      auditReports: [auditReport([{ type: 'tool.blocked', severity: 'block', message: 'dangerous command blocked' }])],
    });

    expect(result.passed).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('QA failed'),
      expect.stringContaining('dangerous command'),
    ]));
  });

  it('promotes dependency/license warnings to release blockers by default', () => {
    const result = evaluateReleaseGate({
      testReports: [testReport({ status: 'passed' })],
      auditReports: [auditReport([{ type: 'tool.failed', severity: 'warn', message: 'dependency-license-review warning' }])],
    });

    expect(result.passed).toBe(false);
    expect(result.blockers[0]).toContain('dependency/license review');
  });
});
