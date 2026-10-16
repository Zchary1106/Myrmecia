import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/db/database.js';
import { ExecutionMiddlewareChain } from '../src/agents/execution-middleware.js';
import { getRuntimeLimits } from '../src/agents/runtime-limits.js';
import type { AgentDefinition, Task } from '../src/types.js';
import { listLedgerEntries } from '../src/db/models/execution-ledger.js';
import { writeDesignFixtures, uiDesign } from './fixtures/development-design.js';
import { UI_DESIGN_PATH } from '../src/agents/development-workflow.js';

const agent = {
  id: 'developer',
  name: 'Developer',
  role: 'developer',
  emoji: 'D',
  config: { maxConcurrent: 1, timeout: 300 },
  stats: { tasksCompleted: 0, tasksFailed: 0, avgDurationMs: 0 },
} as AgentDefinition;

const task = {
  id: 'task-middleware',
  title: 'middleware',
  description: '',
  mode: 'direct',
  status: 'running',
  priority: 'normal',
  input: 'test',
  workspaceId: 'default',
  retryCount: 0,
  maxRetries: 2,
  dependsOn: [],
  createdAt: '',
} as Task;

describe('execution middleware chain', () => {
  it('rejects empty write arguments before IO and allows a corrected input without degrading the tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-write-arguments-'));
    const chain = new ExecutionMiddlewareChain(agent, task, 'exec-arguments', getRuntimeLimits());
    expect(chain.beforeToolCall('file_write', {}, root)).toMatchObject({
      allowed: false, reason: expect.stringContaining('TOOL_INPUT_INVALID'),
    });
    expect(chain.beforeToolCall('file_write', { path: 'new.txt', content: 'valid' }, root).allowed).toBe(true);
    const refusal = listLedgerEntries({ executionId: 'exec-arguments' }).find(e => e.type === 'middleware.tool_input_invalid');
    expect(refusal?.metadata.executed).toBe(false);
  });
  it('applies read-before-write to a legacy file_path alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-write-alias-'));
    writeFileSync(join(root, 'note.txt'), 'original');
    const chain = new ExecutionMiddlewareChain(agent, task, 'exec-alias', getRuntimeLimits());
    expect(chain.beforeToolCall('file_write', { file_path: 'note.txt', content: 'after' }, root).reason).toContain('READ_BEFORE_WRITE');
    chain.afterToolCall('file_read', { file_path: 'note.txt' }, 'done', 'original', root, 1);
    expect(chain.beforeToolCall('file_write', { file_path: 'note.txt', content: 'after' }, root).allowed).toBe(true);
  });
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-middleware-')), 'test.db');
    getDb().run(`
      INSERT INTO tasks (id, title, description, mode, status, priority, input, workspace_id, depends_on)
      VALUES (?, ?, '', 'direct', 'running', 'normal', 'test', 'default', '[]')
    `, task.id, task.title);
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('records the development profile and blocks incomplete delivery without claiming visual acceptance', () => {
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-delivery-gate-'));
    const chain = new ExecutionMiddlewareChain(agent, { ...task, input: 'Build a complete system' }, 'exec-design', getRuntimeLimits());
    chain.beforeExecution('native-sdk-fixture');
    expect(() => chain.validateDevelopmentDelivery(root, 'Partial result')).toThrow('DEVELOPMENT_DELIVERY_INCOMPLETE');
    writeDesignFixtures(root, task.id, false);
    expect(() => chain.validateDevelopmentDelivery(root)).toThrow('src/app.ts');
    writeDesignFixtures(root, task.id);
    expect(() => chain.validateDevelopmentDelivery(root)).not.toThrow();
    const entries = listLedgerEntries({ executionId: 'exec-design' });
    expect(entries.find(entry => entry.type === 'middleware.started')?.metadata)
      .toMatchObject({ developmentProfile: { kind: 'system', taskId: task.id } });
    expect(entries.filter(entry => entry.type === 'middleware.development_delivery').at(-1)).toMatchObject({
      decision: 'passed', metadata: {
        evidenceScope: 'design_schema_and_declared_files', uiVisualAcceptance: 'not_verified_by_this_gate',
      },
    });
  });

  it('keeps read-before-write ahead of valid design writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-design-existing-'));
    writeDesignFixtures(root, task.id);
    const chain = new ExecutionMiddlewareChain(agent, { ...task, input: 'Redesign the dashboard' }, 'exec-design-read', getRuntimeLimits());
    const input = { path: UI_DESIGN_PATH, content: JSON.stringify(uiDesign(task.id)) };
    expect(chain.beforeToolCall('file_write', input, root).reason).toContain('READ_BEFORE_WRITE');
    chain.afterToolCall('file_read', { path: UI_DESIGN_PATH }, 'done', input.content, root, 1);
    expect(chain.beforeToolCall('file_write', input, root).allowed).toBe(true);
  });

  it('bounds different read offsets and returns model guidance separately from the recorded tool output', () => {
    const chain = new ExecutionMiddlewareChain(agent, task, 'exec-exploration', getRuntimeLimits());
    for (let index = 0; index < 12; index++) {
      const input = { path: 'app.ts', offset: index * 10 };
      expect(chain.beforeToolCall('file_read', input, process.cwd()).allowed).toBe(true);
      chain.afterToolCall('file_read', input, 'done', 'RAW RECEIPT', process.cwd(), 1);
      if (index === 5) expect(chain.modelToolResult('RAW RECEIPT')).toContain('6/12');
    }
    expect(chain.beforeToolCall('grep', { pattern: 'different input' }, process.cwd())).toMatchObject({
      allowed: false, terminal: true, reason: expect.stringContaining('DEVELOPMENT_EXPLORATION_LIMIT'),
    });
    expect(listLedgerEntries({ executionId: 'exec-exploration' })
      .filter(entry => entry.type === 'middleware.tool_observed')
      .every(entry => entry.metadata.outputSummary === 'RAW RECEIPT')).toBe(true);
  });

  it('blocks repeated identical tool calls', () => {
    const chain = new ExecutionMiddlewareChain(agent, task, 'exec-loop', getRuntimeLimits());
    expect(chain.beforeToolCall('web.search', { query: 'same' }, process.cwd()).allowed).toBe(true);
    expect(chain.beforeToolCall('web.search', { query: 'same' }, process.cwd()).allowed).toBe(true);
    expect(chain.beforeToolCall('web.search', { query: 'same' }, process.cwd())).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Loop detector'),
    });
  });

  it('enforces read-before-write for existing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-read-before-write-'));
    writeFileSync(join(root, 'note.md'), 'before');
    const chain = new ExecutionMiddlewareChain(agent, task, 'exec-write', getRuntimeLimits());

    expect(chain.beforeToolCall('file_write', { path: 'note.md', content: 'after' }, root).allowed).toBe(false);
    chain.afterToolCall('file_read', { path: 'note.md' }, 'done', 'before', root, 1);
    expect(chain.beforeToolCall('file_write', { path: 'note.md', content: 'after' }, root).allowed).toBe(true);
  });

  it('degrades a repeatedly failing tool', () => {
    const chain = new ExecutionMiddlewareChain(agent, task, 'exec-failure', getRuntimeLimits());
    chain.afterToolCall('web.fetch', { url: 'https://example.invalid' }, 'failed', 'no', process.cwd(), 1);
    chain.afterToolCall('web.fetch', { url: 'https://example.invalid/2' }, 'failed', 'no', process.cwd(), 1);
    expect(chain.beforeToolCall('web.fetch', { url: 'https://example.invalid/3' }, process.cwd()).allowed).toBe(false);
  });

  it('bounds unread write refusals even when the model changes the patch payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-refusal-'));
    writeFileSync(join(root, 'note.md'), 'before');
    const chain = new ExecutionMiddlewareChain(agent, task, 'exec-refusal', getRuntimeLimits());
    for (let index = 0; index < 2; index++) {
      const decision = chain.beforeToolCall('apply_patch', { path: 'note.md', old_str: 'before', new_str: `v${index}` }, root);
      expect(decision).toMatchObject({ allowed: false, terminal: false });
      expect(decision.reason).toContain('file_read');
    }
    expect(chain.beforeToolCall('apply_patch', { path: 'note.md', old_str: 'before', new_str: 'v3' }, root))
      .toMatchObject({ allowed: false, terminal: true });
  });

  it('recovers only after a successful fresh read, not a failed read or prior execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-refusal-read-'));
    writeFileSync(join(root, 'note.md'), 'before');
    const chain = new ExecutionMiddlewareChain(agent, task, 'exec-refusal-read', getRuntimeLimits());
    chain.beforeToolCall('apply_patch', { path: 'note.md', old_str: 'before', new_str: 'after' }, root);
    chain.afterToolCall('file_read', { path: 'note.md' }, 'failed', 'denied', root, 1);
    expect(chain.beforeToolCall('apply_patch', { path: 'note.md', old_str: 'before', new_str: 'other' }, root).allowed).toBe(false);
    chain.afterToolCall('file_read', { path: 'note.md' }, 'done', 'before', root, 1);
    expect(chain.beforeToolCall('apply_patch', { path: 'note.md', old_str: 'before', new_str: 'after read' }, root).allowed).toBe(true);
    const next = new ExecutionMiddlewareChain(agent, task, 'exec-next', getRuntimeLimits());
    expect(next.beforeToolCall('apply_patch', { path: 'note.md', old_str: 'before', new_str: 'after read' }, root).allowed).toBe(false);
  });
});
