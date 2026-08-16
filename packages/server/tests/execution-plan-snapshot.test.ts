/**
 * Execution Plan Snapshot — immutable capability/config snapshot persisted to the ledger.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import type { ExecutionPlanSnapshot } from '../src/types.js';
import {
  getExecutionPlanSnapshot,
  recordExecutionPlanSnapshot,
} from '../src/agents/execution-plan-snapshot.js';

const snapshot: ExecutionPlanSnapshot = {
  schemaVersion: '2.0',
  snapshotId: 'snap-001',
  teamId: 'xiaohongshu',
  teamVersion: 2,
  pipelineTemplate: 'Xiaohongshu Publish v2',
  roles: [
    {
      slot: 'creator',
      agentId: 'content-creator',
      legacyAgentId: 'xiaohongshu-writer',
      skills: ['xiaohongshu-copywriting', 'hashtag-planning'],
      tools: [],
      domainIds: [],
      capabilities: ['copywriting'],
    },
  ],
  policy: { requireHumanApprovalBefore: ['publish'] },
  gates: [{ nodeId: 'n9', gate: { kind: 'human-approval', reason: 'publish gate' } }],
  createdAt: '2026-08-15T00:00:00.000Z',
  checksum: 'a'.repeat(64),
};

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'plan-snapshot-')), 'test.db');
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
});

describe('ExecutionPlanSnapshot', () => {
  it('records a snapshot and reads it back intact', () => {
    recordExecutionPlanSnapshot({
      executionId: 'exec-1',
      workspaceId: 'default',
      snapshot,
      taskId: 'task-1',
      agentId: 'master',
    });

    const restored = getExecutionPlanSnapshot('exec-1');
    expect(restored).toBeDefined();
    expect(restored?.snapshotId).toBe('snap-001');
    expect(restored?.teamId).toBe('xiaohongshu');
    expect(restored?.roles[0].legacyAgentId).toBe('xiaohongshu-writer');
    expect(restored?.policy.requireHumanApprovalBefore).toEqual(['publish']);
  });

  it('returns undefined when no snapshot was recorded', () => {
    expect(getExecutionPlanSnapshot('exec-missing')).toBeUndefined();
  });

  it('rejects an invalid snapshot before writing', () => {
    expect(() => recordExecutionPlanSnapshot({
      executionId: 'exec-2',
      workspaceId: 'default',
      snapshot: { ...snapshot, checksum: 'not-a-checksum' },
    })).toThrow(/checksum/);
    expect(getExecutionPlanSnapshot('exec-2')).toBeUndefined();
  });

  it('keeps the latest snapshot per execution id', () => {
    recordExecutionPlanSnapshot({ executionId: 'exec-3', workspaceId: 'default', snapshot });
    const newer = { ...snapshot, snapshotId: 'snap-002', checksum: 'b'.repeat(64) };
    recordExecutionPlanSnapshot({ executionId: 'exec-3', workspaceId: 'default', snapshot: newer });

    const restored = getExecutionPlanSnapshot('exec-3');
    expect(restored?.snapshotId).toBe('snap-002');
  });
});
