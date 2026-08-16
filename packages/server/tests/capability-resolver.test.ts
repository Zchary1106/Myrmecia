/**
 * Capability Resolver — Team v2 → Role → Agent + Skills + Tools + Domain.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import type { TeamContractV2 } from '../src/types.js';
import {
  buildExecutionPlanSnapshot,
  canonicalStringify,
  resolveTeamCapabilities,
  resolvedPlanIsValid,
} from '../src/agents/capability-resolver.js';
import { validateExecutionPlanSnapshot } from '../src/contracts/team-composer-contracts.js';

const team: TeamContractV2 = {
  schemaVersion: '2.0',
  id: 'xiaohongshu',
  name: 'Xiaohongshu Team',
  version: 2,
  lead: 'creator',
  roles: [
    { slot: 'researcher', agentId: 'researcher', skills: ['social-trend-evidence'], tools: ['web.search'] },
    { slot: 'creator', agentId: 'content-creator', skills: ['xiaohongshu-copywriting', 'hashtag-planning'] },
    { slot: 'designer', agentId: 'ui', skills: ['xiaohongshu-card-design'] },
    { slot: 'reviewer', agentId: 'review', skills: ['social-compliance'] },
    { slot: 'operator', agentId: 'ops', skills: ['social-publish-preflight', 'social-publishing'], tools: ['xiaohongshu-mcp'] },
  ],
  policy: { requireHumanApprovalBefore: ['publish'] },
  pipelineTemplate: 'Xiaohongshu Publish v2',
};

const nodes = [
  { id: 'n1', roleSlot: 'researcher', requiredCapabilities: ['research'], skillIds: ['social-trend-evidence'], inputs: [], outputs: [{ name: 'evidence', kind: 'json', required: true }] },
  { id: 'n2', roleSlot: 'creator', requiredCapabilities: ['copywriting'], skillIds: ['xiaohongshu-copywriting'], inputs: [], outputs: [{ name: 'copy', kind: 'markdown', required: true }] },
  { id: 'n3', roleSlot: 'creator', requiredCapabilities: ['hashtag'], skillIds: ['hashtag-planning'], inputs: [], outputs: [{ name: 'tags', kind: 'json', required: true }] },
];

const deps = {
  getAgent: (id: string) => ({ id }),
  getSkill: (id: string) => ({ id }),
  getTool: (id: string) => ({ id }),
  getDomain: (id: string) => ({ id }),
  resolveAlias: () => undefined,
};

describe('resolveTeamCapabilities', () => {
  it('resolves every role slot with merged skills and aggregated capabilities', () => {
    const plan = resolveTeamCapabilities(team, nodes as any, deps);
    expect(resolvedPlanIsValid(plan)).toBe(true);
    expect(plan.roles).toHaveLength(5);

    const creator = plan.roles.find(role => role.slot === 'creator')!;
    expect(creator.agentId).toBe('content-creator');
    expect(creator.skills).toEqual(['xiaohongshu-copywriting', 'hashtag-planning']);
    expect(creator.capabilities).toEqual(['copywriting', 'hashtag']);
    expect(creator.domainIds).toEqual([]);

    const operator = plan.roles.find(role => role.slot === 'operator')!;
    expect(operator.tools).toEqual(['xiaohongshu-mcp']);
    expect(plan.policy.requireHumanApprovalBefore).toEqual(['publish']);
  });

  it('resolves a legacy alias to the stable agent and keeps legacyAgentId', () => {
    const teamWithLegacy = {
      ...team,
      roles: [{ slot: 'creator', agentId: 'xiaohongshu-writer' }],
    };
    const plan = resolveTeamCapabilities(teamWithLegacy, nodes as any, {
      ...deps,
      getAgent: (id: string) => (id === 'content-creator' ? { id } : undefined),
      resolveAlias: (id: string) => id === 'xiaohongshu-writer'
        ? { agentId: 'content-creator', skills: ['xiaohongshu-copywriting', 'hashtag-planning'], tools: [] }
        : undefined,
    });
    expect(resolvedPlanIsValid(plan)).toBe(true);
    expect(plan.roles[0].agentId).toBe('content-creator');
    expect(plan.roles[0].legacyAgentId).toBe('xiaohongshu-writer');
    expect(plan.roles[0].skills).toEqual(['xiaohongshu-copywriting', 'hashtag-planning']);
  });

  it('rejects unknown skills, tools, domains and agents', () => {
    const badTeam = {
      ...team,
      roles: [
        { slot: 'creator', agentId: 'ghost-agent', skills: ['nope-skill'], tools: ['nope.tool'], domainIds: ['nope-domain'] },
      ],
    };
    const plan = resolveTeamCapabilities(badTeam, [], {
      ...deps,
      getAgent: () => undefined,
      getSkill: () => undefined,
      getTool: () => undefined,
      getDomain: () => undefined,
    });
    expect(resolvedPlanIsValid(plan)).toBe(false);
    expect(plan.errors.map(error => error.code).sort()).toEqual([
      'unknown_agent', 'unknown_domain', 'unknown_skill', 'unknown_tool',
    ]);
  });

  it('warns when a slot declares no skills or tools', () => {
    const plan = resolveTeamCapabilities(
      { ...team, roles: [{ slot: 'reviewer', agentId: 'review' }] },
      [],
      deps,
    );
    expect(plan.errors).toHaveLength(0);
    expect(plan.warnings.map(warning => warning.code)).toContain('empty_capability_slot');
  });
});

describe('buildExecutionPlanSnapshot', () => {
  it('produces an immutable, schema-valid snapshot with a deterministic checksum', () => {
    const plan = resolveTeamCapabilities(team, nodes as any, deps);
    const build = () => buildExecutionPlanSnapshot(plan, {
      snapshotId: 'snap-1',
      pipelineTemplate: 'Xiaohongshu Publish v2',
      gates: [{ nodeId: 'n9', gate: { kind: 'human-approval', reason: 'publish gate' } }],
      createdAt: '2026-08-15T00:00:00.000Z',
    });

    const snapshot = build();
    const validation = validateExecutionPlanSnapshot(snapshot);
    expect(validation.valid).toBe(true);

    const snapshot2 = build();
    expect(snapshot2.checksum).toBe(snapshot.checksum);

    const atDifferentTime = buildExecutionPlanSnapshot(plan, {
      snapshotId: 'snap-1',
      pipelineTemplate: 'Xiaohongshu Publish v2',
      gates: [{ nodeId: 'n9', gate: { kind: 'human-approval', reason: 'publish gate' } }],
      createdAt: '2026-08-15T01:00:00.000Z',
    });
    expect(atDifferentTime.checksum).not.toBe(snapshot.checksum);

    const tampered = { ...snapshot, roles: [...snapshot.roles] };
    tampered.roles[0] = { ...tampered.roles[0], skills: ['other-skill'] };
    const tamperedValidation = validateExecutionPlanSnapshot(tampered);
    expect(tamperedValidation.valid).toBe(true);
    expect(tampered.checksum).not.toBe(checksumOf(tampered));
  });
});

function checksumOf(snapshot: any): string {
  const { checksum: _checksum, ...body } = snapshot;
  const canonical = canonicalStringify(body);
  return createHash('sha256').update(canonical).digest('hex');
}
