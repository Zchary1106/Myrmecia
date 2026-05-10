import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution } from '../src/db/models/execution.js';
import { completeRunTrace, completeTraceSpan, createRunTrace, createTraceSpan, getRunTraceByExecution } from '../src/db/models/trace.js';

describe('run trace model', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-trace-')), 'test.db');
    getDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('creates a trace with ordered spans and completion metadata', () => {
    const agent = createAgent({ id: 'trace-agent', name: 'Trace Agent', role: 'developer' });
    const task = createTask({ title: 'Trace task', description: 'Trace task', mode: 'direct', input: 'run', assigneeId: agent.id });
    const execution = createExecution({ taskId: task.id, agentDefId: agent.id });
    const trace = createRunTrace({ taskId: task.id, executionId: execution.id, agentId: agent.id });
    const root = createTraceSpan({ traceId: trace.id, type: 'agent.start', name: 'Agent execution' });
    const child = createTraceSpan({
      traceId: trace.id,
      parentSpanId: root.id,
      type: 'model.route',
      name: 'Select model',
      metadata: { selectedModel: 'openai/claude-sonnet-4.6' },
    });

    completeTraceSpan(child.id, { status: 'done', metadata: { source: 'agent.model' }, durationMs: 3 });
    completeTraceSpan(root.id, { status: 'done', durationMs: 10 });
    completeRunTrace(trace.id, { status: 'done', summary: 'Completed' });

    const loaded = getRunTraceByExecution(execution.id);
    expect(loaded?.status).toBe('done');
    expect(loaded?.spans).toHaveLength(2);
    const modelRouteSpan = loaded?.spans.find(span => span.type === 'model.route');
    expect(modelRouteSpan?.metadata).toMatchObject({
      selectedModel: 'openai/claude-sonnet-4.6',
      source: 'agent.model',
    });
  });
});
