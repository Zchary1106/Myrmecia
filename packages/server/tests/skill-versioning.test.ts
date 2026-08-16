import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
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

  it('imports standard skills/<id>/SKILL.md folders', () => {
    const agentsDir = mkdtempSync(join(tmpdir(), 'agent-skills-empty-'));
    const skillsDir = mkdtempSync(join(tmpdir(), 'standard-skills-'));
    const visualDir = join(skillsDir, 'visual-cards');
    mkdirSync(visualDir, { recursive: true });
    writeFileSync(join(visualDir, 'SKILL.md'), '---\nname: visual-cards\ndescription: Render cards.\n---\n\n# Visual Cards\n\nRender and inspect.', 'utf8');
    const agent = createAgent({
      id: 'visual-agent',
      name: 'Visual Agent',
      role: 'visual',
      skillPath: 'skills/visual-cards/SKILL.md',
    });

    syncBuiltinSkills(agentsDir, skillsDir);

    expect(getSkillDetail('visual-cards')?.versions[0].status).toBe('published');
    expect(resolveSkillForAgent(agent)?.version.content).toContain('Render and inspect.');
  });

  it('imports skills from multiple skills directories', () => {
    const agentsDir = mkdtempSync(join(tmpdir(), 'agent-skills-multi-'));
    const skillsA = mkdtempSync(join(tmpdir(), 'standard-skills-a-'));
    const skillsB = mkdtempSync(join(tmpdir(), 'standard-skills-b-'));
    for (const [dir, id] of [[skillsA, 'skill-a'], [skillsB, 'skill-b']] as const) {
      const skillDir = join(dir, id);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${id}.\n---\n\n# ${id}\n\nBody.`, 'utf8');
    }

    syncBuiltinSkills(agentsDir, [skillsA, skillsB]);

    expect(getSkillDetail('skill-a')?.versions[0].status).toBe('published');
    expect(getSkillDetail('skill-b')?.versions[0].status).toBe('published');
  });

  it('moves auto-managed agents to a new builtin skill path while preserving custom assignments', () => {
    const agentsDir = mkdtempSync(join(tmpdir(), 'agent-skills-migrate-'));
    const skillsDir = mkdtempSync(join(tmpdir(), 'standard-skills-migrate-'));
    const modernDir = join(skillsDir, 'modern-writer');
    mkdirSync(modernDir, { recursive: true });
    writeFileSync(join(agentsDir, 'legacy-writer.md'), '# Legacy Writer\n\nLegacy.', 'utf8');
    writeFileSync(join(modernDir, 'SKILL.md'), '---\nname: modern-writer\ndescription: Modern.\n---\n\n# Modern Writer\n\nModern.', 'utf8');

    const managedAgent = createAgent({
      id: 'managed-writer',
      name: 'Managed Writer',
      role: 'writer',
      skillPath: 'agents/legacy-writer.md',
    });
    syncBuiltinSkills(agentsDir, skillsDir);
    expect(getSkillAssignmentForAgent(managedAgent.id)?.skillId).toBe('legacy-writer');

    const custom = upsertSkill({ id: 'custom-writer', name: 'Custom Writer' });
    const customVersion = createSkillVersion({
      skillId: custom.id,
      content: 'Custom.',
      status: 'published',
      createdBy: 'test',
    });
    assignSkillVersionToAgent(managedAgent.id, customVersion.id);

    // Custom assignments remain explicit overrides.
    syncBuiltinSkills(agentsDir, skillsDir);
    expect(getSkillAssignmentForAgent(managedAgent.id)?.skillId).toBe('custom-writer');

    // A builtin assignment follows a registry skill-path migration.
    const migratedAgent = createAgent({
      id: 'migrated-writer',
      name: 'Migrated Writer',
      role: 'writer',
      skillPath: 'skills/modern-writer/SKILL.md',
    });
    const legacy = getSkillDetail('legacy-writer')!;
    assignSkillVersionToAgent(migratedAgent.id, legacy.versions[0].id);
    syncBuiltinSkills(agentsDir, skillsDir);
    expect(getSkillAssignmentForAgent(migratedAgent.id)?.skillId).toBe('modern-writer');
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
