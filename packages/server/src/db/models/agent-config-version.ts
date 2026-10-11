import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDefinition, AgentConfigSnapshot, AgentConfigVersion, AgentConfigHistory } from '../../types.js';
import { getDb } from '../database.js';
import { getAgent } from './agent.js';
import { getSkillAssignmentForAgent, getSkill, getSkillVersion, resolveSkillForAgent, checksumSkillContent } from './skill.js';
import { resolveDomainForAgent, getDomain } from '../../agents/domain-registry.js';
import { scanForPII } from '../../security/dlp.js';
import { HttpError } from '../../routes/http.js';
import { createOperatorAction } from './operator-action.js';
import type { OperatorActor } from '../../types.js';
import { privateKnowledgeReferences, readBoundKnowledge } from './agent-knowledge.js';

export function canonicalConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConfig);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonicalConfig(item)]));
  return value;
}
export function configChecksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalConfig(value)) ?? 'null').digest('hex');
}
function domainHash(domain: NonNullable<ReturnType<typeof getDomain>>): string {
  return configChecksum({ id: domain.id, version: domain.version, persona: domain.persona, guidelines: domain.guidelines,
    terminology: domain.terminology, disclaimer: domain.disclaimer, tone: domain.tone,
    retrieval: domain.retrieval, knowledgeIds: domain.knowledgeIds });
}
export function captureDomainReference(domainId: string, workspaceId: string): AgentConfigSnapshot['domain'] {
  const domain = getDomain(domainId, workspaceId);
  if (!domain) throw new HttpError(409, 'CONFIG_KNOWLEDGE_UNAVAILABLE', 'Task domain is unavailable in this workspace');
  return { id: domain.id, version: domain.version || 1, configHash: domainHash(domain), knowledgeIds: domain.knowledgeIds };
}
function skillFile(path: string): string {
  const root = resolve(process.env.MYRMECIA_RESOURCE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..'));
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(path) || rel === '..' || rel.startsWith('../')) throw new HttpError(409, 'CONFIG_SKILL_SCOPE_DENIED', 'Skill file is outside the resource scope');
  try {
    const realRoot = realpathSync(root), realTarget = realpathSync(target);
    const scope = relative(realRoot, realTarget);
    if (scope === '..' || scope.startsWith('../') || isAbsolute(scope)) throw new Error('outside scope');
    if (statSync(realTarget).size > 200_000) throw new Error('too large');
    return readFileSync(realTarget, 'utf8');
  }
  catch { throw new HttpError(409, 'CONFIG_SKILL_UNAVAILABLE', 'Referenced Skill file is unavailable'); }
}
export function captureAgentConfig(agent: AgentDefinition, workspaceId: string): AgentConfigSnapshot {
  const assignment = getSkillAssignmentForAgent(agent.id);
  const resolvedSkill = resolveSkillForAgent(agent);
  if (assignment && (!resolvedSkill || resolvedSkill.version.id !== assignment.skillVersionId)) {
    throw new HttpError(409, 'CONFIG_SKILL_UNAVAILABLE', 'Assigned Skill is unavailable or no longer published');
  }
  const fileContent = !resolvedSkill && agent.skillPath ? skillFile(agent.skillPath) : undefined;
  const skill: AgentConfigSnapshot['skill'] = resolvedSkill ? {
    source: resolvedSkill.source, skillId: resolvedSkill.skill.id, versionId: resolvedSkill.version.id,
    checksum: resolvedSkill.version.checksum,
  } : agent.skillPath ? { source: 'file', sourcePath: agent.skillPath, checksum: checksumSkillContent(fileContent!),
    content: fileContent } : null;
  const domain = resolveDomainForAgent(agent.id, undefined, workspaceId);
  const knowledge = privateKnowledgeReferences(agent.id, workspaceId);
  const snapshot: AgentConfigSnapshot = {
    schemaVersion: 1, agentId: agent.id, name: agent.name, role: agent.role, emoji: agent.emoji,
    description: agent.description || '', whenToUse: agent.whenToUse, capabilities: agent.capabilities || [],
    triggers: agent.triggers || [], systemInstructions: agent.config.systemInstructions || '', contract: agent.config.contract,
    config: { model: agent.model || agent.config.model, modelPolicy: agent.config.modelPolicy,
      ...(agent.config.governanceBudget ? { governanceBudget: agent.config.governanceBudget } : {}),
      maxTurns: agent.maxTurns || agent.config.maxTurns, timeout: agent.config.timeout,
      maxConcurrent: agent.config.maxConcurrent, allowNetwork: agent.config.allowNetwork, workdir: agent.config.workdir },
    allowedTools: [...new Set(agent.allowedTools || agent.config.allowedTools || [])].sort(),
    disallowedTools: [...new Set(agent.disallowedTools || [])].sort(),
    skill, domain: domain ? { id: domain.id, version: domain.version || 1, configHash: domainHash(domain), knowledgeIds: domain.knowledgeIds } : null,
    ...(knowledge.length ? { knowledge } : {}),
  };
  if (resolvedSkill) assertNoCredentials({ ...snapshot, skill: { ...snapshot.skill!, content: resolvedSkill.version.content } });
  assertNoCredentials(snapshot);
  return canonicalConfig(snapshot) as AgentConfigSnapshot;
}
function assertNoCredentials(snapshot: AgentConfigSnapshot): void {
  if (scanForPII(JSON.stringify(snapshot)).violations.some(item => ['api_key', 'aws_key', 'private_key'].includes(item.type))) {
    throw new HttpError(400, 'CONFIG_CONTAINS_CREDENTIALS', 'Agent revision cannot persist credentials; use configured provider references');
  }
}
function fromRow(row: any): AgentConfigVersion {
  const snapshot = JSON.parse(row.snapshot) as AgentConfigSnapshot;
  if (configChecksum(snapshot) !== row.config_hash) throw new HttpError(409, 'CONFIG_INTEGRITY_FAILED', 'Agent revision hash does not match its stored configuration');
  return { id: row.id, agentId: row.agent_id, workspaceId: row.workspace_id, sequence: row.sequence,
    configHash: row.config_hash, snapshot, createdBy: row.created_by, origin: row.origin, createdAt: row.created_at };
}
export function activeAgentVersionId(agentId: string, workspaceId: string): string | null {
  return getDb().get<{ version_id: string }>('SELECT version_id FROM agent_config_active WHERE agent_id = ? AND workspace_id = ?',
    agentId, workspaceId)?.version_id || null;
}
export function getAgentConfigVersion(id: string, agentId: string, workspaceId: string): AgentConfigVersion | undefined {
  const row = getDb().get('SELECT * FROM agent_config_versions WHERE id = ? AND agent_id = ? AND workspace_id = ?', id, agentId, workspaceId);
  return row ? fromRow(row) : undefined;
}
export function persistAgentConfigVersion(agent: AgentDefinition, workspaceId: string, createdBy: string,
  origin: AgentConfigVersion['origin']): AgentConfigVersion {
  if (!getDb().get('SELECT id FROM agents WHERE id = ? AND workspace_id = ?', agent.id, workspaceId)) {
    throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent is unavailable in this workspace');
  }
  const snapshot = captureAgentConfig(agent, workspaceId);
  const hash = configChecksum(snapshot), db = getDb();
  return db.transaction(() => {
    const row = db.get('SELECT * FROM agent_config_versions WHERE agent_id = ? AND workspace_id = ? AND config_hash = ?',
      agent.id, workspaceId, hash);
    if (row) return fromRow(row);
    const next = (db.get<{ n: number }>('SELECT MAX(sequence) AS n FROM agent_config_versions WHERE agent_id = ? AND workspace_id = ?',
      agent.id, workspaceId)?.n || 0) + 1;
    const id = `acv_${randomUUID()}`;
    db.run(`INSERT INTO agent_config_versions(id, agent_id, workspace_id, sequence, config_hash, snapshot, created_by, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, agent.id, workspaceId, next, hash, JSON.stringify(snapshot), createdBy, origin);
    return getAgentConfigVersion(id, agent.id, workspaceId)!;
  });
}
export function validateConfigReferences(snapshot: AgentConfigSnapshot, workspaceId: string): void {
  for (const source of snapshot.knowledge || []) readBoundKnowledge(source, snapshot.agentId, workspaceId, 'agent_private', snapshot.agentId);
  if (snapshot.skill?.versionId) {
    const version = getSkillVersion(snapshot.skill.versionId);
    if (!getSkill(snapshot.skill.skillId!) || !version || version.status !== 'published'
      || version.checksum !== snapshot.skill.checksum || checksumSkillContent(version.content) !== snapshot.skill.checksum) {
      throw new HttpError(409, 'CONFIG_SKILL_UNAVAILABLE', 'Pinned Skill is deleted, archived or changed; explicit reconciliation is required');
    }
  } else if (snapshot.skill?.sourcePath) {
    // Keep immutable content while still requiring the referenced resource to exist.
    skillFile(snapshot.skill.sourcePath);
    if (checksumSkillContent(snapshot.skill.content || '') !== snapshot.skill.checksum) {
      throw new HttpError(409, 'CONFIG_INTEGRITY_FAILED', 'Pinned Skill content checksum mismatch');
    }
  }
  if (snapshot.domain) {
    const domain = getDomain(snapshot.domain.id, workspaceId);
    if (!domain || domainHash(domain) !== snapshot.domain.configHash) {
      throw new HttpError(409, 'CONFIG_KNOWLEDGE_CHANGED', 'Domain/knowledge bindings changed; explicit reconciliation is required');
    }
    if (snapshot.domain.knowledgeIds.length) {
      const exists = getDb().get('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', 'table', 'knowledge_documents');
      if (!exists || snapshot.domain.knowledgeIds.some(id => !getDb().get(
        'SELECT id FROM knowledge_documents WHERE id = ? AND workspace_id = ?', id, workspaceId))) {
        throw new HttpError(409, 'CONFIG_KNOWLEDGE_UNAVAILABLE', 'Referenced knowledge is unavailable in the current workspace');
      }
    }
  }
}
export function versionAsAgent(version: AgentConfigVersion, current: AgentDefinition): AgentDefinition {
  const value = version.snapshot;
  const currentTools = new Set(current.allowedTools || current.config.allowedTools || []);
  return { ...current, name: value.name, role: value.role, emoji: value.emoji, description: value.description,
    whenToUse: value.whenToUse, capabilities: value.capabilities, triggers: value.triggers,
    model: value.config.model, maxTurns: value.config.maxTurns, skillPath: undefined,
    allowedTools: value.allowedTools.filter(tool => currentTools.has(tool)),
    disallowedTools: [...new Set([...value.disallowedTools, ...(current.disallowedTools || [])])],
    config: { ...value.config, systemInstructions: value.systemInstructions, contract: value.contract,
      allowedTools: value.allowedTools.filter(tool => currentTools.has(tool)),
      allowNetwork: current.config.allowNetwork === false ? false : value.config.allowNetwork } };
}
export function agentConfigHistory(agent: AgentDefinition, workspaceId: string): AgentConfigHistory {
  const versions = getDb().all('SELECT * FROM agent_config_versions WHERE agent_id = ? AND workspace_id = ? ORDER BY sequence DESC',
    agent.id, workspaceId).map(fromRow);
  const working = workingConfigState(agent, workspaceId), activeVersionId = activeAgentVersionId(agent.id, workspaceId);
  const active = versions.find(version => version.id === activeVersionId);
  return { activeVersionId, workingConfigHash: working.hash, workingError: working.error,
    workingChanges: !working.snapshot ? ['unavailable'] : active ? Object.keys(working.snapshot).filter(key => configChecksum((working.snapshot as any)[key] ?? null)
      !== configChecksum((active.snapshot as any)[key] ?? null)) : ['unpublished'],
    versions };
}
function workingConfigState(agent: AgentDefinition, workspaceId: string): {
  hash: string; snapshot?: AgentConfigSnapshot; error?: string;
} {
  try {
    const snapshot = captureAgentConfig(agent, workspaceId);
    return { hash: configChecksum(snapshot), snapshot };
  } catch (error) {
    // Hash unavailable working data, never expose/store its potentially sensitive content.
    const assignment = getSkillAssignmentForAgent(agent.id);
    const skill = assignment ? getSkillVersion(assignment.skillVersionId) : undefined;
    const domain = resolveDomainForAgent(agent.id, undefined, workspaceId);
    return { hash: configChecksum({ unavailable: true, agent, assignment,
      skillStatus: skill?.status, skillChecksum: skill?.checksum, domain: domain ? domainHash(domain) : null }),
    error: error instanceof HttpError ? error.message : 'Working configuration cannot be resolved' };
  }
}
export function agentForFutureDispatch(agent: AgentDefinition, workspaceId: string): {
  agent: AgentDefinition; skillVersionId?: string; version?: AgentConfigVersion;
} {
  const id = activeAgentVersionId(agent.id, workspaceId);
  if (!id) return { agent, skillVersionId: getSkillAssignmentForAgent(agent.id)?.skillVersionId };
  const version = getAgentConfigVersion(id, agent.id, workspaceId);
  if (!version) throw new HttpError(409, 'CONFIG_VERSION_MISSING', 'The active Agent revision is unavailable');
  validateConfigReferences(version.snapshot, workspaceId);
  return { agent: versionAsAgent(version, agent), skillVersionId: version.snapshot.skill?.versionId, version };
}
export function activateAgentVersion(input: {
  agentId: string; workspaceId: string; actor: OperatorActor; expectedCurrentVersionId: string | null;
  expectedConfigHash: string; targetVersionId?: string;
}): AgentConfigVersion {
  const db = getDb();
  return db.transaction(() => {
    const agent = getAgent(input.agentId);
    if (!agent || !db.get('SELECT id FROM agents WHERE id = ? AND workspace_id = ?', input.agentId, input.workspaceId)) {
      throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent not found');
    }
    const active = activeAgentVersionId(agent.id, input.workspaceId);
    if (active !== input.expectedCurrentVersionId) throw new HttpError(409, 'CONFIG_VERSION_CONFLICT', 'Active revision changed; reload before publishing');
    if (workingConfigState(agent, input.workspaceId).hash !== input.expectedConfigHash) {
      throw new HttpError(409, 'CONFIG_WORKING_COPY_CHANGED', 'Working configuration or dependencies changed; reload before publishing');
    }
    const version = input.targetVersionId ? getAgentConfigVersion(input.targetVersionId, agent.id, input.workspaceId)
      : persistAgentConfigVersion(agent, input.workspaceId, input.actor.id || 'local', 'publish');
    if (!version) throw new HttpError(404, 'CONFIG_VERSION_NOT_FOUND', 'Revision not found');
    validateConfigReferences(version.snapshot, input.workspaceId);
    db.run(`INSERT INTO agent_config_active(workspace_id, agent_id, version_id) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, agent_id) DO UPDATE SET version_id = excluded.version_id, updated_at = CURRENT_TIMESTAMP`,
      input.workspaceId, agent.id, version.id);
    createOperatorAction({ action: input.targetVersionId ? 'agent.config.rollback' : 'agent.config.publish',
      actor: input.actor, targetType: 'agent', targetId: agent.id, metadata: {
        previousVersionId: active, versionId: version.id, configHash: version.configHash,
        affects: 'future tasks only; does not grant revoked permissions',
      } });
    return version;
  });
}

/** Capacity reads must not pin or create a revision as a side effect. */
export function configuredConcurrency(agent: AgentDefinition, workspaceId: string): number {
  const id = activeAgentVersionId(agent.id, workspaceId);
  if (!id) return agent.config.maxConcurrent || 1;
  return getAgentConfigVersion(id, agent.id, workspaceId)?.snapshot.config.maxConcurrent || 1;
}
