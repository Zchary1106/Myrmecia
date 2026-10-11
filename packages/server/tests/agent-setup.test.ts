import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent, listAgents } from '../src/db/models/agent.js';
import { createTask, getTask, listTasks, updateTask } from '../src/db/models/task.js';
import { createCustomModel, updateModel } from '../src/models/model-registry.js';
import { syncBuiltinTools, updateToolPolicy } from '../src/tools/tool-registry.js';
import { getMcpManager } from '../src/tools/mcp-manager.js';
import { xiaohongshuSession, XiaohongshuSession } from '../src/tools/xiaohongshu-session.js';
import { preflightAgent, setupEntity } from '../src/agents/agent-setup.js';
import { createAgentRoutes } from '../src/routes/agents.js';
import { TaskQueue } from '../src/queue/task-queue.js';
import type { AgentManager } from '../src/agents/agent-manager.js';
import { eventBus } from '../src/events/event-bus.js';
import { upsertSkill, createSkillVersion } from '../src/db/models/skill.js';
import { agentSetupPayload } from '@myrmecia/shared';

let path: string;
beforeEach(() => {
  closeDb();
  path = join(mkdtempSync(join(tmpdir(), 'myrmecia-agent-setup-')), 'test.db');
  process.env.DB_PATH = path;
  vi.stubEnv('MYRMECIA_MODEL_PROVIDER', '');
  vi.stubEnv('MODEL_PROVIDERS', JSON.stringify({ default: { baseURL: 'http://fixture.invalid/v1', apiKey: 'fixture-only' } }));
  vi.stubEnv('MODEL_PROVIDER_MAP', '');
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
  vi.stubEnv('MCP_TOOLS_IN_AGENTS', 'true');
  getDb();
  createCustomModel({ id: 'fixture-model', provider: 'default', displayName: 'Fixture' });
  syncBuiltinTools();
});
afterEach(() => {
  (eventBus as any).emitter.removeAllListeners();
  closeDb(); delete process.env.DB_PATH;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

const body = { name: 'Setup Fixture', role: 'analyst', model: 'fixture-model', allowedTools: [] };
async function withRoutes(fn: (base: string, execute: ReturnType<typeof vi.fn>) => Promise<void>) {
  const execute = vi.fn(async (_agentId, task) => {
    updateTask(task.id, { status: 'running' });
    return 'fixture';
  });
  const queue = new TaskQueue({ executeTask: execute, hasCapacity: () => true } as unknown as AgentManager);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header('x-fixture-workspace')) (req as any).tenantContext = {
      workspaceId: req.header('x-fixture-workspace'), userId: req.header('x-operator-id') || 'actor-a', role: 'operator',
    };
    next();
  });
  app.use('/agents', createAgentRoutes(queue));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, execute); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const post = async (base: string, route: string, data: unknown, key?: string, extra: Record<string, string> = {}) => {
  const response = await fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}), ...extra }, body: JSON.stringify(data) });
  return { status: response.status, body: await response.json() };
};

