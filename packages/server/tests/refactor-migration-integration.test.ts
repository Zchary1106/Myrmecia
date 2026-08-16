/**
 * Migration integration — Team v2 resolution against the migrated registry,
 * legacy aliases, and agents/skills imported into the skill registry.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { syncBuiltinSkills } from '../src/skills/skill-registry.js';
import { loadLegacyAgentAliases } from '../src/agents/legacy-agent-alias-resolver.js';
import { resolveTeamCapabilities, resolvedPlanIsValid } from '../src/agents/capability-resolver.js';
import type { TeamContractV2 } from '../src/types.js';

const repoAgentsDir = join(process.cwd(), '../../agents');
const repoAgentSkillsDir = join(process.cwd(), '../../agents/skills');

const team: TeamContractV2 = {
  schemaVersion: '2.0',
  id: 'integration-team',
  name: 'Integration Team',
  version: 2,
  lead: 'creator',
  roles: [
    { slot: 'researcher', agentId: 'researcher', skills: ['competitive-research'] },
    { slot: 'creator', agentId: 'content-creator', skills: ['xiaohongshu-copywriting', 'hashtag-planning'] },
    { slot: 'designer', agentId: 'ui', skills: ['xiaohongshu-card-design'] },
    { slot: 'reviewer', agentId: 'review', skills: ['social-compliance'] },
    {
      slot: 'operator',
      agentId: 'ops',
      skills: ['social-publish-preflight', 'social-publishing'],
      tools: ['mcp__xiaohongshu__publish_content'],
    },
  ],
  policy: { requireHumanApprovalBefore: ['publish'] },
};

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'refactor-migration-')), 'test.db');
  getDb();

  for (const id of ['researcher', 'content-creator', 'ui', 'review', 'ops', 'pm', 'qa', 'dev', 'architecture-planner']) {
    createAgent({ id, name: id, role: id, capabilities: [] });
  }

  loadLegacyAgentAliases();
  syncBuiltinSkills(repoAgentsDir, repoAgentSkillsDir);
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
});

describe('Refactor migration integration', () => {
  it('resolves a v2 team against the migrated stable roles and agents/skills', () => {
    const plan = resolveTeamCapabilities(team, [], {});
    expect(resolvedPlanIsValid(plan)).toBe(true);
    expect(plan.roles).toHaveLength(5);

    const creator = plan.roles.find(role => role.slot === 'creator')!;
    expect(creator.agentId).toBe('content-creator');
    expect(creator.skills).toEqual(['xiaohongshu-copywriting', 'hashtag-planning']);

    const operator = plan.roles.find(role => role.slot === 'operator')!;
    expect(operator.tools).toEqual(['mcp__xiaohongshu__publish_content']);
  });

  it('resolves a legacy alias through the migrated skills', () => {
    const legacyTeam: TeamContractV2 = {
      ...team,
      id: 'legacy-team',
      roles: [{ slot: 'creator', agentId: 'xiaohongshu-writer' }],
    };
    const plan = resolveTeamCapabilities(legacyTeam, [], {});
    expect(resolvedPlanIsValid(plan)).toBe(true);
    expect(plan.roles[0].agentId).toBe('content-creator');
    expect(plan.roles[0].legacyAgentId).toBe('xiaohongshu-writer');
    expect(plan.roles[0].skills).toEqual(['xiaohongshu-copywriting', 'hashtag-planning']);
  });
});
