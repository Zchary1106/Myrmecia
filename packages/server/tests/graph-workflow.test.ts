/**
 * Tests for the visual GraphWorkflowEngine (DAG dispatch, data flow, cascade, journal).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { eventBus } from '../src/events/event-bus.js';
import {
  GraphWorkflowEngine,
  createGraphWorkflow,
  getGraphWorkflow,
  listGraphRunEvents,
  type GraphDef,
} from '../src/agents/graph-workflow.js';

const flush = () => new Promise(r => setImmediate(r));

// Minimal fakes for the queue + agent manager.
const enqueued: Array<{ id: string; input: string; assigneeId?: string }> = [];
let taskSeq = 0;
const fakeQueue: any = {
  enqueue: async (data: any) => {
    const id = `task_${++taskSeq}`;
    enqueued.push({ id, input: data.input, assigneeId: data.assigneeId });
    return { id, ...data, status: 'queued' };
  },
};
const fakeAgentManager: any = {
  findAvailableAgent: (role: string) => ({ id: `agent-${role}`, name: role, role }),
};

let engine: GraphWorkflowEngine;

function freshEnv() {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-graph-')), 'test.db');
  getDb();
  enqueued.length = 0;
  taskSeq = 0;
  engine = new GraphWorkflowEngine(fakeQueue, fakeAgentManager);
}

function completeNode(workflowId: string, nodeId: string, output: string) {
  const wf = getGraphWorkflow(workflowId)!;
  const taskId = wf.runState!.nodes[nodeId].taskId!;
  eventBus.emit('task:done', { taskId, output, workspaceId: wf.workspaceId } as any);
}

function failNode(workflowId: string, nodeId: string, error: string) {
  const wf = getGraphWorkflow(workflowId)!;
  const taskId = wf.runState!.nodes[nodeId].taskId!;
  eventBus.emit('task:failed', { taskId, error, workspaceId: wf.workspaceId } as any);
}

const diamond: GraphDef = {
  nodes: [
    { id: 'A', label: 'Spec', agentRole: 'product-manager' },
    { id: 'B', label: 'Build', agentRole: 'developer' },
    { id: 'C', label: 'Design', agentRole: 'designer' },
    { id: 'D', label: 'Review', agentRole: 'reviewer' },
  ],
  edges: [
    { id: 'e1', source: 'A', target: 'B' },
    { id: 'e2', source: 'A', target: 'C' },
    { id: 'e3', source: 'B', target: 'D' },
    { id: 'e4', source: 'C', target: 'D' },
  ],
};

describe('GraphWorkflowEngine', () => {
  beforeEach(() => { freshEnv(); });
  afterEach(() => { engine.dispose(); closeDb(); delete process.env.DB_PATH; });

  it('runs a diamond DAG, passing upstream outputs downstream', async () => {
    const wf = createGraphWorkflow({ name: 'Feature', graph: diamond, workspaceId: 'ws-1' });
    await engine.run(wf.id, 'build a profile page');

    // Only root A dispatched initially.
    let cur = getGraphWorkflow(wf.id)!;
    expect(cur.status).toBe('running');
    expect(cur.runState!.nodes.A.status).toBe('running');
    expect(cur.runState!.nodes.B.status).toBe('pending');

    completeNode(wf.id, 'A', 'PRD: profile page spec');
    await flush();
    cur = getGraphWorkflow(wf.id)!;
    expect(cur.runState!.nodes.B.status).toBe('running');
    expect(cur.runState!.nodes.C.status).toBe('running');

    completeNode(wf.id, 'B', 'code done');
    await flush();
    completeNode(wf.id, 'C', 'design done');
    await flush();

    cur = getGraphWorkflow(wf.id)!;
    expect(cur.runState!.nodes.D.status).toBe('running');

    // D's prompt should include both upstream outputs + the goal.
    const dInput = enqueued.find(e => e.input.includes('code done') && e.input.includes('design done'));
    expect(dInput).toBeTruthy();
    expect(dInput!.input).toContain('build a profile page');

    completeNode(wf.id, 'D', 'approved');
    await flush();
    cur = getGraphWorkflow(wf.id)!;
    expect(cur.status).toBe('done');
    expect(cur.runState!.nodes.D.output).toBe('approved');

    // Run journal recorded node + run lifecycle events.
    const events = listGraphRunEvents(cur.runState!.runId).map(e => e.type);
    expect(events).toContain('run_started');
    expect(events).toContain('node_done');
    expect(events).toContain('run_done');
  });

  it('cascades skip + fails the run when a node fails', async () => {
    const wf = createGraphWorkflow({
      name: 'Linear',
      graph: {
        nodes: [
          { id: 'A', agentRole: 'developer' },
          { id: 'B', agentRole: 'developer' },
          { id: 'C', agentRole: 'reviewer' },
        ],
        edges: [
          { id: 'e1', source: 'A', target: 'B' },
          { id: 'e2', source: 'B', target: 'C' },
        ],
      },
      workspaceId: 'ws-1',
    });
    await engine.run(wf.id, 'goal');

    failNode(wf.id, 'A', 'boom');
    await flush();

    const cur = getGraphWorkflow(wf.id)!;
    expect(cur.status).toBe('failed');
    expect(cur.runState!.nodes.A.status).toBe('failed');
    expect(cur.runState!.nodes.B.status).toBe('skipped');
    expect(cur.runState!.nodes.C.status).toBe('skipped');
  });

  it('replay starts a fresh run', async () => {
    const wf = createGraphWorkflow({ name: 'R', graph: diamond, workspaceId: 'ws-1' });
    await engine.run(wf.id, 'v1');
    const firstRun = getGraphWorkflow(wf.id)!.runState!.runId;

    const replayed = await engine.replay(wf.id, 'v2');
    expect(replayed.runState!.runId).not.toBe(firstRun);
    expect(replayed.runState!.input).toBe('v2');
    expect(replayed.runState!.nodes.A.status).toBe('running');
  });
});
