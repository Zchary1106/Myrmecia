/**
 * Team Preflight — 缺能力 / 离线 Tool / 授权不足 / 高风险无 Gate / 策略冲突。
 */

import { describe, expect, it } from 'vitest';
import type { TeamContractV2, WorkflowNodeV2 } from '../src/types.js';
import { runTeamPreflight } from '../src/agents/team-preflight.js';

const team: TeamContractV2 = {
  schemaVersion: '2.0',
  id: 'xiaohongshu',
  name: 'Xiaohongshu Team',
  version: 2,
  lead: 'creator',
  roles: [
    { slot: 'researcher', agentId: 'researcher', skills: ['social-trend-evidence'], tools: ['web.search'] },
    { slot: 'creator', agentId: 'content-creator', skills: ['xiaohongshu-copywriting'] },
    { slot: 'operator', agentId: 'ops', skills: ['social-publish-preflight', 'social-publishing'], tools: ['xiaohongshu-mcp'] },
  ],
  policy: { requireHumanApprovalBefore: ['publish'] },
};

const nodes: WorkflowNodeV2[] = [
  {
    id: 'n1',
    roleSlot: 'researcher',
    requiredCapabilities: ['research'],
    skillIds: ['social-trend-evidence'],
    inputs: [],
    outputs: [{ name: 'evidence', kind: 'json', required: true }],
  },
  {
    id: 'n9',
    roleSlot: 'operator',
    requiredCapabilities: ['publish'],
    skillIds: ['social-publishing'],
    inputs: [],
    outputs: [{ name: 'published', kind: 'json', required: true }],
    gate: { kind: 'human-approval', reason: 'publish gate' },
  },
];

const okDeps = {
  getAgent: (id: string) => ({ id }),
  getSkill: (id: string) => ({ id }),
  getTool: (id: string) => ({ id }),
  getDomain: (id: string) => ({ id }),
  resolveAlias: () => undefined,
  toolStatus: (id: string) => ({
    id,
    enabled: true,
    approvalRequired: false,
    riskLevel: 'medium' as const,
  }),
};

describe('runTeamPreflight', () => {
  it('passes a valid team with an approval gate on publish', () => {
    const result = runTeamPreflight(team, nodes, okDeps);
    expect(result.pass).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.plan?.roles).toHaveLength(3);
  });

  it('fails on an unknown skill', () => {
    const result = runTeamPreflight(
      { ...team, roles: [{ slot: 'creator', agentId: 'content-creator', skills: ['missing-skill'] }] },
      [],
      { ...okDeps, getSkill: () => undefined },
    );
    expect(result.pass).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('unknown_skill');
  });

  it('fails when a tool is offline', () => {
    const result = runTeamPreflight(team, nodes, {
      ...okDeps,
      toolStatus: (id: string) => ({ enabled: id !== 'xiaohongshu-mcp', approvalRequired: false, riskLevel: 'medium' }),
    });
    expect(result.pass).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('tool_offline');
  });

  it('fails when a tool requires approval but no gate exists', () => {
    const result = runTeamPreflight(team, [], {
      ...okDeps,
      toolStatus: (id: string) => ({ enabled: true, approvalRequired: id === 'xiaohongshu-mcp', riskLevel: 'medium' }),
    });
    expect(result.pass).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('tool_requires_approval');
  });

  it('fails on a high-risk tool without an approval gate', () => {
    const result = runTeamPreflight(team, [], {
      ...okDeps,
      toolStatus: (id: string) => ({ enabled: true, approvalRequired: false, riskLevel: id === 'xiaohongshu-mcp' ? 'critical' : 'medium' }),
    });
    expect(result.pass).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('high_risk_tool_without_gate');
  });

  it('fails when a publish skill has no approval gate', () => {
    const noGateTeam = {
      ...team,
      policy: {},
      lead: 'operator',
      roles: [{ slot: 'operator', agentId: 'ops', skills: ['social-publishing'] }],
    };
    const result = runTeamPreflight(noGateTeam, [], okDeps);
    expect(result.pass).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('publish_without_approval');
  });

  it('fails when policy both allows and disallows the same tool', () => {
    const result = runTeamPreflight({
      ...team,
      policy: { allowedTools: ['xiaohongshu-mcp'], disallowedTools: ['xiaohongshu-mcp'] },
    }, nodes, okDeps);
    expect(result.pass).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('policy_tool_conflict');
  });

  it('warns when the approval policy references an undeclared action', () => {
    const result = runTeamPreflight({
      ...team,
      policy: { requireHumanApprovalBefore: ['publish', 'db-write'] },
    }, nodes, okDeps);
    expect(result.pass).toBe(true);
    expect(result.issues.map(issue => issue.code)).toContain('approval_action_undeclared');
    expect(result.issues.find(issue => issue.code === 'approval_action_undeclared')?.severity).toBe('warning');
  });

  it('fails on an invalid team contract', () => {
    const result = runTeamPreflight({ ...team, version: 1 } as TeamContractV2, [], okDeps);
    expect(result.pass).toBe(false);
    expect(result.issues[0].code).toBe('invalid_team_contract');
  });
});
