import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/db/database.js';
import { ExecutionMiddlewareChain } from '../src/agents/execution-middleware.js';
import { getRuntimeLimits } from '../src/agents/runtime-limits.js';
import type { AgentDefinition, Task } from '../src/types.js';

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
});
