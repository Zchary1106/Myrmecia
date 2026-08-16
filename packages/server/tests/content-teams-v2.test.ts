/**
 * T15 — the four content teams (WeChat / Xiaohongshu / Douyin / Three-lane)
 * migrated to Team Contract v2 pass validation and preflight with real data.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { syncBuiltinTools } from '../src/tools/tool-registry.js';
import { syncBuiltinSkills } from '../src/skills/skill-registry.js';
import { loadLegacyAgentAliases } from '../src/agents/legacy-agent-alias-resolver.js';
import { getTeam, loadTeams } from '../src/agents/team-registry.js';
import { runTeamPreflight } from '../src/agents/team-preflight.js';
import { validateTeamContractV2 } from '../src/contracts/team-composer-contracts.js';
import type { TeamContractV2 } from '../src/types.js';

const repoAgentsDir = join(process.cwd(), '../../agents');
const repoAgentSkillsDir = join(process.cwd(), '../../agents/skills');
const rootSkillsDir = join(process.cwd(), '../../skills');

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'content-teams-v2-')), 'test.db');
  getDb();

  for (const id of ['master', 'researcher', 'content-creator', 'ui', 'review', 'ops', 'pm', 'qa', 'dev', 'architecture-planner']) {
    createAgent({ id, name: id, role: id, capabilities: [] });
  }
  syncBuiltinTools();
  loadLegacyAgentAliases();
  syncBuiltinSkills(repoAgentsDir, [repoAgentSkillsDir, rootSkillsDir]);
  loadTeams();
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
});

function toContract(team: NonNullable<ReturnType<typeof getTeam>>): TeamContractV2 {
  return {
    schemaVersion: '2.0',
    id: team.id,
    name: team.name,
    version: 2,
    lead: team.lead,
    domainIds: team.domainIds,
    roles: team.roles || [],
    policy: team.policy,
    pipelineTemplate: team.template,
    members: team.members,
  };
}

describe('Content teams migrated to Team v2', () => {
  it.each(['content', 'xiaohongshu', 'douyin', 'social-three-lanes'])(
    'team "%s" is v2, contract-valid, and passes preflight',
    (teamId) => {
      const team = getTeam(teamId);
      expect(team, `team ${teamId} exists`).toBeDefined();
      expect(team?.roles?.length).toBeGreaterThan(0);

      const contract = toContract(team!);
      const validation = validateTeamContractV2(contract);
      expect(validation.valid).toBe(true);

      const preflight = runTeamPreflight(contract);
      expect(preflight.pass).toBe(true);
      expect(preflight.plan?.roles.length).toBeGreaterThan(0);
    },
  );
});
