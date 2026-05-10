import { createHash } from 'crypto';
import { getDb } from '../database.js';
import type { AgentDefinition, SkillAssignment, SkillDefinition, SkillDetail, SkillVersion, SkillVersionStatus } from '../../types.js';

export function checksumSkillContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function rowToSkill(row: any): SkillDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    sourcePath: row.source_path || undefined,
    latestVersionId: row.latest_version_id || undefined,
    publishedVersionId: row.published_version_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row: any): SkillVersion {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    status: row.status,
    content: row.content,
    checksum: row.checksum,
    changelog: row.changelog || undefined,
    createdBy: row.created_by,
    publishedBy: row.published_by || undefined,
    createdAt: row.created_at,
    publishedAt: row.published_at || undefined,
    archivedAt: row.archived_at || undefined,
  };
}

function rowToAssignment(row: any): SkillAssignment {
  return {
    agentId: row.agent_id,
    skillId: row.skill_id,
    skillVersionId: row.skill_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SKILL_SELECT = `
  SELECT
    s.*,
    (SELECT id FROM skill_versions WHERE skill_id = s.id ORDER BY version DESC LIMIT 1) AS latest_version_id,
    (SELECT id FROM skill_versions WHERE skill_id = s.id AND status = 'published' ORDER BY version DESC LIMIT 1) AS published_version_id
  FROM skills s
`;

export function listSkills(): SkillDefinition[] {
  return (getDb().prepare(`${SKILL_SELECT} ORDER BY s.name ASC`).all() as any[]).map(rowToSkill);
}

export function getSkill(id: string): SkillDefinition | undefined {
  const row = getDb().prepare(`${SKILL_SELECT} WHERE s.id = ?`).get(id) as any;
  return row ? rowToSkill(row) : undefined;
}

export function getSkillDetail(id: string): SkillDetail | undefined {
  const skill = getSkill(id);
  if (!skill) return undefined;
  return {
    ...skill,
    versions: listSkillVersions(id),
    assignments: listSkillAssignments({ skillId: id }),
  };
}

export function upsertSkill(data: {
  id: string;
  name: string;
  description?: string;
  sourcePath?: string;
}): SkillDefinition {
  getDb().prepare(`
    INSERT INTO skills (id, name, description, source_path)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      source_path = excluded.source_path,
      updated_at = CURRENT_TIMESTAMP
  `).run(data.id, data.name, data.description || '', data.sourcePath || null);
  return getSkill(data.id)!;
}

export function listSkillVersions(skillId: string): SkillVersion[] {
  return (getDb().prepare(`
    SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC
  `).all(skillId) as any[]).map(rowToVersion);
}

export function getSkillVersion(id: string): SkillVersion | undefined {
  const row = getDb().prepare('SELECT * FROM skill_versions WHERE id = ?').get(id) as any;
  return row ? rowToVersion(row) : undefined;
}

export function getSkillVersionByChecksum(skillId: string, checksum: string): SkillVersion | undefined {
  const row = getDb().prepare('SELECT * FROM skill_versions WHERE skill_id = ? AND checksum = ?').get(skillId, checksum) as any;
  return row ? rowToVersion(row) : undefined;
}

export function createSkillVersion(data: {
  skillId: string;
  content: string;
  changelog?: string;
  status?: SkillVersionStatus;
  createdBy?: string;
  publishedBy?: string;
}): SkillVersion {
  const db = getDb();
  const skill = getSkill(data.skillId);
  if (!skill) throw new Error(`Skill ${data.skillId} not found`);
  const checksum = checksumSkillContent(data.content);
  const existing = getSkillVersionByChecksum(data.skillId, checksum);
  if (existing) return existing;

  const nextVersion = ((db.prepare('SELECT MAX(version) AS version FROM skill_versions WHERE skill_id = ?').get(data.skillId) as any)?.version || 0) + 1;
  const id = `${data.skillId}_v${nextVersion}`;
  const status = data.status || 'draft';
  db.prepare(`
    INSERT INTO skill_versions (
      id, skill_id, version, status, content, checksum, changelog, created_by, published_by, published_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.skillId,
    nextVersion,
    status,
    data.content,
    checksum,
    data.changelog || '',
    data.createdBy || 'system',
    status === 'published' ? data.publishedBy || data.createdBy || 'system' : null,
    status === 'published' ? new Date().toISOString() : null,
  );
  return getSkillVersion(id)!;
}

export function updateDraftSkillVersion(id: string, updates: { content?: string; changelog?: string }): SkillVersion | undefined {
  const version = getSkillVersion(id);
  if (!version) return undefined;
  if (version.status !== 'draft') throw new Error('Only draft skill versions can be edited');
  const nextContent = updates.content ?? version.content;
  const nextChecksum = checksumSkillContent(nextContent);
  getDb().prepare(`
    UPDATE skill_versions
    SET content = ?, checksum = ?, changelog = ?
    WHERE id = ?
  `).run(nextContent, nextChecksum, updates.changelog ?? version.changelog ?? '', id);
  return getSkillVersion(id);
}

export function publishSkillVersion(id: string, actorId = 'system'): SkillVersion | undefined {
  const version = getSkillVersion(id);
  if (!version) return undefined;
  if (version.status === 'archived') throw new Error('Archived skill versions cannot be published');
  getDb().prepare(`
    UPDATE skill_versions
    SET status = 'published', published_by = ?, published_at = COALESCE(published_at, CURRENT_TIMESTAMP)
    WHERE id = ?
  `).run(actorId, id);
  return getSkillVersion(id);
}

export function archiveSkillVersion(id: string): SkillVersion | undefined {
  const version = getSkillVersion(id);
  if (!version) return undefined;
  getDb().prepare(`
    UPDATE skill_versions
    SET status = 'archived', archived_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
  return getSkillVersion(id);
}

export function listSkillAssignments(filter?: { skillId?: string; agentId?: string }): SkillAssignment[] {
  let sql = 'SELECT * FROM skill_assignments';
  const conditions: string[] = [];
  const params: any[] = [];
  if (filter?.skillId) { conditions.push('skill_id = ?'); params.push(filter.skillId); }
  if (filter?.agentId) { conditions.push('agent_id = ?'); params.push(filter.agentId); }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY updated_at DESC';
  return (getDb().prepare(sql).all(...params) as any[]).map(rowToAssignment);
}

export function getSkillAssignmentForAgent(agentId: string): SkillAssignment | undefined {
  const row = getDb().prepare('SELECT * FROM skill_assignments WHERE agent_id = ?').get(agentId) as any;
  return row ? rowToAssignment(row) : undefined;
}

export function assignSkillVersionToAgent(agentId: string, skillVersionId: string): SkillAssignment {
  const version = getSkillVersion(skillVersionId);
  if (!version) throw new Error(`Skill version ${skillVersionId} not found`);
  if (version.status !== 'published') throw new Error('Only published skill versions can be assigned to agents');
  getDb().prepare(`
    INSERT INTO skill_assignments (agent_id, skill_id, skill_version_id)
    VALUES (?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      skill_id = excluded.skill_id,
      skill_version_id = excluded.skill_version_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(agentId, version.skillId, version.id);
  return getSkillAssignmentForAgent(agentId)!;
}

export function getLatestPublishedSkillVersion(skillId: string): SkillVersion | undefined {
  const row = getDb().prepare(`
    SELECT * FROM skill_versions
    WHERE skill_id = ? AND status = 'published'
    ORDER BY version DESC
    LIMIT 1
  `).get(skillId) as any;
  return row ? rowToVersion(row) : undefined;
}

export function getLatestPublishedSkillForSource(sourcePath: string): { skill: SkillDefinition; version: SkillVersion } | undefined {
  const skillRow = getDb().prepare(`
    ${SKILL_SELECT} WHERE s.source_path = ? ORDER BY s.updated_at DESC LIMIT 1
  `).get(sourcePath) as any;
  if (!skillRow) return undefined;
  const skill = rowToSkill(skillRow);
  const version = getLatestPublishedSkillVersion(skill.id);
  return version ? { skill, version } : undefined;
}

export function resolveSkillForAgent(agent: AgentDefinition): { skill: SkillDefinition; version: SkillVersion; source: 'assignment' | 'skillPath' } | undefined {
  const assignment = getSkillAssignmentForAgent(agent.id);
  if (assignment) {
    const version = getSkillVersion(assignment.skillVersionId);
    const skill = version ? getSkill(version.skillId) : undefined;
    if (skill && version?.status === 'published') return { skill, version, source: 'assignment' };
  }
  if (agent.skillPath) {
    const imported = getLatestPublishedSkillForSource(agent.skillPath);
    if (imported) return { ...imported, source: 'skillPath' };
  }
  return undefined;
}