describe('Agent setup persistence and preflight', () => {
  it('provides scoped draft routes with optimistic updates and rejects secrets/viewers', async () => {
    const { randomUUID } = await import('node:crypto');
    const form = { name: 'Draft', role: 'analyst', emoji: '🤖', description: '', whenToUse: '', systemInstructions: '',
      capabilities: '', triggers: '', allowedTools: [], model: 'fixture-model', skillVersionId: '', testPrompt: '',
      maxTurns: 50, timeout: 300, maxConcurrent: 1, contractEnabled: false, owns: [], doesNotOwn: [], escalatesTo: [],
      definitionOfDone: [], inputs: [], outputs: [] };
    await withRoutes(async base => {
      const id = randomUUID();
      const request = (data: unknown, extra: Record<string, string> = {}) => fetch(`${base}/agents/setup-drafts/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-operator-id': 'actor-a', ...extra }, body: JSON.stringify(data),
      });
      const input = { form, expectedRevision: 0, step: 0, locked: false, testSubmitted: false };
      expect((await request(input, { 'x-operator-role': 'viewer' })).status).toBe(403);
      const first = await (await request(input)).json();
      expect(first.revision).toBe(1);
      expect((await fetch(`${base}/agents/setup-drafts/${id}`, { headers: { 'x-operator-id': 'other' } })).status).toBe(404);
      expect((await fetch(`${base}/agents/setup-drafts/${id}`, { headers: { 'x-fixture-workspace': 'other', 'x-operator-id': 'actor-a' } })).status).toBe(404);
      expect((await request({ ...input, expectedRevision: 1, step: 1 })).status).toBe(200);
      expect((await request({ ...input, expectedRevision: 1, form: { ...form, name: 'conflict' } })).status).toBe(409);
      expect((await request({ ...input, expectedRevision: 2, form: { ...form, systemInstructions: 'sk-' + 'a'.repeat(40) } })).status).toBe(400);
      expect((await request({ ...input, expectedRevision: 2, form: { ...form, maxTurns: 0 } })).status).toBe(400);
      const list = await (await fetch(`${base}/agents/setup-drafts`, { headers: { 'x-operator-id': 'actor-a' } })).json();
      expect(list).toHaveLength(1);
      const locked = await (await request({ ...input, expectedRevision: 2, locked: true,
        form: { ...form, description: 'Mission' } })).json();
      const creationBody = agentSetupPayload(locked.form);
      expect((await post(base, '/agents', { ...creationBody, name: 'Different' }, locked.creationKey, { 'x-operator-id': 'actor-a' })).status).toBe(409);
      const created = await post(base, '/agents', creationBody, locked.creationKey, { 'x-operator-id': 'actor-a' });
      expect(created.status).toBe(201);
      const restored = await (await fetch(`${base}/agents/setup-drafts/${id}`, { headers: { 'x-operator-id': 'actor-a' } })).json();
      expect(restored.agentId).toBe(created.body.id);
      expect(restored.stage).toBe('saved');
      expect((await post(base, `/agents/${created.body.id}/test`, { prompt: 'Unapproved test' }, locked.testKey,
        { 'x-operator-id': 'actor-a' })).status).toBe(409);
    });
  });
  it('normalizes editor contract identity and preserves independent routing/instructions', async () => {
    await withRoutes(async base => {
      const contract = { schemaVersion: '1.0', agentId: '__new_agent__', role: body.role,
        responsibility: { summary: 'Research', owns: ['research'], doesNotOwn: ['publish'] }, inputs: [],
        outputs: [{ name: 'Answer', kind: 'markdown', required: true }], skills: [], tools: [],
        quality: { definitionOfDone: ['Provide sources'] } };
      const created = await post(base, '/agents', { ...body, description: 'Mission', whenToUse: 'Routing',
        config: { systemInstructions: 'Instructions', contract } }, 'contract-create-123');
      expect(created.status).toBe(201);
      expect(created.body.id).not.toBe('__new_agent__');
      expect(created.body.config.contract.agentId).toBe(created.body.id);
      expect(created.body.whenToUse).toBe('Routing');
      expect(created.body.config.systemInstructions).toBe('Instructions');
      expect((await post(base, '/agents', { ...body, config: { contract: { ...contract, role: 'mismatch' } } })).status).toBe(400);
    });
  });
  it('reuses a creation after concurrent retries, rejects changed payloads and survives DB reopen', async () => {
    await withRoutes(async base => {
      const results = await Promise.all([post(base, '/agents', body, 'same-key-123'), post(base, '/agents', body, 'same-key-123')]);
      expect(results.map(result => result.status).sort()).toEqual([200, 201]);
      expect(results[0].body.id).toBe(results[1].body.id);
      expect(listAgents()).toHaveLength(1);
      expect((await post(base, '/agents', { ...body, name: 'Changed' }, 'same-key-123')).status).toBe(409);
      closeDb(); process.env.DB_PATH = path; getDb();
      expect((await post(base, '/agents', body, 'same-key-123')).body.id).toBe(results[0].body.id);
      expect(getDb().all('SELECT * FROM operator_actions WHERE action = ?', 'agent.create')).toHaveLength(1);
    });
  });
  it('scopes identical keys to actors/workspaces and denies viewer creation/preflight', async () => {
    await withRoutes(async base => {
      const a = await post(base, '/agents', body, 'scoped-key-123', { 'x-operator-id': 'actor-a', 'x-fixture-workspace': 'workspace-a' });
      const b = await post(base, '/agents', body, 'scoped-key-123', { 'x-operator-id': 'actor-b', 'x-fixture-workspace': 'workspace-a' });
      const c = await post(base, '/agents', body, 'scoped-key-123', { 'x-operator-id': 'actor-a', 'x-fixture-workspace': 'workspace-b' });
      expect(new Set([a.body.id, b.body.id, c.body.id]).size).toBe(3);
      expect(listAgents({ workspaceId: 'workspace-a' })).toHaveLength(2);
      expect((await post(base, `/agents/${a.body.id}/test`, { prompt: 'fixture' }, 'test-key-123', {
        'x-fixture-workspace': 'workspace-b',
      })).status).toBe(404);
      for (const route of ['/agents', '/agents/preflight']) {
        expect((await post(base, route, body, 'viewer-key-123', { 'x-operator-id': 'viewer', 'x-operator-role': 'viewer' })).status).toBe(403);
      }
    });
  });
  it('rolls back the entity when its creation transaction fails', () => {
    expect(() => setupEntity({ workspaceId: 'default', actorId: 'fixture', operation: 'create', key: 'rollback-key-123', payload: body }, () => {
      createAgent(body);
      throw new Error('fixture rollback');
    })).toThrow('rollback');
    expect(listAgents()).toHaveLength(0);
    expect(getDb().all('SELECT * FROM agent_setup_requests')).toHaveLength(0);
  });
  it('dispatches only the replayed task and leaves unrelated queued work untouched', async () => {
    const selected = createAgent({ ...body, id: 'selected' }), other = createAgent({ ...body, id: 'other' });
    const target = createTask({ title: 'target', description: '', input: '', mode: 'direct', assigneeId: selected.id });
    const unrelated = createTask({ title: 'unrelated', description: '', input: '', mode: 'direct', assigneeId: other.id });
    updateTask(target.id, { status: 'queued' }); updateTask(unrelated.id, { status: 'queued' });
    const execute = vi.fn(() => new Promise<string>(() => {}));
    const queue = new TaskQueue({ executeTask: execute, hasCapacity: () => true } as unknown as AgentManager);
    await queue.dispatchExisting(target.id);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(selected.id, expect.objectContaining({ id: target.id }));
    expect(getTask(unrelated.id)?.status).toBe('queued');
  });
  it('marks a Redis task queued before dispatch and does not overwrite an immediate worker outcome', async () => {
    const agent = createAgent(body);
    const task = createTask({ title: 'fixture', description: '', input: '', mode: 'direct', assigneeId: agent.id });
    const queue = new TaskQueue({ executeTask: vi.fn() } as unknown as AgentManager);
    (queue as any).queue = { add: vi.fn(async () => {
      expect(getTask(task.id)?.status).toBe('queued');
      updateTask(task.id, { status: 'done' });
    }) };
    await queue.dispatchExisting(task.id);
    expect(getTask(task.id)?.status).toBe('done');
  });
  it('creates one test task with the selected model after lost/duplicate responses', async () => {
    await withRoutes(async (base, execute) => {
      const agent = (await post(base, '/agents', body, 'create-key-123')).body;
      const results = await Promise.all([
        post(base, `/agents/${agent.id}/test`, { prompt: 'Explain a fixture' }, 'test-key-123'),
        post(base, `/agents/${agent.id}/test`, { prompt: 'Explain a fixture' }, 'test-key-123'),
      ]);
      expect(results.every(result => result.status === 200)).toBe(true);
      expect(results[0].body.taskId).toBe(results[1].body.taskId);
      expect(listTasks()).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(getTask(results[0].body.taskId)).toMatchObject({ modelId: 'fixture-model', maxRetries: 0 });
      expect((await post(base, `/agents/${agent.id}/test`, { prompt: 'Changed' }, 'test-key-123')).status).toBe(409);
    });
  });
  it('retries dispatch of the persisted test after a queue failure without creating another task', async () => {
    await withRoutes(async (base, execute) => {
      const agent = (await post(base, '/agents', body, 'create-key-123')).body;
      const original = TaskQueue.prototype.dispatchExisting;
      const dispatch = vi.spyOn(TaskQueue.prototype, 'dispatchExisting').mockRejectedValueOnce(new Error('fixture queue offline'))
        .mockImplementation(original);
      expect((await post(base, `/agents/${agent.id}/test`, { prompt: 'fixture' }, 'test-key-123')).status).toBe(500);
      const stored = listTasks()[0];
      const resumed = await post(base, `/agents/${agent.id}/test`, { prompt: 'fixture' }, 'test-key-123');
      expect(resumed.status).toBe(200);
      expect(resumed.body.taskId).toBe(stored.id);
      expect(listTasks()).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(2);
    });
  });
  it('blocks disabled model tests while still allowing save-only creation', async () => {
    await withRoutes(async (base, execute) => {
      updateModel('fixture-model', { enabled: false });
      const agent = await post(base, '/agents', body, 'create-key-123');
      expect(agent.status).toBe(201);
      const preflight = await post(base, '/agents/preflight', body);
      expect(preflight.body.canTest).toBe(false);
      expect((await post(base, `/agents/${agent.body.id}/test`, { prompt: 'fixture' }, 'test-key-123')).status).toBe(409);
      expect(listTasks()).toHaveLength(0); expect(execute).not.toHaveBeenCalled();
    });
  });
  it('distinguishes unavailable and approval-required tools without changing permissions', () => {
    const agent = createAgent({ ...body, allowedTools: ['file_read', 'shell_exec', 'no-such-tool'] });
    updateToolPolicy('file_read', { enabled: false });
    updateToolPolicy('shell_exec', { approvalRequired: true });
    const result = preflightAgent(agent);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'file_read', status: 'unavailable', blocking: true }),
      expect.objectContaining({ id: 'shell_exec', status: 'requires_approval', blocking: false }),
      expect.objectContaining({ id: 'no-such-tool', status: 'unavailable', blocking: true }),
    ]));
    expect(result.canTest).toBe(false);
  });
  it('shows disconnected MCP and unknown login without calling MCP or accessing login', () => {
    const manager = getMcpManager();
    vi.spyOn(manager, 'servers').mockReturnValue([{ name: 'xiaohongshu', connected: false, toolCount: 0, serverInfo: {} }]);
    vi.spyOn(manager, 'listTools').mockReturnValue([]);
    const call = vi.spyOn(manager, 'callTool');
    const login = vi.spyOn(xiaohongshuSession, 'status');
    const agent = createAgent({ ...body, allowedTools: ['mcp__xiaohongshu__search_feeds'] });
    expect(preflightAgent(agent).canTest).toBe(false);
    vi.spyOn(manager, 'servers').mockReturnValue([{ name: 'xiaohongshu', connected: true, toolCount: 1, serverInfo: {} }]);
    vi.spyOn(manager, 'listTools').mockReturnValue([{ server: 'xiaohongshu', name: 'search_feeds', qualifiedName: 'mcp__xiaohongshu__search_feeds' }]);
    vi.spyOn(xiaohongshuSession, 'cachedStatus').mockReturnValue(undefined);
    expect(preflightAgent(agent).checks).toContainEqual(expect.objectContaining({ id: 'xiaohongshu-login', status: 'unknown', blocking: true }));
    expect(call).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled();
  });
  it('honors only fresh cached login confirmation and retains governed publication warning', () => {
    const manager = getMcpManager();
    vi.spyOn(manager, 'servers').mockReturnValue([{ name: 'xiaohongshu', connected: true, toolCount: 1, serverInfo: {} }]);
    vi.spyOn(manager, 'listTools').mockReturnValue([{ server: 'xiaohongshu', name: 'publish_content', qualifiedName: 'mcp__xiaohongshu__publish_content' }]);
    vi.spyOn(xiaohongshuSession, 'cachedStatus').mockReturnValue({ authenticated: true, state: 'logged_in', checkedAt: new Date().toISOString() });
    const result = preflightAgent(createAgent({ ...body, allowedTools: ['mcp__xiaohongshu__publish_content'] }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'mcp__xiaohongshu__publish_content', status: 'requires_approval' }));
  });
  it('invalidates stale cache locally without triggering a login probe', () => {
    const call = vi.fn(); let now = 1000;
    const session = new XiaohongshuSession(call, () => now);
    (session as any).lastStatus = { at: now, status: { authenticated: true, state: 'logged_in', checkedAt: 'fixture' } };
    expect(session.cachedStatus()?.authenticated).toBe(true);
    now += 120001;
    expect(session.cachedStatus()).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });
  it('requires a published Skill and never claims current provider authentication is verified', () => {
    const skill = upsertSkill({ id: 'setup-skill', name: 'Fixture' });
    const version = createSkillVersion({ skillId: skill.id, content: 'fixture', status: 'draft' });
    const agent = createAgent(body);
    expect(preflightAgent(agent, version.id).canTest).toBe(false);
    const result = preflightAgent(agent);
    expect(result.model.health).toBe('unknown');
    expect(result.checks[0].status).toBe('unknown');
  });
});
