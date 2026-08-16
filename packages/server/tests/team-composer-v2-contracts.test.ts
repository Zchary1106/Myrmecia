/**
 * Contract v2 validators — Team / Workflow Node / Execution Plan Snapshot.
 */

import { describe, expect, it } from 'vitest';
import {
  validateExecutionPlanSnapshot,
  validateResolvedRoleCapability,
  validateTeamContractV2,
  validateWorkflowNodeV2,
} from '../src/contracts/team-composer-contracts.js';

const validTeam = {
  schemaVersion: '2.0',
  id: 'xiaohongshu',
  name: 'Xiaohongshu Team',
  version: 2,
  lead: 'creator',
  domainIds: ['tech-product'],
  roles: [
    { slot: 'researcher', agentId: 'researcher', skills: ['social-trend-evidence'], tools: ['web.search'] },
    { slot: 'creator', agentId: 'content-creator', skills: ['xiaohongshu-copywriting', 'hashtag-planning'] },
    { slot: 'reviewer', agentId: 'review', skills: ['social-compliance'] },
  ],
  policy: {
    requireHumanApprovalBefore: ['publish'],
    disallowedTools: ['shell_exec'],
  },
  pipelineTemplate: 'Xiaohongshu Publish v2',
  members: ['trend-scout', 'xiaohongshu-writer'],
};

describe('validateTeamContractV2', () => {
  it('accepts a valid v2 team', () => {
    const result = validateTeamContractV2(validTeam);
    expect(result.valid).toBe(true);
    expect(result.value?.id).toBe('xiaohongshu');
    expect(result.value?.roles).toHaveLength(3);
  });

  it('rejects the v1 schemaVersion', () => {
    const result = validateTeamContractV2({ ...validTeam, schemaVersion: '1.0' });
    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.path)).toContain('schemaVersion');
  });

  it('rejects duplicate role slots', () => {
    const result = validateTeamContractV2({
      ...validTeam,
      roles: [...validTeam.roles, { slot: 'creator', agentId: 'dev' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Duplicate role slots: creator');
  });

  it('rejects a lead that is not a declared slot', () => {
    const result = validateTeamContractV2({ ...validTeam, lead: 'nobody' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('lead');
  });

  it('rejects teams with no role slots', () => {
    const result = validateTeamContractV2({ ...validTeam, roles: [] });
    expect(result.valid).toBe(false);
  });
});

describe('validateWorkflowNodeV2', () => {
  const validNode = {
    id: 'node-1',
    roleSlot: 'creator',
    requiredCapabilities: ['copywriting'],
    skillIds: ['xiaohongshu-copywriting'],
    toolIds: ['web.search'],
    inputs: [{ name: 'evidence', kind: 'json', required: true }],
    outputs: [{ name: 'copy', kind: 'markdown', required: true }],
    gate: { kind: 'auto', blocking: true },
    retry: { maxAttempts: 2, onExhausted: 'human' },
  };

  it('accepts a valid v2 node', () => {
    const result = validateWorkflowNodeV2(validNode);
    expect(result.valid).toBe(true);
    expect(result.value?.roleSlot).toBe('creator');
  });

  it('rejects nodes without declared outputs', () => {
    const result = validateWorkflowNodeV2({ ...validNode, outputs: [] });
    expect(result.valid).toBe(false);
  });

  it('rejects duplicate output artifact names', () => {
    const result = validateWorkflowNodeV2({
      ...validNode,
      outputs: [
        { name: 'copy', kind: 'markdown', required: true },
        { name: 'copy', kind: 'text', required: true },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Duplicate output artifact names: copy');
  });
});

describe('validateExecutionPlanSnapshot', () => {
  const validSnapshot = {
    schemaVersion: '2.0',
    snapshotId: 'snap-123',
    teamId: 'xiaohongshu',
    teamVersion: 2,
    pipelineTemplate: 'Xiaohongshu Publish v2',
    roles: [
      {
        slot: 'creator',
        agentId: 'content-creator',
        legacyAgentId: 'xiaohongshu-writer',
        skills: ['xiaohongshu-copywriting'],
        tools: [],
        domainIds: [],
        capabilities: ['copywriting'],
      },
    ],
    policy: { requireHumanApprovalBefore: ['publish'] },
    gates: [{ nodeId: 'node-9', gate: { kind: 'human-approval', reason: 'publish gate' } }],
    createdAt: '2026-08-15T00:00:00.000Z',
    checksum: 'a'.repeat(64),
  };

  it('accepts a valid snapshot', () => {
    const result = validateExecutionPlanSnapshot(validSnapshot);
    expect(result.valid).toBe(true);
    expect(result.value?.roles[0].legacyAgentId).toBe('xiaohongshu-writer');
  });

  it('rejects a non-sha256 checksum', () => {
    const result = validateExecutionPlanSnapshot({ ...validSnapshot, checksum: 'not-a-checksum' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('checksum');
  });

  it('rejects a snapshot without resolved roles', () => {
    const result = validateExecutionPlanSnapshot({ ...validSnapshot, roles: [] });
    expect(result.valid).toBe(false);
  });
});

describe('validateResolvedRoleCapability', () => {
  it('accepts a resolved role', () => {
    const result = validateResolvedRoleCapability({
      slot: 'creator',
      agentId: 'content-creator',
      skills: ['xiaohongshu-copywriting'],
      tools: [],
      domainIds: [],
      capabilities: [],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects missing agent binding', () => {
    const result = validateResolvedRoleCapability({
      slot: 'creator',
      skills: [],
      tools: [],
      domainIds: [],
      capabilities: [],
    });
    expect(result.valid).toBe(false);
  });
});
