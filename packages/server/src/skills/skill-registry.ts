import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { listAgents } from '../db/models/agent.js';
import {
  assignSkillVersionToAgent,
  checksumSkillContent,
  createSkillVersion,
  getSkill,
  getSkillAssignmentForAgent,
  getLatestPublishedSkillForSource,
  getSkillVersionByChecksum,
  upsertSkill,
} from '../db/models/skill.js';

function titleFromMarkdown(content: string, fallback: string): string {
  const heading = content.split('\n').find(line => line.startsWith('# '));
  return heading ? heading.replace(/^#\s+/, '').trim() : fallback;
}

function importSkillFile(id: string, sourcePath: string, fullPath: string): void {
    const content = readFileSync(fullPath, 'utf8');
    const skill = upsertSkill({
      id,
      name: titleFromMarkdown(content, id),
      description: `Imported from ${sourcePath}`,
      sourcePath,
    });
    const checksum = checksumSkillContent(content);
    const existing = getSkillVersionByChecksum(skill.id, checksum);
    if (!existing) {
      createSkillVersion({
        skillId: skill.id,
        content,
        status: 'published',
        changelog: `Imported from ${sourcePath}`,
        createdBy: 'system',
        publishedBy: 'system',
      });
    }
}

export function syncBuiltinSkills(agentsDir: string, skillsDir?: string): void {
  if (existsSync(agentsDir)) {
    const files = readdirSync(agentsDir).filter(file => file.endsWith('.md')).sort();
    for (const file of files) {
      importSkillFile(basename(file, '.md'), `agents/${file}`, join(agentsDir, file));
    }
  }

  if (skillsDir && existsSync(skillsDir)) {
    const entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(fullPath)) continue;
      importSkillFile(entry.name, `skills/${entry.name}/SKILL.md`, fullPath);
    }
  }

  for (const agent of listAgents()) {
    if (!agent.skillPath) continue;
    const imported = getLatestPublishedSkillForSource(agent.skillPath);
    if (!imported) continue;
    const assignment = getSkillAssignmentForAgent(agent.id);
    const assignedSkill = assignment ? getSkill(assignment.skillId) : undefined;
    const assignmentIsBuiltin = Boolean(
      assignedSkill?.sourcePath
      && (
        assignedSkill.sourcePath.startsWith('agents/')
        || assignedSkill.sourcePath.startsWith('skills/')
      )
    );
    if (
      !assignment
      || (
        assignmentIsBuiltin
        && assignedSkill?.sourcePath !== agent.skillPath
      )
    ) {
      assignSkillVersionToAgent(agent.id, imported.version.id);
    }
  }
}
