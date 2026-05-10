import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import {
  assignSkillVersionToAgent,
  createSkillVersion,
  getSkillAssignmentForAgent,
  getSkillDetail,
  publishSkillVersion,
  resolveSkillForAgent,
  upsertSkill,
} from '../src/db/models/skill.js';
import { syncBuiltinSkills } from '../src/skills/skill-registry.js';

describe('skill versioning', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-skills-')), 'test.db');
    getDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('imports markdown skills as published versions and assigns registry agents', () => {
    const agentsDir = mkdtempSync(join(tmpdir(), 'agent-skills-'));
    writeFileSync(join(agentsDir, 'researcher.md'), '# Researcher\n\nUse sources.', 'utf8');
    const agent = createAgent({
      id: 'researcher-agent',
      name: 'Researcher',
      role: 'researcher',
      skillPath: 'agents/researcher.md',
    });

    syncBuiltinSkills(agentsDir);

    const detail = getSkillDetail('researcher');
    const assignment = getSkillAssignmentForAgent(agent.id);
    const resolved = resolveSkillForAgent(agent);
    expect(detail?.versions[0].status).toBe('published');
    expect(assignment?.skillVersionId).toBe(detail?.versions[0].id);
    expect(resolved?.version.content).toContain('Use sources.');
  });

  it('supports draft publish and assignment rollback', () => {
    const skill = upsertSkill({ id: 'writer', name: 'Writer' });
    const v1 = createSkillVersion({ skillId: skill.id, content: 'v1', status: 'published', createdBy: 'test' });
    const draft = createSkillVersion({ skillId: skill.id, content: 'v2', status: 'draft', createdBy: 'test' });
    const v2 = publishSkillVersion(draft.id, 'alice')!;
    const agent = createAgent({ id: 'writer-agent', name: 'Writer Agent', role: 'writer' });

    assignSkillVersionToAgent(agent.id, v2.id);
    expect(resolveSkillForAgent(agent)?.version.id).toBe(v2.id);

    assignSkillVersionToAgent(agent.id, v1.id);
    expect(resolveSkillForAgent(agent)?.version.id).toBe(v1.id);
  });
});
