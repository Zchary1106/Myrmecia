import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent, getAgent, updateAgent } from '../src/db/models/agent.js';
import { createTask } from '../src/db/models/task.js';
import { upsertSkill, createSkillVersion, assignSkillVersionToAgent, archiveSkillVersion } from '../src/db/models/skill.js';
import { captureAgentConfig, configChecksum, persistAgentConfigVersion, agentConfigHistory, activateAgentVersion,
  getAgentConfigVersion, activeAgentVersionId } from '../src/db/models/agent-config-version.js';
import { getAgentSetupSnapshot, agentWithPinnedSetup, resolvePinnedSkill } from '../src/agents/agent-setup-snapshot.js';
import { persistExecutionContext } from '../src/agents/execution-context.js';
import { createAgentRoutes } from '../src/routes/agents.js';
import { createCustomModel } from '../src/models/model-registry.js';
import { createExecution, listExecutions, updateExecution } from '../src/db/models/execution.js';
import { agentConfigRunAttribution } from '../src/agents/execution-plan-snapshot.js';
import { createDomain, updateDomain } from '../src/agents/domain-registry.js';
import { resolveDomainForTask } from '../src/agents/domain-context.js';
import { AgentRuntime } from '../src/agents/agent-runtime.js';
import { tsAgentLoop } from '../src/agents/ts-agent-loop.js';
import { loopFingerprint, saveLoopCheckpoint, readLoopCheckpoint } from '../src/agents/loop-checkpoint.js';
import { initialAgentRunState } from '../src/agents/run-state.js';
import { agentWithPinnedSetup as pinnedAgent } from '../src/agents/agent-setup-snapshot.js';

