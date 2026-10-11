import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSetupForm } from '../src/types.js';
import { closeDb, getDb } from '../src/db/database.js';
import { discardSetupDraft, getSetupDraft, listSetupDrafts, saveSetupDraft } from '../src/db/models/agent-setup-draft.js';
import { setupEntity } from '../src/agents/agent-setup.js';
import { createAgent, updateAgent } from '../src/db/models/agent.js';
import { createTask } from '../src/db/models/task.js';
import { agentWithPinnedSetup } from '../src/agents/agent-setup-snapshot.js';
import { persistExecutionContext, persistInheritedExecutionContext } from '../src/agents/execution-context.js';

const owner = { workspaceId: 'workspace-a', actorId: 'actor-a' };
const form: AgentSetupForm = { name: 'Fixture', role: 'researcher', emoji: '🤖', description: 'Mission',
  whenToUse: 'Routing', systemInstructions: 'Original instructions', capabilities: '', triggers: '',
  allowedTools: ['file_read'], model: 'fixture', skillVersionId: '', testPrompt: '',
  maxTurns: 50, timeout: 300, maxConcurrent: 1, contractEnabled: false,
  owns: [], doesNotOwn: [], escalatesTo: [], definitionOfDone: [], inputs: [], outputs: [] };
const data = { form, step: 0, locked: false, testSubmitted: false, expectedRevision: 0 };
let path: string;
beforeEach(() => { closeDb(); path = join(mkdtempSync(join(tmpdir(), 'agent-draft-')), 'fixture.db'); process.env.DB_PATH = path; getDb(); });
afterEach(() => { closeDb(); delete process.env.DB_PATH; });

describe('recoverable Agent setup', () => {
  it('persists across DB reopening and isolates actors and workspaces', () => {
    const id = randomUUID(), draft = saveSetupDraft(id, owner, data);
    closeDb(); process.env.DB_PATH = path; getDb();
    expect(getSetupDraft(id, owner)).toEqual(draft);
    expect(getSetupDraft(id, { ...owner, actorId: 'other' })).toBeUndefined();
    expect(listSetupDrafts({ ...owner, workspaceId: 'other' })).toEqual([]);
    expect(() => saveSetupDraft(id, { ...owner, actorId: 'other' }, data)).toThrow(/无权/);
    expect(discardSetupDraft(id, { ...owner, actorId: 'other' })).toBe(false);
  });
  it('rejects conflicting tabs but replays an identical response-lost save', () => {
    const id = randomUUID();
    const first = saveSetupDraft(id, owner, data);
    expect(saveSetupDraft(id, owner, data).creationKey).toBe(first.creationKey);
    const next = { ...data, expectedRevision: 1, form: { ...form, name: 'New name' } };
    expect(saveSetupDraft(id, owner, next).revision).toBe(2);
    expect(saveSetupDraft(id, owner, next).revision).toBe(2);
    expect(() => saveSetupDraft(id, owner, { ...next, form })).toThrow(/其他窗口/);
  });
  it('reconciles lost creation/test responses from durable receipts without executing anything', () => {
    const id = randomUUID(), first = saveSetupDraft(id, owner, data);
    saveSetupDraft(id, owner, { ...data, expectedRevision: 1, locked: true });
    const created = setupEntity({ ...owner, operation: 'create', key: first.creationKey, payload: form },
      () => createAgent({ name: form.name, role: form.role, workspaceId: owner.workspaceId }).id);
    const tested = setupEntity({ ...owner, operation: `test:${created.id}`, key: first.testKey, payload: { prompt: 'Test' } },
      () => createTask({ title: 'Test', description: 'Test', input: 'Test', mode: 'direct', workspaceId: owner.workspaceId }).id);
    const restored = getSetupDraft(id, owner)!;
    expect(restored).toMatchObject({ agentId: created.id, taskId: tested.id, bound: true, stage: 'dispatched' });
    expect(discardSetupDraft(id, owner)).toBe(true);
    expect(getDb().get('SELECT id FROM agents WHERE id = ?', created.id)).toBeDefined();
    expect(getDb().get('SELECT id FROM tasks WHERE id = ?', tested.id)).toBeDefined();
  });
  it('locks original configuration but permits a first explicit test after save-only', () => {
    const id = randomUUID();
    saveSetupDraft(id, owner, data);
    saveSetupDraft(id, owner, { ...data, expectedRevision: 1, locked: true });
    expect(() => saveSetupDraft(id, owner, { ...data, expectedRevision: 2 })).toThrow(/锁定/);
    const test = saveSetupDraft(id, owner, { ...data, expectedRevision: 2, locked: true, testSubmitted: true,
      form: { ...form, testPrompt: 'First test' } });
    expect(test.form.testPrompt).toBe('First test');
    expect(() => saveSetupDraft(id, owner, { ...data, expectedRevision: 3, locked: true, testSubmitted: true,
      form: { ...form, testPrompt: 'Different test' } })).toThrow(/锁定/);
  });
  it('pins instructions and limits before dispatch; revoked tools still win', () => {
    const agent = createAgent({ name: 'Pinned', role: 'dev', allowedTools: ['file_read', 'shell_exec'],
      config: { systemInstructions: 'Original', maxTurns: 8 } });
    const task = createTask({ title: 'Test', description: 'Test', mode: 'direct', input: 'Test', assigneeId: agent.id });
    expect(persistExecutionContext(task).agentSetup?.systemInstructions).toBe('Original');
    const updated = updateAgent(agent.id, { allowedTools: ['file_read'], config: { systemInstructions: 'Changed', maxTurns: 100 } })!;
    const pinned = agentWithPinnedSetup(task.id, updated);
    expect(pinned.config.systemInstructions).toBe('Original');
    expect(pinned.maxTurns).toBe(8); expect(pinned.allowedTools).toEqual(['file_read']);
    expect(persistExecutionContext(task).agentSetup?.systemInstructions).toBe('Original');
    const child = createTask({ title: 'Child', description: 'Child', mode: 'direct', input: 'Child',
      assigneeId: agent.id, parentTaskId: task.id });
    expect(persistInheritedExecutionContext(persistExecutionContext(task), child).agentSetup?.systemInstructions).toBe('Changed');
    updateAgent(agent.id, { config: { systemInstructions: 'Changed again' } });
    expect(agentWithPinnedSetup(child.id, updateAgent(agent.id, {})!).config.systemInstructions).toBe('Changed');
  });
});
