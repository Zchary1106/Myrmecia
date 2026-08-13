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
import type {
  ArtifactContract,
  WorkflowNodeRunStatus,
  WorkflowRunStatus,
  WSEventType,
  WorkflowEdgeContract,
  WorkflowGraphContract,
  WorkflowNodeContract,
} from '../types.js';
import { validateWorkflowGraphContract } from '../contracts/team-composer-contracts.js';
import { validateOutputAgainstSchema } from '../pipelines/stage-output-validator.js';
import {
  assembleArtifactDrivenInput,
  collectNodeInputArtifacts,
  createNodeArtifacts,
  initialWorkflowNodeState,
  transitionWorkflowNode,
  validateRequiredNodeInputs,
  type WorkflowNodeState,
  type WorkflowRunState,
} from './workflow-runtime-state.js';

// ---------- Types ----------

export type GraphNode = WorkflowNodeContract;
export type GraphEdge = WorkflowEdgeContract;
export type GraphDef = WorkflowGraphContract;

export type GraphStatus = WorkflowRunStatus;
export type NodeStatus = WorkflowNodeRunStatus;
export type NodeState = WorkflowNodeState;
export type RunState = WorkflowRunState;

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
  const graph = parseJson<GraphDef>(row.graph, { nodes: [], edges: [] });
  const rawRunState = row.run_state ? parseJson<any>(row.run_state, undefined) : undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    graph,
    status: row.status,
    input: row.input ?? undefined,
    runState: rawRunState ? normalizeRunState(rawRunState, graph) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function normalizeRunState(value: any, graph: GraphDef): RunState {
  const now = new Date().toISOString();
  const nodes: Record<string, NodeState> = {};
  for (const node of graph.nodes) {
    const existing = value?.nodes?.[node.id] || {};
    nodes[node.id] = {
      ...initialWorkflowNodeState(node),
      ...existing,
      attempt: Number(existing.attempt || 0),
      maxAttempts: Number(existing.maxAttempts || node.retryPolicy?.maxAttempts || 1),
    };
  }
  return {
    runId: String(value.runId),
    input: String(value.input || ''),
    nodes,
    artifacts: value.artifacts || {},
    startedAt: value.startedAt || now,
    updatedAt: value.updatedAt || value.startedAt || now,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

export function createGraphWorkflow(data: { name: string; description?: string; workspaceId?: string; graph?: GraphDef; input?: string }): GraphWorkflow {
  ensureSchema();
  const graph = data.graph ?? { schemaVersion: '1.0', nodes: [], edges: [] };
  const validation = validateWorkflowGraphContract(graph, { allowEmpty: true });
  if (!validation.valid) {
    throw new Error(`Invalid workflow graph: ${validation.errors.map(issue => issue.message).join('; ')}`);
  }
  const id = `gw_${uuid().slice(0, 12)}`;
  getDb().run(
    `INSERT INTO graph_workflows (id, name, description, workspace_id, graph, status, input)
     VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
    id, data.name, data.description ?? null, data.workspaceId ?? 'default',
    JSON.stringify(validation.value), data.input ?? null
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
  if (updates.graph !== undefined) {
    const validation = validateWorkflowGraphContract(updates.graph, { allowEmpty: true });
    if (!validation.valid) {
      throw new Error(`Invalid workflow graph: ${validation.errors.map(issue => issue.message).join('; ')}`);
    }
    updates = { ...updates, graph: validation.value };
  }
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
  const rows = getDb().all(
    `SELECT id, run_state FROM graph_workflows
     WHERE status IN ('running', 'waiting') AND run_state IS NOT NULL`
  ) as any[];
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
    const validation = validateWorkflowGraphContract(wf.graph);
    if (!validation.valid) {
      throw new Error(`Invalid workflow graph: ${validation.errors.map(issue => issue.message).join('; ')}`);
    }

    const runId = `run_${uuid().slice(0, 12)}`;
    const nodes: Record<string, NodeState> = {};
    for (const node of wf.graph.nodes) nodes[node.id] = initialWorkflowNodeState(node);
    const now = new Date().toISOString();
    const runState: RunState = {
      runId,
      input: input ?? wf.input ?? '',
      nodes,
      artifacts: {},
      startedAt: now,
      updatedAt: now,
    };

    updateGraphWorkflow(workflowId, { status: 'running', runState, completedAt: null });
    this.journal(workflowId, runId, undefined, 'run_started', { input: runState.input });
    eventBus.emit('graph:run_started', { workflowId, runId, workspaceId: wf.workspaceId });
    await this.dispatchReady(getGraphWorkflow(workflowId)!);
    this.checkComplete(workflowId);
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
    if (!['running', 'waiting'].includes(wf.status)) return wf;

    const rs = wf.runState;
    for (const node of wf.graph.nodes) {
      const st = rs.nodes[node.id];
      if (st.status === 'running') {
        rs.nodes[node.id] = transitionWorkflowNode(st, 'retrying', {
          taskId: undefined,
          error: 'Execution interrupted; resuming node',
        });
        updateGraphWorkflow(wf.id, { status: 'running', runState: this.touch(rs) });
        await this.dispatchNode(getGraphWorkflow(wf.id)!, node);
      }
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
    if (wf.runState) {
      for (const [nodeId, state] of Object.entries(wf.runState.nodes)) {
        if (['pending', 'ready', 'running', 'retrying', 'waiting_approval', 'blocked'].includes(state.status)) {
          wf.runState.nodes[nodeId] = transitionWorkflowNode(state, 'cancelled', {
            completedAt: new Date().toISOString(),
          });
        }
      }
    }
    const updated = updateGraphWorkflow(workflowId, {
      status: 'cancelled',
      runState: wf.runState ? this.touch(wf.runState) : undefined as any,
      completedAt: new Date().toISOString(),
    });
    if (wf.runState) this.journal(workflowId, wf.runState.runId, undefined, 'run_cancelled', {});
    eventBus.emit('graph:run_cancelled', { workflowId, workspaceId: wf.workspaceId });
    return updated;
  }

  async retryNode(workflowId: string, nodeId: string, data?: { actorId?: string; note?: string }): Promise<GraphWorkflow> {
    const wf = getGraphWorkflow(workflowId);
    if (!wf?.runState) throw new Error('workflow run not found');
    const node = wf.graph.nodes.find(candidate => candidate.id === nodeId);
    const state = wf.runState.nodes[nodeId];
    if (!node || !state) throw new Error('workflow node not found');
    if (!['failed', 'blocked', 'waiting_approval', 'skipped'].includes(state.status)) {
      throw new Error(`node cannot be retried from status ${state.status}`);
    }
    wf.runState.nodes[nodeId] = transitionWorkflowNode(state, 'retrying', {
      taskId: undefined,
      completedAt: undefined,
      error: undefined,
      validationErrors: undefined,
      maxAttempts: Math.max(state.maxAttempts, state.attempt + 1),
      intervention: {
        kind: 'retry',
        requestedAt: state.intervention?.requestedAt || new Date().toISOString(),
        reason: state.error || 'Manual retry requested',
        actorId: data?.actorId,
        decidedAt: new Date().toISOString(),
        decision: 'retried',
        note: data?.note,
      },
    });
    this.resetSkippedDescendants(wf, nodeId);
    updateGraphWorkflow(wf.id, { status: 'running', runState: this.touch(wf.runState), completedAt: null });
    this.journal(wf.id, wf.runState.runId, nodeId, 'node_retry_requested', data || {});
    await this.dispatchNode(getGraphWorkflow(wf.id)!, node);
    return getGraphWorkflow(wf.id)!;
  }

  async approveNode(workflowId: string, nodeId: string, data?: {
    actorId?: string;
    note?: string;
    output?: string;
  }): Promise<GraphWorkflow> {
    const wf = getGraphWorkflow(workflowId);
    if (!wf?.runState) throw new Error('workflow run not found');
    const node = wf.graph.nodes.find(candidate => candidate.id === nodeId);
    const state = wf.runState.nodes[nodeId];
    if (!node || !state) throw new Error('workflow node not found');
    if (!['waiting_approval', 'blocked'].includes(state.status)) {
      throw new Error(`node cannot be approved from status ${state.status}`);
    }
    const approvedAt = new Date().toISOString();
    const output = data?.output || state.output || JSON.stringify({
      approved: true,
      actorId: data?.actorId || 'user',
      note: data?.note || '',
      approvedAt,
    });
    state.intervention = {
      ...(state.intervention || {
        kind: 'approval',
        requestedAt: approvedAt,
        reason: 'Manual approval required',
      }),
      actorId: data?.actorId,
      decidedAt: approvedAt,
      decision: 'approved',
      note: data?.note,
    };
    await this.finalizeNodeSuccess(wf, node, output, 'node_approved');
    return getGraphWorkflow(wf.id)!;
  }

  rejectNode(workflowId: string, nodeId: string, data?: { actorId?: string; note?: string }): GraphWorkflow {
    const wf = getGraphWorkflow(workflowId);
    if (!wf?.runState) throw new Error('workflow run not found');
    const state = wf.runState.nodes[nodeId];
    if (!state) throw new Error('workflow node not found');
    if (!['waiting_approval', 'blocked'].includes(state.status)) {
      throw new Error(`node cannot be rejected from status ${state.status}`);
    }
    const decidedAt = new Date().toISOString();
    wf.runState.nodes[nodeId] = transitionWorkflowNode(state, 'failed', {
      error: data?.note || 'Rejected by human reviewer',
      completedAt: decidedAt,
      intervention: {
        ...(state.intervention || {
          kind: 'approval',
          requestedAt: decidedAt,
          reason: 'Manual approval required',
        }),
        actorId: data?.actorId,
        decidedAt,
        decision: 'rejected',
        note: data?.note,
      },
    });
    updateGraphWorkflow(wf.id, { status: 'running', runState: this.touch(wf.runState) });
    this.journal(wf.id, wf.runState.runId, nodeId, 'node_rejected', data || {});
    this.cascadeSkip(wf.id, nodeId);
    this.checkComplete(wf.id);
    return getGraphWorkflow(wf.id)!;
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
    const current = rs.nodes[node.id];
    if (!current || !['ready', 'retrying'].includes(current.status)) return;

    if (node.kind === 'human-approval') {
      rs.nodes[node.id] = transitionWorkflowNode(current, 'waiting_approval', {
        intervention: {
          kind: 'approval',
          requestedAt: new Date().toISOString(),
          reason: node.label || 'Human approval required',
        },
      });
      updateGraphWorkflow(wf.id, { status: 'waiting', runState: this.touch(rs) });
      this.journal(wf.id, rs.runId, node.id, 'node_waiting_approval', {});
      eventBus.emit('graph:node_waiting_approval', {
        workflowId: wf.id,
        runId: rs.runId,
        nodeId: node.id,
        workspaceId: wf.workspaceId,
      });
      return;
    }

    if (node.kind === 'gate' && !node.agentId && !node.agentRole) {
      await this.runAutomaticGate(wf, node);
      return;
    }

    const inputs = collectNodeInputArtifacts(wf.graph, rs, node.id);
    const inputErrors = validateRequiredNodeInputs(node, inputs);
    rs.nodes[node.id] = transitionWorkflowNode(current, 'running', {
      attempt: current.attempt + 1,
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      error: undefined,
      validationErrors: undefined,
      intervention: undefined,
    });
    updateGraphWorkflow(wf.id, { status: 'running', runState: this.touch(rs) });
    if (inputErrors.length) {
      this.handleNodeFailure(getGraphWorkflow(wf.id)!, node, inputErrors.join('; '), inputErrors);
      return;
    }

    const defaultRole = node.kind === 'gate'
      ? 'reviewer'
      : node.kind === 'publisher'
        ? 'social-publisher'
        : 'developer';
    const agent = (node.agentId ? getAgent(node.agentId) : undefined)
      || this.agentManager.findAvailableAgent(node.agentRole || defaultRole)
      || this.agentManager.findAvailableAgent(defaultRole);

    if (!agent) {
      this.handleNodeFailure(
        getGraphWorkflow(wf.id)!,
        node,
        `no agent for role ${node.agentRole || defaultRole}`,
      );
      return;
    }

    const input = assembleArtifactDrivenInput(node, inputs, rs.input);

    const task = await this.taskQueue.enqueue({
      title: `${wf.name} — ${node.label || node.id}`,
      description: input,
      mode: 'direct',
      assigneeId: agent.id,
      input,
      workspaceId: wf.workspaceId,
    });

    rs.nodes[node.id] = {
      ...rs.nodes[node.id],
      status: 'running',
      taskId: task.id,
      agentId: agent.id,
    };
    this.taskToNode.set(task.id, { workflowId: wf.id, nodeId: node.id, runId: rs.runId });
    updateGraphWorkflow(wf.id, { runState: this.touch(rs) });
    this.journal(wf.id, rs.runId, node.id, 'node_started', {
      taskId: task.id,
      agentId: agent.id,
      attempt: rs.nodes[node.id].attempt,
      inputArtifactIds: inputs.map(inputArtifact => inputArtifact.artifact.id),
    });
    eventBus.emit('graph:node_started', { workflowId: wf.id, runId: rs.runId, nodeId: node.id, taskId: task.id, agentId: agent.id, workspaceId: wf.workspaceId });
  }

  private onTaskDone(payload: any): void {
    const ref = this.resolveTaskNodeRef(payload?.taskId);
    if (!ref) return;
    this.taskToNode.delete(payload.taskId);

    const wf = getGraphWorkflow(ref.workflowId);
    if (!wf || !wf.runState || wf.runState.runId !== ref.runId) return;
    const node = wf.graph.nodes.find(candidate => candidate.id === ref.nodeId);
    if (!node || wf.runState.nodes[ref.nodeId]?.status !== 'running') return;
    const output = payload.output || '';
    const validation = validateOutputAgainstSchema(output, node.qualityGate?.outputSchema);
    if (!validation.valid) {
      this.handleNodeFailure(wf, node, 'Output failed quality gate', validation.errors, output);
      return;
    }
    if (node.qualityGate?.approvalRequired) {
      this.stageNodeForApproval(wf, node, output, payload.taskId);
      return;
    }
    void this.finalizeNodeSuccess(wf, node, output, 'node_done', payload.taskId);
  }

  private onTaskFailed(payload: any): void {
    const ref = this.resolveTaskNodeRef(payload?.taskId);
    if (!ref) return;
    this.taskToNode.delete(payload.taskId);

    const wf = getGraphWorkflow(ref.workflowId);
    if (!wf || !wf.runState || wf.runState.runId !== ref.runId) return;
    const node = wf.graph.nodes.find(candidate => candidate.id === ref.nodeId);
    if (!node || wf.runState.nodes[ref.nodeId]?.status !== 'running') return;
    this.handleNodeFailure(wf, node, payload?.error || 'failed');
  }

  private resolveTaskNodeRef(taskId?: string): { workflowId: string; nodeId: string; runId: string } | undefined {
    if (!taskId) return undefined;
    return this.taskToNode.get(taskId) || findRunningGraphTaskRef(taskId);
  }

  /** Dispatch every pending node whose predecessors are all done. */
  private async dispatchReady(wf: GraphWorkflow): Promise<void> {
    for (const node of wf.graph.nodes) {
      const latest = getGraphWorkflow(wf.id);
      if (!latest?.runState) return;
      const rs = latest.runState;
      if (rs.nodes[node.id].status !== 'pending') continue;
      const preds = this.predecessors(latest.graph, node.id);
      const states = preds.map(p => rs.nodes[p]?.status);
      if (states.some(s => s === 'failed' || s === 'skipped' || s === 'cancelled')) {
        rs.nodes[node.id] = transitionWorkflowNode(rs.nodes[node.id], 'skipped', {
          completedAt: new Date().toISOString(),
        });
        updateGraphWorkflow(latest.id, { runState: this.touch(rs) });
        this.journal(latest.id, rs.runId, node.id, 'node_skipped', { reason: 'upstream_failed' });
        eventBus.emit('graph:node_skipped', { workflowId: latest.id, runId: rs.runId, nodeId: node.id, workspaceId: latest.workspaceId });
        continue;
      }
      if (states.every(s => s === 'done')) {
        rs.nodes[node.id] = transitionWorkflowNode(rs.nodes[node.id], 'ready');
        updateGraphWorkflow(latest.id, { runState: this.touch(rs) });
        this.journal(latest.id, rs.runId, node.id, 'node_ready', {});
        await this.dispatchNode(getGraphWorkflow(latest.id)!, node);
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
      if (rs.nodes[id] && ['pending', 'ready'].includes(rs.nodes[id].status)) {
        rs.nodes[id] = transitionWorkflowNode(rs.nodes[id], 'skipped', {
          completedAt: new Date().toISOString(),
        });
        eventBus.emit('graph:node_skipped', { workflowId, runId: rs.runId, nodeId: id, workspaceId: wf.workspaceId });
        queue.push(...this.successors(wf.graph, id));
      }
    }
    updateGraphWorkflow(workflowId, { runState: this.touch(rs) });
  }

  private checkComplete(workflowId: string): void {
    const wf = getGraphWorkflow(workflowId);
    if (!wf || !wf.runState || !['running', 'waiting'].includes(wf.status)) return;
    const states = Object.values(wf.runState.nodes).map(n => n.status);
    if (states.some(s => ['pending', 'ready', 'running', 'retrying'].includes(s))) {
      if (wf.status !== 'running') updateGraphWorkflow(workflowId, { status: 'running' });
      return;
    }
    if (states.some(s => s === 'waiting_approval' || s === 'blocked')) {
      if (wf.status !== 'waiting') updateGraphWorkflow(workflowId, { status: 'waiting' });
      return;
    }
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

  private async runAutomaticGate(wf: GraphWorkflow, node: GraphNode): Promise<void> {
    const rs = wf.runState!;
    const current = rs.nodes[node.id];
    const inputs = collectNodeInputArtifacts(wf.graph, rs, node.id);
    const inputErrors = validateRequiredNodeInputs(node, inputs);
    rs.nodes[node.id] = transitionWorkflowNode(current, 'running', {
      attempt: current.attempt + 1,
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      error: undefined,
      validationErrors: undefined,
    });
    updateGraphWorkflow(wf.id, { status: 'running', runState: this.touch(rs) });
    if (inputErrors.length) {
      this.handleNodeFailure(getGraphWorkflow(wf.id)!, node, inputErrors.join('; '), inputErrors);
      return;
    }
    const output = this.artifactBundle(inputs, rs.input);
    const validation = validateOutputAgainstSchema(output, node.qualityGate?.outputSchema);
    if (!validation.valid) {
      this.handleNodeFailure(
        getGraphWorkflow(wf.id)!,
        node,
        'Automatic quality gate failed',
        validation.errors,
        output,
      );
      return;
    }
    if (node.qualityGate?.approvalRequired) {
      this.stageNodeForApproval(getGraphWorkflow(wf.id)!, node, output);
      return;
    }
    await this.finalizeNodeSuccess(getGraphWorkflow(wf.id)!, node, output, 'node_gate_passed');
  }

  private artifactBundle(
    inputs: ReturnType<typeof collectNodeInputArtifacts>,
    fallback: string,
  ): string {
    if (inputs.length === 0) return fallback;
    if (inputs.length === 1) return inputs[0].artifact.inlineContent || '';
    const bundle: Record<string, unknown> = {};
    for (const input of inputs) {
      const content = input.artifact.inlineContent || '';
      try { bundle[input.inputName] = JSON.parse(content); }
      catch { bundle[input.inputName] = content; }
    }
    return JSON.stringify(bundle, null, 2);
  }

  private async finalizeNodeSuccess(
    wf: GraphWorkflow,
    node: GraphNode,
    output: string,
    eventType: 'node_done' | 'node_approved' | 'node_gate_passed',
    taskId?: string,
  ): Promise<void> {
    const rs = wf.runState!;
    const state = rs.nodes[node.id];
    const inputs = collectNodeInputArtifacts(wf.graph, rs, node.id);
    const existingArtifacts = (state.artifactIds || [])
      .map(id => rs.artifacts[id])
      .filter((artifact): artifact is ArtifactContract => Boolean(artifact));
    const artifacts = existingArtifacts.length
      ? existingArtifacts
      : createNodeArtifacts({
          workflowId: wf.id,
          runId: rs.runId,
          node,
          agentId: state.agentId,
          output,
          sourceArtifactIds: inputs.map(input => input.artifact.id),
        });
    for (const artifact of artifacts) {
      artifact.metadata = { ...(artifact.metadata || {}), approvalStatus: 'approved' };
      rs.artifacts[artifact.id] = artifact;
      if (!existingArtifacts.length) this.emitArtifactPublished(wf, node, artifact);
    }
    rs.nodes[node.id] = transitionWorkflowNode(state, 'done', {
      taskId: taskId || state.taskId,
      output,
      artifactIds: artifacts.map(artifact => artifact.id),
      error: undefined,
      validationErrors: undefined,
      completedAt: new Date().toISOString(),
    });
    updateGraphWorkflow(wf.id, { status: 'running', runState: this.touch(rs), completedAt: null });
    this.journal(wf.id, rs.runId, node.id, eventType, {
      taskId: taskId || state.taskId,
      artifactIds: artifacts.map(artifact => artifact.id),
    });
    eventBus.emit(`graph:${eventType}` as WSEventType, {
      workflowId: wf.id,
      runId: rs.runId,
      nodeId: node.id,
      taskId: taskId || state.taskId,
      artifactIds: artifacts.map(artifact => artifact.id),
      workspaceId: wf.workspaceId,
    });
    await this.dispatchReady(getGraphWorkflow(wf.id)!);
    this.checkComplete(wf.id);
  }

  private stageNodeForApproval(
    wf: GraphWorkflow,
    node: GraphNode,
    output: string,
    taskId?: string,
  ): void {
    const rs = wf.runState!;
    const state = rs.nodes[node.id];
    const inputs = collectNodeInputArtifacts(wf.graph, rs, node.id);
    const artifacts = createNodeArtifacts({
      workflowId: wf.id,
      runId: rs.runId,
      node,
      agentId: state.agentId,
      output,
      sourceArtifactIds: inputs.map(input => input.artifact.id),
    });
    for (const artifact of artifacts) {
      artifact.metadata = { ...(artifact.metadata || {}), approvalStatus: 'pending' };
      rs.artifacts[artifact.id] = artifact;
      this.emitArtifactPublished(wf, node, artifact);
    }
    rs.nodes[node.id] = transitionWorkflowNode(state, 'waiting_approval', {
      taskId: taskId || state.taskId,
      output,
      artifactIds: artifacts.map(artifact => artifact.id),
      intervention: {
        kind: 'approval',
        requestedAt: new Date().toISOString(),
        reason: 'Quality gate requires human approval',
      },
    });
    updateGraphWorkflow(wf.id, { status: 'waiting', runState: this.touch(rs) });
    this.journal(wf.id, rs.runId, node.id, 'node_waiting_approval', {
      artifactIds: artifacts.map(artifact => artifact.id),
    });
    eventBus.emit('graph:node_waiting_approval', {
      workflowId: wf.id,
      runId: rs.runId,
      nodeId: node.id,
      artifactIds: artifacts.map(artifact => artifact.id),
      workspaceId: wf.workspaceId,
    });
  }

  private emitArtifactPublished(wf: GraphWorkflow, node: GraphNode, artifact: ArtifactContract): void {
    eventBus.emit('artifact:published', {
      artifact: { ...artifact, inlineContent: undefined },
      artifactId: artifact.id,
      workflowId: wf.id,
      runId: wf.runState?.runId,
      nodeId: node.id,
      workspaceId: wf.workspaceId,
    });
  }

  private handleNodeFailure(
    wf: GraphWorkflow,
    node: GraphNode,
    error: string,
    validationErrors: string[] = [],
    output?: string,
  ): void {
    const rs = wf.runState!;
    const state = rs.nodes[node.id];
    const now = new Date().toISOString();
    if (state.attempt < state.maxAttempts) {
      rs.nodes[node.id] = transitionWorkflowNode(state, 'retrying', {
        taskId: undefined,
        output,
        error,
        validationErrors,
        completedAt: undefined,
      });
      updateGraphWorkflow(wf.id, { status: 'running', runState: this.touch(rs) });
      this.journal(wf.id, rs.runId, node.id, 'node_retrying', {
        error,
        attempt: state.attempt,
        maxAttempts: state.maxAttempts,
      });
      eventBus.emit('graph:node_retrying', {
        workflowId: wf.id,
        runId: rs.runId,
        nodeId: node.id,
        attempt: state.attempt,
        maxAttempts: state.maxAttempts,
        workspaceId: wf.workspaceId,
      });
      const delay = node.retryPolicy?.backoffMs || 0;
      setTimeout(() => {
        const latest = getGraphWorkflow(wf.id);
        const latestNode = latest?.graph.nodes.find(candidate => candidate.id === node.id);
        if (latest?.runState?.nodes[node.id]?.status === 'retrying' && latestNode) {
          void this.dispatchNode(latest, latestNode);
        }
      }, delay);
      return;
    }

    if (node.retryPolicy?.onExhausted === 'human') {
      rs.nodes[node.id] = transitionWorkflowNode(state, 'waiting_approval', {
        output,
        error,
        validationErrors,
        intervention: {
          kind: 'retry',
          requestedAt: now,
          reason: `Retry policy exhausted: ${error}`,
        },
      });
      updateGraphWorkflow(wf.id, { status: 'waiting', runState: this.touch(rs) });
      this.journal(wf.id, rs.runId, node.id, 'node_intervention_required', {
        error,
        validationErrors,
      });
      eventBus.emit('graph:node_waiting_approval', {
        workflowId: wf.id,
        runId: rs.runId,
        nodeId: node.id,
        error,
        workspaceId: wf.workspaceId,
      });
      return;
    }

    rs.nodes[node.id] = transitionWorkflowNode(state, 'failed', {
      output,
      error,
      validationErrors,
      completedAt: now,
    });
    updateGraphWorkflow(wf.id, { status: 'running', runState: this.touch(rs) });
    this.journal(wf.id, rs.runId, node.id, 'node_failed', { error, validationErrors });
    eventBus.emit('graph:node_failed', {
      workflowId: wf.id,
      runId: rs.runId,
      nodeId: node.id,
      workspaceId: wf.workspaceId,
      error,
      validationErrors,
    });
    this.cascadeSkip(wf.id, node.id);
    this.checkComplete(wf.id);
  }

  private resetSkippedDescendants(wf: GraphWorkflow, fromNodeId: string): void {
    const queue = [...this.successors(wf.graph, fromNodeId)];
    while (queue.length) {
      const nodeId = queue.shift()!;
      const state = wf.runState!.nodes[nodeId];
      if (state?.status === 'skipped') {
        wf.runState!.nodes[nodeId] = transitionWorkflowNode(state, 'pending', {
          taskId: undefined,
          output: undefined,
          artifactIds: undefined,
          error: undefined,
          validationErrors: undefined,
          completedAt: undefined,
        });
      }
      queue.push(...this.successors(wf.graph, nodeId));
    }
  }

  private touch(runState: RunState): RunState {
    runState.updatedAt = new Date().toISOString();
    return runState;
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