const actor = { id: 'actor-a', role: 'operator' as const, source: 'proxy' as const };
let dbPath: string;
beforeEach(() => {
  closeDb(); dbPath = join(mkdtempSync(join(tmpdir(), 'agent-version-')), 'fixture.db'); process.env.DB_PATH = dbPath;
  vi.stubEnv('MYRMECIA_MODEL_PROVIDER', '');
  vi.stubEnv('MODEL_PROVIDERS', JSON.stringify({ default: { baseURL: 'http://fixture.invalid', apiKey: 'fixture-only' } }));
  getDb(); createCustomModel({ id: 'fixture-model', provider: 'default', displayName: 'Fixture' });
});
afterEach(() => { closeDb(); delete process.env.DB_PATH; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const agent = () => createAgent({ name: 'Fixture', role: 'analyst', model: 'fixture-model', allowedTools: ['file_read', 'file_write'],
  config: { systemInstructions: 'Original instructions', maxTurns: 8, modelPolicy: { maxTokens: 2048 }, timeout: 300 } });
function publish(id: string, targetVersionId?: string) {
  const history = agentConfigHistory(getAgent(id)!, 'default');
  return activateAgentVersion({ agentId: id, workspaceId: 'default', actor, expectedCurrentVersionId: history.activeVersionId,
    expectedConfigHash: history.workingConfigHash, targetVersionId });
}
describe('complete Agent revisions', () => {
  it('keeps legacy runs unversioned and records attribution for a genuinely pinned task', () => {
    const current = createAgent({ name: 'Legacy', role: 'analyst' });
    const old = createTask({ title: 'Old', description: 'Old', mode: 'direct', input: 'Old', assigneeId: current.id });
    const oldRun = createExecution({ taskId: old.id, agentDefId: current.id });
    updateAgent(current.id, { config: { systemInstructions: 'New instructions' } });
    publish(current.id); persistExecutionContext(old);
    expect(getAgentSetupSnapshot(old.id)).toBeUndefined();
    expect(agentConfigRunAttribution(oldRun)).toMatchObject({ source: 'legacy', pinnedBeforeDispatch: false });
    const task = createTask({ title: 'New', description: 'New', mode: 'direct', input: 'New', assigneeId: current.id });
    persistExecutionContext(task);
    const run = createExecution({ taskId: task.id, agentDefId: current.id });
    expect(agentConfigRunAttribution(run)).toMatchObject({ source: 'revision', sequence: 1, pinnedBeforeDispatch: true });
  });
  it('pins task domain overrides and refuses changed domain or missing knowledge rather than falling back', () => {
    const current = agent();
    const domain = createDomain({ name: 'Fixture domain', persona: 'Original domain', guidelines: [], terminology: {},
      agentIds: [], knowledgeIds: [] }, 'default');
    publish(current.id);
    const task = createTask({ title: 'Domain', description: 'Domain', mode: 'direct', input: 'Question',
      assigneeId: current.id, domainId: domain.id });
    persistExecutionContext(task);
    expect(resolveDomainForTask(pinnedAgent(task.id, current), task)?.id).toBe(domain.id);
    updateDomain(domain.id, { persona: 'Changed domain' }, 'default');
    expect(() => agentWithPinnedSetup(task.id, current)).toThrow(/Domain\/knowledge/);
    expect(() => resolveDomainForTask(current, task)).toThrow(/Domain\/knowledge/);
  });
  it('uses immutable file Skill content without inserting synthetic IDs into Skill foreign keys', async () => {
    const root = join(dbPath, '..');
    vi.stubEnv('MYRMECIA_RESOURCE_ROOT', root);
    writeFileSync(join(root, 'fixture-skill.md'), '# Original file Skill');
    const current = agent();
    updateAgent(current.id, { skillPath: 'fixture-skill.md' });
    publish(current.id);
    const task = createTask({ title: 'File Skill', description: 'File Skill', input: 'Question', mode: 'direct',
      assigneeId: current.id, workspacePath: root, workdir: root });
    persistExecutionContext(task);
    writeFileSync(join(root, 'fixture-skill.md'), '# Changed after dispatch');
    expect(resolvePinnedSkill(task.id, getAgent(current.id)!)?.version.content).toBe('# Original file Skill');
    const runtime = new AgentRuntime();
    vi.spyOn(runtime as any, 'recordTrajectory').mockImplementation(() => {});
    vi.spyOn(tsAgentLoop, 'execute').mockResolvedValue({ output: 'Fixture output', costUSD: null, costType: 'unavailable',
      inputTokens: 0, outputTokens: 0, numTurns: 1, durationMs: 1, executionId: 'fixture' });
    await runtime.execute(getAgent(current.id)!, task);
    const execution = listExecutions({ taskId: task.id })[0];
    expect(execution.status).toBe('done');
    expect(execution.skillVersionId).toBeUndefined();
    expect(agentConfigRunAttribution(execution).skillVersionId).toMatch(/^file:/);
  });
  it('runs with the pinned model/Skill despite later configuration and assignment edits', async () => {
    const current = agent();
    upsertSkill({ id: 'runtime-skill', name: 'Runtime Skill' });
    const skill = createSkillVersion({ skillId: 'runtime-skill', content: 'Pinned runtime Skill', status: 'published' });
    assignSkillVersionToAgent(current.id, skill.id);
    publish(current.id);
    const task = createTask({ title: 'Run', description: 'Run', input: 'Question', mode: 'direct', assigneeId: current.id,
      workspacePath: join(dbPath, '..'), workdir: join(dbPath, '..') });
    persistExecutionContext(task);
    const nextSkill = createSkillVersion({ skillId: 'runtime-skill', content: 'Later Skill', status: 'published' });
    assignSkillVersionToAgent(current.id, nextSkill.id);
    const changed = updateAgent(current.id, { model: 'later-model', config: { systemInstructions: 'Later', maxTurns: 100 } })!;
    const loop = vi.spyOn(tsAgentLoop, 'execute').mockResolvedValue({
      output: 'Fixture result', costUSD: null, costType: 'unavailable', inputTokens: 0, outputTokens: 0,
      numTurns: 1, durationMs: 1, executionId: 'fixture',
    });
    const runtime = new AgentRuntime();
    vi.spyOn(runtime as any, 'recordTrajectory').mockImplementation(() => {});
    await runtime.execute(changed, task);
    const [usedAgent, usedTask, , , , , , runtimeSkill] = loop.mock.calls[0];
    expect(usedAgent.config.systemInstructions).toBe('Original instructions');
    expect(usedTask.modelId).toBe('fixture-model');
    expect(runtimeSkill?.version.id).toBe(skill.id);
    expect(listExecutions({ taskId: task.id })[0].skillVersionId).toBe(skill.id);
  });
  it('preserves a paused task fingerprint across new publication and rejects revoked tool drift', () => {
    const current = agent(); publish(current.id);
    const task = createTask({ title: 'Pause', description: 'Pause', input: 'Question', mode: 'direct', assigneeId: current.id });
    persistExecutionContext(task);
    const configured = pinnedAgent(task.id, current);
    const fingerprint = (value: typeof current) => loopFingerprint({ agentId: value.id, modelId: value.model!,
      systemPrompt: value.config.systemInstructions!, input: task.input, tools: value.allowedTools! });
    const old = createExecution({ taskId: task.id, agentDefId: current.id });
    const checkpoint = { schemaVersion: 1 as const, messages: [{ role: 'user' as const, content: task.input }],
      turn: 1, inputTokens: 10, outputTokens: 10, toolCallCount: 0, toolRuntimeMs: 0, elapsedMs: 10, finalOutput: 'Partial',
      boundary: 'stable' as const };
    saveLoopCheckpoint(task, old.id, fingerprint(configured), checkpoint);
    updateExecution(old.id, { status: 'failed', runState: { ...initialAgentRunState(), phase: 'interrupted', stopReason: 'interrupted', userPaused: true } });
    updateAgent(current.id, { config: { ...current.config, systemInstructions: 'New published instructions' } });
    publish(current.id);
    const next = createExecution({ taskId: task.id, agentDefId: current.id });
    expect(readLoopCheckpoint(task, fingerprint(pinnedAgent(task.id, getAgent(current.id)!)), next.id)?.snapshot.turn).toBe(1);
    updateAgent(current.id, { allowedTools: [] });
    expect(() => readLoopCheckpoint(task, fingerprint(pinnedAgent(task.id, getAgent(current.id)!)), next.id)).toThrow(/reconciliation/);
  });
  it('uses recursive canonical checksums, deduplicates revisions and survives reopening', () => {
    const current = agent();
    expect(configChecksum({ a: { b: 1, c: 2 }, d: [1, 2] })).toBe(configChecksum({ d: [1, 2], a: { c: 2, b: 1 } }));
    expect(configChecksum({ a: { b: 1 } })).not.toBe(configChecksum({ a: { b: 2 } }));
    const first = persistAgentConfigVersion(current, 'default', actor.id, 'publish');
    expect(persistAgentConfigVersion(current, 'default', 'other', 'task_snapshot').id).toBe(first.id);
    const next = persistAgentConfigVersion(updateAgent(current.id, { config: { ...current.config, modelPolicy: { maxTokens: 4096 } } })!,
      'default', actor.id, 'publish');
    expect(next.sequence).toBe(2); expect(next.configHash).not.toBe(first.configHash);
    closeDb(); process.env.DB_PATH = dbPath; getDb();
    expect(getAgentConfigVersion(first.id, current.id, 'default')).toEqual(first);
    expect(getAgentConfigVersion(first.id, current.id, 'other')).toBeUndefined();
  });
  it('publishes/rolls back only the future pointer and rejects stale working/active revisions', () => {
    const current = agent(), first = publish(current.id);
    const before = createTask({ title: 'Queued', description: 'Queued', mode: 'direct', input: 'Question', assigneeId: current.id });
    persistExecutionContext(before);
    updateAgent(current.id, { config: { ...current.config, systemInstructions: 'Second version' } });
    const history = agentConfigHistory(getAgent(current.id)!, 'default');
    expect(history.workingChanges).toContain('systemInstructions');
    const second = publish(current.id);
    expect(() => activateAgentVersion({ agentId: current.id, workspaceId: 'default', actor,
      expectedCurrentVersionId: first.id, expectedConfigHash: history.workingConfigHash })).toThrow(/Active revision/);
    expect(getAgentSetupSnapshot(before.id)?.versionId).toBe(first.id);
    expect(agentWithPinnedSetup(before.id, getAgent(current.id)!).config.systemInstructions).toBe('Original instructions');
    publish(current.id, first.id);
    expect(activeAgentVersionId(current.id, 'default')).toBe(first.id);
    const after = createTask({ title: 'After rollback', description: 'After', mode: 'direct', input: 'Question', assigneeId: current.id });
    persistExecutionContext(after);
    expect(getAgentSetupSnapshot(after.id)?.versionId).toBe(first.id);
    expect(getAgentConfigVersion(second.id, current.id, 'default')?.snapshot.systemInstructions).toBe('Second version');
    const stale = agentConfigHistory(getAgent(current.id)!, 'default');
    updateAgent(current.id, { name: 'Concurrent edit' });
    expect(() => activateAgentVersion({ agentId: current.id, workspaceId: 'default', actor,
      expectedCurrentVersionId: stale.activeVersionId, expectedConfigHash: stale.workingConfigHash })).toThrow(/Working configuration/);
  });
  it('pins published Skill content through reassignment but blocks archived/deleted references', () => {
    const current = agent();
    upsertSkill({ id: 'skill-fixture', name: 'Skill' });
    const first = createSkillVersion({ skillId: 'skill-fixture', content: 'Original Skill', status: 'published' });
    assignSkillVersionToAgent(current.id, first.id);
    const revision = publish(current.id);
    const task = createTask({ title: 'Queued', description: 'Queued', mode: 'direct', input: 'Question', assigneeId: current.id });
    persistExecutionContext(task);
    const second = createSkillVersion({ skillId: 'skill-fixture', content: 'Changed Skill', status: 'published' });
    assignSkillVersionToAgent(current.id, second.id);
    expect(resolvePinnedSkill(task.id, getAgent(current.id)!)?.version.content).toBe('Original Skill');
    expect(getAgentSetupSnapshot(task.id)?.completeConfig?.skill?.versionId).toBe(first.id);
    archiveSkillVersion(first.id);
    expect(() => resolvePinnedSkill(task.id, getAgent(current.id)!)).toThrow(/archived/);
    expect(() => publish(current.id, revision.id)).toThrow(/archived/);
  });
  it('keeps history and rollback usable when the working Skill becomes unavailable', () => {
    const current = agent();
    upsertSkill({ id: 'recoverable-skill', name: 'Recoverable' });
    const firstSkill = createSkillVersion({ skillId: 'recoverable-skill', content: 'Good Skill', status: 'published' });
    assignSkillVersionToAgent(current.id, firstSkill.id);
    const first = publish(current.id);
    const invalidSkill = createSkillVersion({ skillId: 'recoverable-skill', content: 'Later Skill', status: 'published' });
    assignSkillVersionToAgent(current.id, invalidSkill.id);
    archiveSkillVersion(invalidSkill.id);
    const history = agentConfigHistory(getAgent(current.id)!, 'default');
    expect(history.workingError).toContain('unavailable');
    expect(history.versions[0].id).toBe(first.id);
    expect(() => activateAgentVersion({ agentId: current.id, workspaceId: 'default', actor,
      expectedCurrentVersionId: first.id, expectedConfigHash: history.workingConfigHash })).toThrow(/unavailable/);
    expect(activateAgentVersion({ agentId: current.id, workspaceId: 'default', actor, targetVersionId: first.id,
      expectedCurrentVersionId: first.id, expectedConfigHash: history.workingConfigHash }).id).toBe(first.id);
  });
  it('keeps revoked permissions restricted and detects tampered immutable bytes', () => {
    const current = agent(), revision = publish(current.id);
    const task = createTask({ title: 'Queued', description: 'Queued', mode: 'direct', input: 'Question', assigneeId: current.id });
    persistExecutionContext(task);
    const restricted = updateAgent(current.id, { allowedTools: ['file_read'], disallowedTools: ['file_write'],
      config: { ...current.config, allowNetwork: false } })!;
    expect(agentWithPinnedSetup(task.id, restricted).allowedTools).toEqual(['file_read']);
    expect(agentWithPinnedSetup(task.id, restricted).config.allowNetwork).toBe(false);
    getDb().run('UPDATE agent_config_versions SET snapshot = ? WHERE id = ?', JSON.stringify({ ...revision.snapshot, name: 'Tampered' }), revision.id);
    expect(() => getAgentConfigVersion(revision.id, current.id, 'default')).toThrow(/hash/);
  });
  it('refuses credential snapshots rather than persisting account secrets', () => {
    const current = agent();
    const changed = updateAgent(current.id, { config: { systemInstructions: 'sk-' + 'x'.repeat(40) } })!;
    expect(() => captureAgentConfig(changed, 'default')).toThrow(/credentials/);
    expect(getDb().all('SELECT * FROM agent_config_versions')).toHaveLength(0);
  });
});

describe('Agent revision HTTP authorization', () => {
  it('isolates workspace routes, enforces viewer denial and detects publish conflicts', async () => {
    const current = agent();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).tenantContext = { userId: 'actor-a', role: 'operator',
      workspaceId: req.header('x-fixture-workspace') || 'default' }; next(); });
    app.use('/agents', createAgentRoutes());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agents/${current.id}/config-versions`;
    try {
      const history = await (await fetch(base)).json();
      const body = { expectedCurrentVersionId: null, expectedConfigHash: history.workingConfigHash };
      const post = (headers: Record<string, string> = {}) => fetch(base + '/publish', { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      expect((await fetch(base, { headers: { 'x-fixture-workspace': 'other' } })).status).toBe(404);
      expect((await post({ 'x-operator-id': 'viewer', 'x-operator-role': 'viewer' })).status).toBe(403);
      const created = await post(); expect(created.status).toBe(200);
      const revision = await created.json();
      expect((await post()).status).toBe(409);
      expect((await fetch(base + `/${revision.id}`)).status).toBe(200);
      expect((await fetch(base + `/${revision.id}`, { headers: { 'x-fixture-workspace': 'other' } })).status).toBe(404);
      const rollback = await fetch(base + `/${revision.id}/rollback`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, expectedCurrentVersionId: revision.id }) });
      expect(rollback.status).toBe(200);
      expect(getDb().all("SELECT * FROM operator_actions WHERE action LIKE 'agent.config.%'")).toHaveLength(2);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
