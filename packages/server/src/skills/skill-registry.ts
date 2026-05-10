import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { listAgents } from '../db/models/agent.js';
import {
  assignSkillVersionToAgent,
  checksumSkillContent,
  createSkillVersion,
  getSkillAssignmentForAgent,
  getLatestPublishedSkillForSource,
  getSkillVersionByChecksum,
  upsertSkill,
} from '../db/models/skill.js';

function titleFromMarkdown(content: string, fallback: string): string {
  const heading = content.split('\n').find(line => line.startsWith('# '));
  return heading ? heading.replace(/^#\s+/, '').trim() : fallback;
}

export function syncBuiltinSkills(agentsDir: string): void {
  if (!existsSync(agentsDir)) return;
  const files = readdirSync(agentsDir).filter(file => file.endsWith('.md')).sort();
  for (const file of files) {
    const id = basename(file, '.md');
    const sourcePath = `agents/${file}`;
    const fullPath = join(agentsDir, file);
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

  for (const agent of listAgents()) {
    if (!agent.skillPath) continue;
    if (getSkillAssignmentForAgent(agent.id)) continue;
    const imported = getLatestPublishedSkillForSource(agent.skillPath);
    if (imported) assignSkillVersionToAgent(agent.id, imported.version.id);
  }
}
