/**
 * Graph Workflow Engine — visual, manually-orchestrated agent graphs.
 *
 * Users drag agents onto a canvas and connect them; this engine runs the
 * resulting DAG: it dispatches a node once all its predecessors finish, feeds
 * upstream outputs into the node's prompt, and emits `graph:*` events for the
 * live UI. Runs are journaled (`graph_run_events`) and resumable/replayable.
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database.js';
import { eventBus } from '../events/event-bus.js';
import { logger } from '../lib/logger.js';
import { getAgent } from '../db/models/agent.js';
import type { TaskQueue } from '../queue/task-queue.js';
import type { AgentManager } from './agent-manager.js';

// ---------- Types ----------

export interface GraphNode {
  id: string;
  label?: string;
  agentId?: string;
  agentRole?: string;
  prompt?: string;            // may contain {input}
  position?: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface GraphDef {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type GraphStatus = 'draft' | 'running' | 'done' | 'failed' | 'cancelled';
export type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface NodeState {
  status: NodeStatus;
  taskId?: string;
  agentId?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RunState {
  runId: string;
  input: string;
  nodes: Record<string, NodeState>;
  startedAt: string;
}

export interface GraphWorkflow {
  id: string;
  name: string;
  description?: string;
  workspaceId?: string;
  graph: GraphDef;
  status: GraphStatus;
  input?: string;
  runState?: RunState;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

// ---------- Schema ----------

export const GRAPH_WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  workspace_id TEXT,
  graph JSON NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  status TEXT NOT NULL DEFAULT 'draft',
  input TEXT,
  run_state JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_graph_wf_workspace ON graph_workflows(workspace_id);

CREATE TABLE IF NOT EXISTS graph_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT,
  type TEXT NOT NULL,
  data JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_graph_run_events_run ON graph_run_events(run_id);
`;

let schemaInitDbs = new WeakSet<object>();
function ensureSchema(): void {
  const db = getDb();
  if (schemaInitDbs.has(db)) return;
  db.exec(GRAPH_WORKFLOW_SCHEMA);
  schemaInitDbs.add(db);
}

// ---------- Model helpers ----------

function rowToWorkflow(row: any): GraphWorkflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    graph: parseJson(row.graph, { nodes: [], edges: [] }),
    status: row.status,
    input: row.input ?? undefined,
    runState: row.run_state ? parseJson(row.run_state, undefined as any) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

export function createGraphWorkflow(data: { name: string; description?: string; workspaceId?: string; graph?: GraphDef; input?: string }): GraphWorkflow {
  ensureSchema();
  const id = `gw_${uuid().slice(0, 12)}`;
  getDb().run(
    `INSERT INTO graph_workflows (id, name, description, workspace_id, graph, status, input)
     VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
    id, data.name, data.description ?? null, data.workspaceId ?? 'default',
    JSON.stringify(data.graph ?? { nodes: [], edges: [] }), data.input ?? null
  );
  return getGraphWorkflow(id)!;
}

export function getGraphWorkflow(id: string): GraphWorkflow | undefined {
  ensureSchema();
  const row = getDb().get('SELECT * FROM graph_workflows WHERE id = ?', id);
  return row ? rowToWorkflow(row) : undefined;
}

export function listGraphWorkflows(filter?: { workspaceId?: string; limit?: number }): GraphWorkflow[] {
  ensureSchema();
  const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 500);
  const rows = filter?.workspaceId
    ? getDb().all('SELECT * FROM graph_workflows WHERE COALESCE(workspace_id, ?) = ? ORDER BY updated_at DESC LIMIT ?', 'default', filter.workspaceId, limit)
    : getDb().all('SELECT * FROM graph_workflows ORDER BY updated_at DESC LIMIT ?', limit);
  return (rows as any[]).map(rowToWorkflow);
}

export function updateGraphWorkflow(id: string, updates: Partial<{ name: string; description: string; graph: GraphDef; status: GraphStatus; input: string; runState: RunState | null; completedAt: string | null }>): GraphWorkflow | undefined {
  ensureSchema();
  const sets: string[] = [];
  const params: any[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.graph !== undefined) { sets.push('graph = ?'); params.push(JSON.stringify(updates.graph)); }
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.input !== undefined) { sets.push('input = ?'); params.push(updates.input); }
  if (updates.runState !== undefined) { sets.push('run_state = ?'); params.push(updates.runState ? JSON.stringify(updates.runState) : null); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt); }
  sets.push("updated_at = CURRENT_TIMESTAMP");
  params.push(id);
  getDb().run(`UPDATE graph_workflows SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getGraphWorkflow(id);
}

export function deleteGraphWorkflow(id: string): boolean {
  ensureSchema();
  const res = getDb().run('DELETE FROM graph_workflows WHERE id = ?', id);
  return res.changes > 0;
}

export function listGraphRunEvents(runId: string): Array<{ nodeId?: string; type: string; data: any; createdAt: string }> {
  ensureSchema();
  const rows = getDb().all('SELECT * FROM graph_run_events WHERE run_id = ? ORDER BY id ASC', runId) as any[];
  return rows.map(r => ({ nodeId: r.node_id ?? undefined, type: r.type, data: parseJson(r.data, {}), createdAt: r.created_at }));
}

function findRunningGraphTaskRef(taskId: string): { workflowId: string; nodeId: string; runId: string } | undefined {
  ensureSchema();
  const rows = getDb().all('SELECT id, run_state FROM graph_workflows WHERE status = ? AND run_state IS NOT NULL', 'running') as any[];
  for (const row of rows) {
    const runState = parseJson<RunState | undefined>(row.run_state, undefined);
    if (!runState?.nodes) continue;
    for (const [nodeId, state] of Object.entries(runState.nodes)) {
      if (state.taskId === taskId) return { workflowId: row.id, nodeId, runId: runState.runId };
    }
  }
  return undefined;
}

// ---------- Engine ----------

export class GraphWorkflowEngine {
  private taskToNode = new Map<string, { workflowId: string; nodeId: string; runId: string }>();
  private readonly onTaskDoneHandler = (e: any) => this.onTaskDone(e.payload);
  private readonly onTaskFailedHandler = (e: any) => this.onTaskFailed(e.payload);

  constructor(private taskQueue: TaskQueue, private agentManager: AgentManager) {
    ensureSchema();
    eventBus.on('task:done', this.onTaskDoneHandler);
    eventBus.on('task:failed', this.onTaskFailedHandler);
  }

  dispose(): void {
    eventBus.off('task:done', this.onTaskDoneHandler);
    eventBus.off('task:failed', this.onTaskFailedHandler);
  }

  /** Start (or restart) a run of the workflow graph. */
  async run(workflowId: string, input?: string): Promise<GraphWorkflow> {
    const wf = getGraphWorkflow(workflowId);
    if (!wf) throw new Error('workflow not found');
    if (wf.graph.nodes.length === 0) throw new Error('graph has no nodes');

    const runId = `run_${uuid().slice(0, 12)}`;
    const nodes: Record<string, NodeState> = {};
    for (const n of wf.graph.nodes) nodes[n.id] = { status: 'pending' };
    const runState: RunState = { runId, input: input ?? wf.input ?? '', nodes, startedAt: new Date().toISOString() };

    updateGraphWorkflow(workflowId, { status: 'running', runState, completedAt: null });
    this.journal(workflowId, runId, undefined, 'run_started', { input: runState.input });
    eventBus.emit('graph:run_started', { workflowId, runId, workspaceId: wf.workspaceId });

    const roots = wf.graph.nodes.filter(n => this.predecessors(wf.graph, n.id).length === 0);
    if (roots.length === 0) {
      // No roots → cyclic or malformed; fail fast.
      this.finishRun(workflowId, 'failed');
      throw new Error('graph has no root nodes (possible cycle)');
    }
    for (const node of roots) await this.dispatchNode(getGraphWorkflow(workflowId)!, node);
    return getGraphWorkflow(workflowId)!;
  }

  /** Re-run the graph from scratch (fresh run id). */
  async replay(workflowId: string, input?: string): Promise<GraphWorkflow> {
    return this.run(workflowId, input);
  }

  /** Resume an interrupted run (e.g. after a restart): re-dispatch lost/pending-ready nodes. */
  async resume(workflowId: string): Promise<GraphWorkflow> {
    const wf = getGraphWorkflow(workflowId);
    if (!wf || !wf.runState) throw new Error('no run to resume');
    if (wf.status !== 'running') return wf;

    const rs = wf.runState;
    // Re-dispatch nodes marked running (their task may be gone) and any ready pending nodes.
    for (const node of wf.graph.nodes) {
      const st = rs.nodes[node.id];
      if (st.status === 'running') await this.dispatchNode(wf, node);
    }
    await this.dispatchReady(getGraphWorkflow(workflowId)!);
    this.checkComplete(workflowId);
    return getGraphWorkflow(workflowId)!;
  }

  cancel(workflowId: string): GraphWorkflow | undefined {
    const wf = getGraphWorkflow(workflowId);
    if (!wf) return undefined;
    for (const [taskId, ref] of this.taskToNode) {
      if (ref.workflowId === workflowId) this.taskToNode.delete(taskId);
    }
    const updated = updateGraphWorkflow(workflowId, { status: 'cancelled', completedAt: new Date().toISOString() });
    if (wf.runState) this.journal(workflowId, wf.runState.runId, undefined, 'run_cancelled', {});
    eventBus.emit('graph:run_cancelled', { workflowId, workspaceId: wf.workspaceId });
    return updated;
  }

  // ---- internals ----

  private predecessors(graph: GraphDef, nodeId: string): string[] {
    return graph.edges.filter(e => e.target === nodeId).map(e => e.source);
  }

  private successors(graph: GraphDef, nodeId: string): string[] {
    return graph.edges.filter(e => e.source === nodeId).map(e => e.target);
  }

  private async dispatchNode(wf: GraphWorkflow, node: GraphNode): Promise<void> {
    const rs = wf.runState!;
    const agent = (node.agentId ? getAgent(node.agentId) : undefined)
      || this.agentManager.findAvailableAgent(node.agentRole || 'developer')
      || this.agentManager.findAvailableAgent('developer');

    if (!agent) {
      rs.nodes[node.id] = { status: 'failed', error: `no agent for role ${node.agentRole || 'developer'}`, completedAt: new Date().toISOString() };
      updateGraphWorkflow(wf.id, { runState: rs });
      this.journal(wf.id, rs.runId, node.id, 'node_failed', { error: 'no agent' });
      eventBus.emit('graph:node_failed', { workflowId: wf.id, runId: rs.runId, nodeId: node.id, workspaceId: wf.workspaceId, error: 'no agent' });
      this.cascadeSkip(wf.id, node.id);
      this.checkComplete(wf.id);
      return;
    }

    const predOutputs = this.predecessors(wf.graph, node.id)
      .map(pid => rs.nodes[pid]?.output)
      .filter((o): o is string => !!o);
    const input = this.assembleInput(node, predOutputs, rs.input);

    const task = await this.taskQueue.enqueue({
      title: `${wf.name} — ${node.label || node.id}`,
      description: input,
      mode: 'direct',
      assigneeId: agent.id,
      input,
      workspaceId: wf.workspaceId,
    });

    rs.nodes[node.id] = { status: 'running', taskId: task.id, agentId: agent.id, startedAt: new Date().toISOString() };
    this.taskToNode.set(task.id, { workflowId: wf.id, nodeId: node.id, runId: rs.runId });
    updateGraphWorkflow(wf.id, { runState: rs });
    this.journal(wf.id, rs.runId, node.id, 'node_started', { taskId: task.id, agentId: agent.id });
    eventBus.emit('graph:node_started', { workflowId: wf.id, runId: rs.runId, nodeId: node.id, taskId: task.id, agentId: agent.id, workspaceId: wf.workspaceId });
  }

  private assembleInput(node: GraphNode, predOutputs: string[], globalInput: string): string {
    const parts: string[] = [];
    if (globalInput) parts.push(`# Goal\n${globalInput}`);
    if (node.prompt) parts.push(node.prompt.replace('{input}', globalInput));
    else if (node.label) parts.push(`## Your role: ${node.label}`);
    if (predOutputs.length) {
      parts.push('## Inputs from upstream agents\n' + predOutputs.map((o, i) => `### Upstream ${i + 1}\n${o}`).join('\n\n'));
    }
    parts.push('Return concise output suitable for downstream agents.');
    return parts.join('\n\n');
  }

  private onTaskDone(payload: any): void {
    const ref = this.resolveTaskNodeRef(payload?.taskId);
    if (!ref) return;
    this.taskToNode.delete(payload.taskId);

    const wf = getGraphWorkflow(ref.workflowId);
    if (!wf || !wf.runState || wf.runState.runId !== ref.runId) return;
    const rs = wf.runState;

    rs.nodes[ref.nodeId] = { ...rs.nodes[ref.nodeId], status: 'done', output: payload.output || '', completedAt: new Date().toISOString() };
    updateGraphWorkflow(wf.id, { runState: rs });
    this.journal(wf.id, rs.runId, ref.nodeId, 'node_done', { taskId: payload.taskId });
    eventBus.emit('graph:node_done', { workflowId: wf.id, runId: rs.runId, nodeId: ref.nodeId, taskId: payload.taskId, workspaceId: wf.workspaceId });

    void this.dispatchReady(getGraphWorkflow(wf.id)!).then(() => this.checkComplete(wf.id));
  }

  private onTaskFailed(payload: any): void {
    const ref = this.resolveTaskNodeRef(payload?.taskId);
    if (!ref) return;
    this.taskToNode.delete(payload.taskId);

    const wf = getGraphWorkflow(ref.workflowId);
    if (!wf || !wf.runState || wf.runState.runId !== ref.runId) return;
    const rs = wf.runState;

    rs.nodes[ref.nodeId] = { ...rs.nodes[ref.nodeId], status: 'failed', error: payload?.error || 'failed', completedAt: new Date().toISOString() };
    updateGraphWorkflow(wf.id, { runState: rs });
    this.journal(wf.id, rs.runId, ref.nodeId, 'node_failed', { error: payload?.error });
    eventBus.emit('graph:node_failed', { workflowId: wf.id, runId: rs.runId, nodeId: ref.nodeId, workspaceId: wf.workspaceId, error: payload?.error });

    this.cascadeSkip(wf.id, ref.nodeId);
    this.checkComplete(wf.id);
  }

  private resolveTaskNodeRef(taskId?: string): { workflowId: string; nodeId: string; runId: string } | undefined {
    if (!taskId) return undefined;
    return this.taskToNode.get(taskId) || findRunningGraphTaskRef(taskId);
  }

  /** Dispatch every pending node whose predecessors are all done. */
  private async dispatchReady(wf: GraphWorkflow): Promise<void> {
    const rs = wf.runState!;
    for (const node of wf.graph.nodes) {
      if (rs.nodes[node.id].status !== 'pending') continue;
      const preds = this.predecessors(wf.graph, node.id);
      const states = preds.map(p => rs.nodes[p]?.status);
      if (states.some(s => s === 'failed' || s === 'skipped')) {
        rs.nodes[node.id] = { status: 'skipped', completedAt: new Date().toISOString() };
        updateGraphWorkflow(wf.id, { runState: rs });
        eventBus.emit('graph:node_skipped', { workflowId: wf.id, runId: rs.runId, nodeId: node.id, workspaceId: wf.workspaceId });
        continue;
      }
      if (states.every(s => s === 'done')) {
        await this.dispatchNode(getGraphWorkflow(wf.id)!, node);
      }
    }
  }

  /** Mark all downstream nodes of a failed node as skipped. */
  private cascadeSkip(workflowId: string, fromNodeId: string): void {
    const wf = getGraphWorkflow(workflowId);
    if (!wf || !wf.runState) return;
    const rs = wf.runState;
    const queue = [...this.successors(wf.graph, fromNodeId)];
    while (queue.length) {
      const id = queue.shift()!;
      if (rs.nodes[id] && rs.nodes[id].status === 'pending') {
        rs.nodes[id] = { status: 'skipped', completedAt: new Date().toISOString() };
        eventBus.emit('graph:node_skipped', { workflowId, runId: rs.runId, nodeId: id, workspaceId: wf.workspaceId });
        queue.push(...this.successors(wf.graph, id));
      }
    }
    updateGraphWorkflow(workflowId, { runState: rs });
  }

  private checkComplete(workflowId: string): void {
    const wf = getGraphWorkflow(workflowId);
    if (!wf || !wf.runState || wf.status !== 'running') return;
    const states = Object.values(wf.runState.nodes).map(n => n.status);
    if (states.some(s => s === 'pending' || s === 'running')) return;
    const status: GraphStatus = states.some(s => s === 'failed') ? 'failed' : 'done';
    this.finishRun(workflowId, status);
  }

  private finishRun(workflowId: string, status: GraphStatus): void {
    const wf = getGraphWorkflow(workflowId);
    updateGraphWorkflow(workflowId, { status, completedAt: new Date().toISOString() });
    if (wf?.runState) this.journal(workflowId, wf.runState.runId, undefined, status === 'done' ? 'run_done' : 'run_failed', {});
    eventBus.emit(status === 'done' ? 'graph:run_done' : 'graph:run_failed', { workflowId, workspaceId: wf?.workspaceId });
    logger.info({ workflowId, status }, 'Graph workflow run finished');
  }

  private journal(workflowId: string, runId: string, nodeId: string | undefined, type: string, data: any): void {
    try {
      getDb().run(
        'INSERT INTO graph_run_events (workflow_id, run_id, node_id, type, data) VALUES (?, ?, ?, ?, ?)',
        workflowId, runId, nodeId ?? null, type, JSON.stringify(data ?? {})
      );
    } catch { /* journaling is best-effort */ }
  }
}
