import type { AgentDefinition, AgentSetupSnapshot } from '../types.js';
import { getDb } from '../db/database.js';
import { activeAgentVersionId, getAgentConfigVersion, persistAgentConfigVersion,
  validateConfigReferences, versionAsAgent, configChecksum, captureDomainReference } from '../db/models/agent-config-version.js';
import { getSkill, getSkillVersion, resolveSkillForAgent } from '../db/models/skill.js';
import { HttpError } from '../routes/http.js';
import { getTask } from '../db/models/task.js';
import { privateKnowledgeReferences } from '../db/models/agent-knowledge.js';

export function getAgentSetupSnapshot(taskId: string): AgentSetupSnapshot | undefined {
  const row = getDb().get<{ snapshot: string }>('SELECT snapshot FROM task_agent_setup_snapshots WHERE task_id = ?', taskId);
  return row ? JSON.parse(row.snapshot) : undefined;
}
export function pinAgentSetup(taskId: string, agent: AgentDefinition, beforeDispatch = false, exactVersionId?: string): AgentSetupSnapshot | undefined {
  const existing = getAgentSetupSnapshot(taskId);
  if (existing) {
    if (exactVersionId && existing.versionId !== exactVersionId) throw new HttpError(409, 'CONFIG_VERSION_CONFLICT', 'Task already pins another revision');
    if (existing.completeConfig && existing.agentId !== agent.id) {
      throw new HttpError(409, 'CONFIG_AGENT_CHANGED', 'Task Agent changed after configuration pinning; explicit reconciliation is required');
    }
    return existing.agentId === agent.id ? existing : undefined;
  }
  if (getDb().get('SELECT id FROM task_executions WHERE task_id = ? LIMIT 1', taskId)) return undefined;
  const task = getTask(taskId);
  const workspaceId = task?.workspaceId || 'default';
  const activeId = exactVersionId || activeAgentVersionId(agent.id, workspaceId);
  if (!activeId && !agent.config.contract && agent.config.systemInstructions === undefined
    && !agent.config.governanceBudget && !privateKnowledgeReferences(agent.id, workspaceId).length) return undefined;
  const version = activeId ? getAgentConfigVersion(activeId, agent.id, workspaceId)
    : persistAgentConfigVersion(agent, workspaceId, 'task-dispatch', 'task_snapshot');
  if (!version) throw new HttpError(409, 'CONFIG_VERSION_MISSING', 'The active Agent revision is unavailable');
  validateConfigReferences(version.snapshot, workspaceId);
  const configured = versionAsAgent(version, agent);
  const snapshot: AgentSetupSnapshot = {
    schemaVersion: 1, agentId: agent.id, name: configured.name, role: configured.role,
    description: configured.description, whenToUse: configured.whenToUse,
    systemInstructions: configured.config.systemInstructions, contract: configured.config.contract,
    config: { model: configured.model, maxTurns: configured.maxTurns, timeout: configured.config.timeout,
      maxConcurrent: configured.config.maxConcurrent, allowNetwork: configured.config.allowNetwork },
    allowedTools: version.snapshot.allowedTools, disallowedTools: version.snapshot.disallowedTools,
    versionId: version.id, versionSequence: version.sequence, configHash: version.configHash,
    completeConfig: version.snapshot, pinnedBeforeDispatch: beforeDispatch,
    ...(task?.domainId ? { domainOverride: captureDomainReference(task.domainId, workspaceId) } : {}),
  };
  getDb().run('INSERT INTO task_agent_setup_snapshots(task_id, snapshot) VALUES (?, ?) ON CONFLICT(task_id) DO NOTHING',
    taskId, JSON.stringify(snapshot));
  return getAgentSetupSnapshot(taskId);
}
export function agentWithPinnedSetup(taskId: string, agent: AgentDefinition): AgentDefinition {
  const snapshot = pinAgentSetup(taskId, agent);
  if (!snapshot || snapshot.agentId !== agent.id) return agent;
  if (snapshot.completeConfig) {
    if (configChecksum(snapshot.completeConfig) !== snapshot.configHash) throw new HttpError(409, 'CONFIG_INTEGRITY_FAILED', 'Pinned task configuration was changed');
    validateConfigReferences(snapshot.completeConfig, getTask(taskId)?.workspaceId || 'default');
    if (snapshot.domainOverride) validateConfigReferences({ ...snapshot.completeConfig, domain: snapshot.domainOverride }, getTask(taskId)?.workspaceId || 'default');
    return versionAsAgent({
      id: snapshot.versionId!, agentId: agent.id, workspaceId: getTask(taskId)?.workspaceId || 'default',
      sequence: snapshot.versionSequence!, configHash: snapshot.configHash!, snapshot: snapshot.completeConfig,
      origin: 'task_snapshot', createdBy: 'dispatch', createdAt: '',
    }, agent);
  }
  const currentTools = new Set(agent.allowedTools || agent.config.allowedTools || []);
  return { ...agent, name: snapshot.name, role: snapshot.role, description: snapshot.description,
    whenToUse: snapshot.whenToUse, model: snapshot.config.model, maxTurns: snapshot.config.maxTurns,
    allowedTools: snapshot.allowedTools.filter(tool => currentTools.has(tool)),
    disallowedTools: [...new Set([...snapshot.disallowedTools, ...(agent.disallowedTools || [])])],
    config: { ...agent.config, ...snapshot.config,
      allowedTools: snapshot.allowedTools.filter(tool => currentTools.has(tool)),
      allowNetwork: agent.config.allowNetwork === false ? false : snapshot.config.allowNetwork,
      systemInstructions: snapshot.systemInstructions, contract: snapshot.contract } };
}

export function resolvePinnedSkill(taskId: string, agent: AgentDefinition): ReturnType<typeof resolveSkillForAgent> {
  const snapshot = getAgentSetupSnapshot(taskId);
  if (!snapshot?.completeConfig || snapshot.agentId !== agent.id) return resolveSkillForAgent(agent);
  const pinned = snapshot.completeConfig.skill;
  if (!pinned) return undefined;
  validateConfigReferences(snapshot.completeConfig, getTask(taskId)?.workspaceId || 'default');
  if (pinned.versionId) return { skill: getSkill(pinned.skillId!)!, version: getSkillVersion(pinned.versionId)!,
    source: pinned.source === 'assignment' ? 'assignment' : 'skillPath' };
  return { skill: { id: `file:${pinned.sourcePath}`, name: pinned.sourcePath!, createdAt: '', updatedAt: '' },
    version: { id: `file:${pinned.checksum}`, skillId: `file:${pinned.sourcePath}`, version: 1, status: 'published',
      content: pinned.content!, checksum: pinned.checksum, createdBy: 'snapshot', createdAt: '' }, source: 'skillPath' };
}
