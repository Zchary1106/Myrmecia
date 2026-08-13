import { v4 as uuid } from 'uuid';
import { getDb } from '../database.js';
import type {
  TeamTemplateVersion,
  TeamTemplateVersionStatus,
  WorkflowGraphContract,
} from '../../types.js';
import { validateWorkflowGraphContract } from '../../contracts/team-composer-contracts.js';

function rowToVersion(row: any): TeamTemplateVersion {
  return {
    id: row.id,
    teamId: row.team_id,
    workspaceId: row.workspace_id,
    version: row.version,
    status: row.status,
    graph: typeof row.graph === 'string' ? JSON.parse(row.graph) : row.graph,
    changeNote: row.change_note || undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    publishedAt: row.published_at || undefined,
    archivedAt: row.archived_at || undefined,
  };
}

export function createTeamTemplateVersion(data: {
  teamId: string;
  workspaceId?: string;
  graph: WorkflowGraphContract;
  changeNote?: string;
  createdBy?: string;
}): TeamTemplateVersion {
  const validation = validateWorkflowGraphContract(data.graph);
  if (!validation.valid || !validation.value) {
    throw new Error(`Invalid team workflow: ${validation.errors.map(issue => issue.message).join('; ')}`);
  }
  const workspaceId = data.workspaceId || 'default';
  const row = getDb().get(
    'SELECT COALESCE(MAX(version), 0) AS version FROM team_template_versions WHERE team_id = ? AND workspace_id = ?',
    data.teamId,
    workspaceId,
  ) as { version?: number } | undefined;
  const version = Number(row?.version || 0) + 1;
  const id = `ttv_${uuid().slice(0, 12)}`;
  getDb().run(
    `INSERT INTO team_template_versions
      (id, team_id, workspace_id, version, status, graph, change_note, created_by)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
    id,
    data.teamId,
    workspaceId,
    version,
    JSON.stringify(validation.value),
    data.changeNote || null,
    data.createdBy || 'user',
  );
  return getTeamTemplateVersion(id, workspaceId)!;
}

export function getTeamTemplateVersion(id: string, workspaceId = 'default'): TeamTemplateVersion | undefined {
  const row = getDb().get(
    'SELECT * FROM team_template_versions WHERE id = ? AND workspace_id = ?',
    id,
    workspaceId,
  );
  return row ? rowToVersion(row) : undefined;
}

export function listTeamTemplateVersions(teamId: string, workspaceId = 'default'): TeamTemplateVersion[] {
  return (getDb().all(
    `SELECT * FROM team_template_versions
     WHERE team_id = ? AND workspace_id = ?
     ORDER BY version DESC`,
    teamId,
    workspaceId,
  ) as any[]).map(rowToVersion);
}

export function getPublishedTeamTemplate(teamId: string, workspaceId = 'default'): TeamTemplateVersion | undefined {
  const row = getDb().get(
    `SELECT * FROM team_template_versions
     WHERE team_id = ? AND workspace_id = ? AND status = 'published'
     ORDER BY version DESC LIMIT 1`,
    teamId,
    workspaceId,
  );
  return row ? rowToVersion(row) : undefined;
}

export function publishTeamTemplateVersion(
  id: string,
  workspaceId = 'default',
): TeamTemplateVersion | undefined {
  const version = getTeamTemplateVersion(id, workspaceId);
  if (!version) return undefined;
  if (version.status === 'archived') throw new Error('Archived team template versions cannot be published');
  const now = new Date().toISOString();
  getDb().run(
    `UPDATE team_template_versions
     SET status = 'archived', archived_at = COALESCE(archived_at, ?)
     WHERE team_id = ? AND workspace_id = ? AND status = 'published' AND id != ?`,
    now,
    version.teamId,
    workspaceId,
    id,
  );
  getDb().run(
    `UPDATE team_template_versions
     SET status = 'published', published_at = ?, archived_at = NULL
     WHERE id = ? AND workspace_id = ?`,
    now,
    id,
    workspaceId,
  );
  return getTeamTemplateVersion(id, workspaceId);
}

export function archiveTeamTemplateVersion(
  id: string,
  workspaceId = 'default',
): TeamTemplateVersion | undefined {
  const version = getTeamTemplateVersion(id, workspaceId);
  if (!version) return undefined;
  getDb().run(
    `UPDATE team_template_versions
     SET status = 'archived', archived_at = ?
     WHERE id = ? AND workspace_id = ?`,
    new Date().toISOString(),
    id,
    workspaceId,
  );
  return getTeamTemplateVersion(id, workspaceId);
}

export function updateTeamTemplateVersionStatus(
  id: string,
  status: TeamTemplateVersionStatus,
  workspaceId = 'default',
): TeamTemplateVersion | undefined {
  if (status === 'published') return publishTeamTemplateVersion(id, workspaceId);
  if (status === 'archived') return archiveTeamTemplateVersion(id, workspaceId);
  const version = getTeamTemplateVersion(id, workspaceId);
  if (!version) return undefined;
  if (version.status !== 'draft') throw new Error('Published or archived versions cannot return to draft');
  return version;
}
