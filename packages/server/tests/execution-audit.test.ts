import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createExecution } from '../src/db/models/execution.js';
import { createTask } from '../src/db/models/task.js';
import {
  appendExecutionAuditEvent,
  getExecutionAuditReport,
  recordExecutionPolicySnapshot,
} from '../src/audit/execution-audit.js';

describe('execution audit reports', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-audit-')), 'test.db');
    getDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('persists policy snapshots and audit events', () => {
    const agent = createAgent({ id: 'audit-agent', name: 'Audit Agent', role: 'tester' });
    const task = createTask({ title: 'Audit', description: 'Audit', mode: 'direct', input: 'run', assigneeId: agent.id, workspaceId: 'ws-audit' });
    const execution = createExecution({ taskId: task.id, agentDefId: agent.id, workspaceId: 'ws-audit' });

    recordExecutionPolicySnapshot({
      executionId: execution.id,
      taskId: task.id,
      agentId: agent.id,
      workspaceId: 'ws-audit',
      policySnapshot: {
        modelSelection: { modelId: 'claude-haiku-4.5', source: 'role.route' },
        toolPolicy: { allowedTools: ['web.fetch'], decisions: [] },
      },
    });
    appendExecutionAuditEvent(execution.id, {
      type: 'tool.blocked',
      severity: 'block',
      message: 'Tool shell_exec blocked by policy',
      metadata: { toolName: 'shell_exec' },
    });

    const report = getExecutionAuditReport(execution.id);
    expect(report?.workspaceId).toBe('ws-audit');
    expect(report?.policySnapshot.toolPolicy).toBeTruthy();
    expect(report?.events).toHaveLength(1);
    expect(report?.events[0].type).toBe('tool.blocked');
  });
});
