import { createHash, randomUUID } from 'node:crypto';
import type { AgentKnowledgeSource, AgentKnowledgeReference, AgentKnowledgeCatalog, Task } from '../../types.js';
import { getDb } from '../database.js';
import { getTask } from './task.js';
import { getTeam, listTeams } from '../../agents/team-registry.js';
import { documentSessionKey } from '../../knowledge/session-documents.js';
import { dlpCheck } from '../../security/dlp.js';
import { HttpError } from '../../routes/http.js';
import type { DocumentPassage } from '../../knowledge/session-document-parser.js';
import { MAX_DOCUMENT_BYTES } from '../../knowledge/session-document-parser.js';
import { listAgents } from './agent.js';

export const knowledgeHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const passageHash = (passages: DocumentPassage[]) => knowledgeHash(JSON.stringify(passages));
export function assertKnowledgeAgent(agentId: string, workspaceId: string): void {
  if (!getDb().get('SELECT id FROM agents WHERE id = ? AND workspace_id = ?', agentId, workspaceId)) {
    throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent not found');
  }
}
export function isTeamKnowledgeMember(agentId: string, teamId: string, workspaceId: string): boolean {
  if (!getDb().get('SELECT id FROM agents WHERE id = ? AND workspace_id = ?', agentId, workspaceId)) return false;
  const team = getTeam(teamId, workspaceId);
  if (!team) return false;
  // Knowledge grants require exact identity or role membership, never a fuzzy
  // substring match used by legacy task-routing suggestions.
  const agent = listAgents({ workspaceId }).find(item => item.id === agentId);
  return !!agent && (team.roles?.some(slot => slot.agentId === agentId)
    || team.members.some(member => member === agent.id || member === agent.role)) === true;
}
export function assertKnowledgeOwner(agentId: string, workspaceId: string, scope: 'agent_private' | 'team_shared', ownerId: string): void {
  assertKnowledgeAgent(agentId, workspaceId);
  if (scope === 'agent_private' ? ownerId !== agentId : !isTeamKnowledgeMember(agentId, ownerId, workspaceId)) {
    throw new HttpError(404, 'KNOWLEDGE_SCOPE_DENIED', 'Source is unavailable to this Agent or Team');
  }
}
export function safeKnowledgePassages(passages: DocumentPassage[], workspaceId: string): DocumentPassage[] {
  if (!passages.length || passages.length > 1000 || passages.reduce((n, item) => n + item.text.length, 0) > 120_000
    || passages.some(item => !item.text.trim() || item.text.length > 3000 || item.locator.length > 200)) {
    throw new HttpError(400, 'KNOWLEDGE_BOUNDS', 'Document exceeds supported passage bounds');
  }
  const scanned = dlpCheck(passages.map(item => item.text).join('\n\n'), { workspaceId });
  if (scanned.violations.some(item => item.action === 'block')) throw new HttpError(400, 'KNOWLEDGE_DLP_BLOCKED', 'Document contains blocked credentials; remove them before uploading');
  return passages.map(item => {
    const result = dlpCheck(item.text, { workspaceId });
    return { ...item, text: result.redactedContent || item.text };
  });
}
function sourceRow(id: string, workspaceId: string): any {
  return getDb().get('SELECT * FROM agent_knowledge_sources WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', id, workspaceId);
}
function projection(row: any): AgentKnowledgeSource {
  return { sourceId: row.id, bindingId: row.binding_id, version: row.version, sourceHash: row.source_hash,
    passageHash: row.passage_hash, title: row.title, scope: row.scope, ownerId: row.owner_id,
    sizeBytes: row.size_bytes, passageCount: row.passage_count ?? JSON.parse(row.passages).length, createdAt: row.created_at };
}
export function boundKnowledgeSources(scope: 'agent_private' | 'team_shared', ownerId: string, workspaceId: string): AgentKnowledgeSource[] {
  return getDb().all(`SELECT s.id, s.title, s.scope, s.owner_id, s.version, s.source_hash, s.passage_hash, s.size_bytes,
    s.created_at, json_array_length(s.passages) AS passage_count, b.id AS binding_id FROM agent_knowledge_sources s JOIN agent_knowledge_bindings b ON b.source_id = s.id
    WHERE s.workspace_id = ? AND b.workspace_id = ? AND s.scope = ? AND s.owner_id = ?
      AND b.scope = s.scope AND b.owner_id = s.owner_id AND b.revoked_at IS NULL AND s.deleted_at IS NULL ORDER BY s.created_at, s.id`,
  workspaceId, workspaceId, scope, ownerId).map(projection);
}
export function privateKnowledgeReferences(agentId: string, workspaceId: string): AgentKnowledgeReference[] {
  return boundKnowledgeSources('agent_private', agentId, workspaceId).map(({ sourceId, bindingId, version, sourceHash, passageHash }) =>
    ({ sourceId, bindingId, version, sourceHash, passageHash }));
}
export function knowledgeCatalog(agentId: string, workspaceId: string): AgentKnowledgeCatalog {
  assertKnowledgeAgent(agentId, workspaceId);
  const teams = listTeams(workspaceId).filter(team => isTeamKnowledgeMember(agentId, team.id, workspaceId));
  return { agentPrivate: boundKnowledgeSources('agent_private', agentId, workspaceId),
    teams: teams.map(team => ({ id: team.id, name: team.name, sources: boundKnowledgeSources('team_shared', team.id, workspaceId) })),
    unbound: getDb().all<any>(`SELECT s.id, s.title, s.scope, s.owner_id, s.version, s.source_hash, s.passage_hash,
      s.size_bytes, s.created_at, json_array_length(s.passages) AS passage_count
      FROM agent_knowledge_sources s WHERE s.workspace_id = ? AND s.deleted_at IS NULL
      AND ((s.scope = 'agent_private' AND s.owner_id = ?) OR (s.scope = 'team_shared' AND s.owner_id IN (${teams.map(() => '?').join(',') || 'NULL'})))
      AND NOT EXISTS (SELECT 1 FROM agent_knowledge_bindings b WHERE b.source_id = s.id AND b.workspace_id = s.workspace_id AND b.revoked_at IS NULL)
      ORDER BY s.created_at DESC LIMIT 100`,
    workspaceId, agentId, ...teams.map(team => team.id))
      .map(row => projection({ ...row, binding_id: '' })) };
}
export function createKnowledgeSource(input: { agentId: string; workspaceId: string; actorId: string;
  scope: 'agent_private' | 'team_shared'; ownerId: string; title: string; bytes: Buffer; passages: DocumentPassage[];
}): AgentKnowledgeSource {
  assertKnowledgeOwner(input.agentId, input.workspaceId, input.scope, input.ownerId);
  if (!input.title || input.title.length > 200 || /[\\/\x00-\x1f]/.test(input.title)
    || !input.bytes.length || input.bytes.length > MAX_DOCUMENT_BYTES) throw new HttpError(400, 'KNOWLEDGE_UPLOAD_INVALID', 'Invalid filename or size');
  const passages = safeKnowledgePassages(input.passages, input.workspaceId);
  return getDb().transaction(() => {
    if (boundKnowledgeSources(input.scope, input.ownerId, input.workspaceId).length >= 20) {
      throw new HttpError(400, 'KNOWLEDGE_LIMIT', 'An Agent or Team supports at most 20 bound sources');
    }
    const id = randomUUID(), now = new Date().toISOString();
    getDb().run(`INSERT INTO agent_knowledge_sources(id, workspace_id, scope, owner_id, title, source_hash, passage_hash,
      size_bytes, passages, original, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, input.workspaceId, input.scope, input.ownerId, input.title, knowledgeHash(input.bytes), passageHash(passages),
    input.bytes.length, JSON.stringify(passages), input.bytes, input.actorId, now);
    return bindKnowledgeSource(input.agentId, input.workspaceId, id);
  });
}
export function bindKnowledgeSource(agentId: string, workspaceId: string, sourceId: string): AgentKnowledgeSource {
  const row = sourceRow(sourceId, workspaceId);
  if (!row) throw new HttpError(404, 'KNOWLEDGE_NOT_FOUND', 'Source not found');
  assertKnowledgeOwner(agentId, workspaceId, row.scope, row.owner_id);
  return getDb().transaction(() => {
    const existing = boundKnowledgeSources(row.scope, row.owner_id, workspaceId);
    const prior = existing.find(source => source.sourceId === sourceId);
    if (prior) return prior;
    if (existing.length >= 20) throw new HttpError(400, 'KNOWLEDGE_LIMIT', 'Source limit reached');
    const id = randomUUID();
    getDb().run('INSERT INTO agent_knowledge_bindings(id, workspace_id, scope, owner_id, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, workspaceId, row.scope, row.owner_id, sourceId, new Date().toISOString());
    return { ...projection(row), bindingId: id };
  });
}
export function unbindKnowledgeSource(agentId: string, workspaceId: string, bindingId: string): void {
  const row = getDb().get<any>('SELECT * FROM agent_knowledge_bindings WHERE id = ? AND workspace_id = ?', bindingId, workspaceId);
  if (!row) throw new HttpError(404, 'KNOWLEDGE_NOT_FOUND', 'Binding not found');
  assertKnowledgeOwner(agentId, workspaceId, row.scope, row.owner_id);
  getDb().run('UPDATE agent_knowledge_bindings SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?',
    new Date().toISOString(), bindingId);
}
export function deleteKnowledgeSource(agentId: string, workspaceId: string, sourceId: string): void {
  const row = sourceRow(sourceId, workspaceId);
  if (!row) throw new HttpError(404, 'KNOWLEDGE_NOT_FOUND', 'Source not found');
  assertKnowledgeOwner(agentId, workspaceId, row.scope, row.owner_id);
  getDb().transaction(() => {
    const now = new Date().toISOString();
    getDb().run('UPDATE agent_knowledge_sources SET deleted_at = ? WHERE id = ?', now, sourceId);
    getDb().run('UPDATE agent_knowledge_bindings SET revoked_at = COALESCE(revoked_at, ?) WHERE source_id = ?', now, sourceId);
  });
}
export function readBoundKnowledge(source: AgentKnowledgeReference, agentId: string, workspaceId: string,
  scope: 'agent_private' | 'team_shared', ownerId: string): DocumentPassage[] {
  assertKnowledgeOwner(agentId, workspaceId, scope, ownerId);
  const row = getDb().get<any>(`SELECT s.* FROM agent_knowledge_sources s JOIN agent_knowledge_bindings b ON b.source_id = s.id
    WHERE s.id = ? AND s.workspace_id = ? AND s.scope = ? AND s.owner_id = ? AND s.deleted_at IS NULL
      AND b.id = ? AND b.workspace_id = ? AND b.scope = s.scope AND b.owner_id = s.owner_id AND b.revoked_at IS NULL`,
  source.sourceId, workspaceId, scope, ownerId, source.bindingId, workspaceId);
  if (!row || row.source_hash !== source.sourceHash || row.passage_hash !== source.passageHash || row.version !== source.version
    || knowledgeHash(row.original) !== row.source_hash || passageHash(JSON.parse(row.passages)) !== row.passage_hash) {
    throw new HttpError(410, 'KNOWLEDGE_UNAVAILABLE', 'Source was removed, revoked or changed; no fallback is permitted');
  }
  return safeKnowledgePassages(JSON.parse(row.passages), workspaceId);
}
/** Explicit server-side task affiliation, never inferred from a title/filename. */
export function bindTaskKnowledgeTeam(taskId: string, teamId: string, workspaceId: string): void {
  const task = getTask(taskId);
  if (!task || task.workspaceId !== workspaceId || !getTeam(teamId, workspaceId)) throw new HttpError(404, 'TEAM_NOT_FOUND', 'Team task scope unavailable');
  getDb().run('INSERT INTO task_team_knowledge_scope(task_id, workspace_id, team_id) VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING',
    taskId, workspaceId, teamId);
}
export function taskKnowledgeTeams(task: Task, agentId: string): string[] {
  const seen = new Set<string>(), teams = new Set<string>();
  let current: Task | undefined = getTask(task.id);
  while (current && current.workspaceId === task.workspaceId && !seen.has(current.id)) {
    seen.add(current.id);
    const row = getDb().get<{ team_id: string }>('SELECT team_id FROM task_team_knowledge_scope WHERE task_id = ? AND workspace_id = ?', current.id, task.workspaceId || 'default');
    if (row && isTeamKnowledgeMember(agentId, row.team_id, task.workspaceId || 'default')) teams.add(row.team_id);
    const parentId = current.parentTaskId || getDb().get<{ parent_task_id: string }>(
      'SELECT parent_task_id FROM execution_contexts WHERE task_id = ? AND workspace_id = ?', current.id, task.workspaceId || 'default')?.parent_task_id;
    current = parentId ? getTask(parentId) : undefined;
  }
  return [...teams];
}
export function hasPrivateKnowledgeContext(task: Task): boolean {
  const rows = getDb().all<{ body: string }>('SELECT body FROM execution_knowledge_manifests WHERE task_id = ? AND workspace_id = ?',
    task.id, task.workspaceId || 'default');
  return rows.some(row => JSON.parse(row.body).citations.some((citation: { scope: string }) => citation.scope !== 'workspace'));
}
export { documentSessionKey };
