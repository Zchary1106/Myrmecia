/**
 * Orchestrator — Unified Task Orchestration Entry Point
 *
 * All tasks flow through the Orchestrator regardless of complexity:
 * - Trivial: direct dispatch to a single agent
 * - Medium+: decompose into sub-tasks with dependency graph, parallel execution
 *
 * Emits real-time events for the dashboard orchestration board.
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database.js';
import { eventBus } from '../events/event-bus.js';
import { MasterAgent } from './master-agent.js';
import { TaskQueue } from '../queue/task-queue.js';
import { PipelineEngine } from '../pipelines/pipeline-engine.js';
import { messageBus } from './message-bus.js';
import { tier1Engine, type Tier1Result } from './tier1-engine.js';
import { listTasks, getTask, updateTask, addTaskLog } from '../db/models/task.js';
import { getActiveExecutionCount } from '../db/models/execution.js';
import type { TaskIntent } from './intent-classifier.js';
import type { Task } from '../types.js';

// ---------- Types ----------

export type OrchestrationStatus = 'planning' | 'dispatching' | 'running' | 'done' | 'failed';

export interface Orchestration {
  id: string;
  input: string;
  intent: TaskIntent;
  status: OrchestrationStatus;
  taskIds: string[];
  result?: string;
  createdAt: string;
  completedAt?: string;
}

export interface OrchestrationResult {
  orchestration: Orchestration;
  tasks: Task[];
  tier1Result?: Tier1Result;
}

// ---------- Schema ----------

export const ORCHESTRATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS orchestrations (
  id TEXT PRIMARY KEY,
  input TEXT NOT NULL,
  intent JSON NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  task_ids JSON NOT NULL DEFAULT '[]',
  result TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_orchestrations_status ON orchestrations(status);
`;

// ---------- DB Helpers ----------

function rowToOrchestration(row: any): Orchestration {
  return {
    id: row.id,
    input: row.input,
    intent: JSON.parse(row.intent),
    status: row.status,
    taskIds: JSON.parse(row.task_ids),
    result: row.result || undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at || undefined,
  };
}

export function getOrchestration(id: string): Orchestration | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM orchestrations WHERE id = ?', id);
  return row ? rowToOrchestration(row) : undefined;
}

export function listOrchestrations(limit = 50, offset = 0): Orchestration[] {
  const db = getDb();
  const rows = db.all(
    'SELECT * FROM orchestrations ORDER BY created_at DESC LIMIT ? OFFSET ?',
    limit, offset
  );
  return rows.map(rowToOrchestration);
}

function updateOrchestration(id: string, updates: Partial<Pick<Orchestration, 'status' | 'taskIds' | 'result' | 'completedAt'>>): void {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.status) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.taskIds) { sets.push('task_ids = ?'); params.push(JSON.stringify(updates.taskIds)); }
  if (updates.result !== undefined) { sets.push('result = ?'); params.push(updates.result); }
  if (updates.completedAt) { sets.push('completed_at = ?'); params.push(updates.completedAt); }

  if (sets.length > 0) {
    params.push(id);
    db.run(`UPDATE orchestrations SET ${sets.join(', ')} WHERE id = ?`, ...params);
  }
}

// ---------- Orchestrator ----------

export class Orchestrator {
  private masterAgent: MasterAgent;
  private taskQueue: TaskQueue;
  private pipelineEngine: PipelineEngine;

  constructor(taskQueue: TaskQueue, pipelineEngine: PipelineEngine) {
    this.taskQueue = taskQueue;
    this.pipelineEngine = pipelineEngine;
    this.masterAgent = new MasterAgent(taskQueue);

    // Listen for task completions to advance orchestrations
    eventBus.on('task:done', (event) => this.onTaskDone(event));
    eventBus.on('task:failed', (event) => this.onTaskFailed(event));
  }

  /**
   * Unified entry: evaluate intent → decide strategy → dispatch
   */
  async plan(input: string, intent: TaskIntent): Promise<OrchestrationResult> {
    const db = getDb();
    const id = `orch_${uuid().slice(0, 8)}`;

    // Tier 1: try rule-based fast processing first (zero LLM cost)
    const tier1 = tier1Engine.process(input);
    if (tier1.handled) {
      db.run(
        'INSERT INTO orchestrations (id, input, intent, status, task_ids, result, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, input, JSON.stringify(intent), 'done', '[]', tier1.output || '', new Date().toISOString()
      );
      eventBus.emit('orchestration:created', { id, input, intent, tier1: true });
      eventBus.emit('orchestration:done', { orchestrationId: id, status: 'done', tier1: true });
      const orchestration = getOrchestration(id)!;
      return { orchestration, tasks: [], tier1Result: tier1 };
    }

    // Create orchestration record
    db.run(
      'INSERT INTO orchestrations (id, input, intent, status) VALUES (?, ?, ?, ?)',
      id, input, JSON.stringify(intent), 'planning'
    );

    eventBus.emit('orchestration:created', { id, input, intent });

    try {
      let tasks: Task[];

      if (intent.complexity === 'trivial') {
        // Direct dispatch — no decomposition needed
        tasks = await this.directDispatch(id, input, intent);
      } else if (intent.suggestedMode === 'pipeline' && intent.suggestedTemplate) {
        // Pipeline mode
        tasks = await this.pipelineDispatch(id, input, intent);
      } else {
        // Complex task — decompose into sub-tasks
        tasks = await this.decomposeAndDispatch(id, input, intent);
      }

      const taskIds = tasks.map(t => t.id);
      updateOrchestration(id, { status: 'running', taskIds });

      const orchestration = getOrchestration(id)!;
      return { orchestration, tasks };
    } catch (err: any) {
      updateOrchestration(id, { status: 'failed', result: err.message, completedAt: new Date().toISOString() });
      eventBus.emit('orchestration:failed', { orchestrationId: id, error: err.message });
      throw err;
    }
  }

  /** Trivial task: dispatch to single agent directly */
  private async directDispatch(orchestrationId: string, input: string, intent: TaskIntent): Promise<Task[]> {
    updateOrchestration(orchestrationId, { status: 'dispatching' });

    const task = await this.taskQueue.enqueue({
      title: input.slice(0, 80),
      description: input,
      mode: 'direct',
      assigneeId: intent.suggestedAgent,
      input,
      priority: 'normal',
    });

    eventBus.emit('orchestration:task_dispatched', {
      orchestrationId,
      taskId: task.id,
      agentId: intent.suggestedAgent,
      role: 'direct',
    });

    return [task];
  }

  /** Pipeline mode: use existing pipeline engine */
  private async pipelineDispatch(orchestrationId: string, input: string, intent: TaskIntent): Promise<Task[]> {
    updateOrchestration(orchestrationId, { status: 'dispatching' });

    const pipeline = await this.pipelineEngine.create({
      name: input.slice(0, 60),
      templateId: intent.suggestedTemplate!,
      input,
      gateMode: 'auto',
    });

    // Pipeline creates its own tasks internally; get them
    const pipelineTasks = listTasks({ pipelineId: pipeline.id });

    for (const t of pipelineTasks) {
      eventBus.emit('orchestration:task_dispatched', {
        orchestrationId,
        taskId: t.id,
        agentId: t.assigneeId,
        role: pipeline.stages[t.stageIndex || 0]?.name || 'stage',
      });
    }

    return pipelineTasks;
  }

  /** Complex task: decompose via MasterAgent then dispatch */
  private async decomposeAndDispatch(orchestrationId: string, input: string, intent: TaskIntent): Promise<Task[]> {
    updateOrchestration(orchestrationId, { status: 'dispatching' });

    // Create parent task
    const parentTask = await this.taskQueue.enqueue({
      title: input.slice(0, 80),
      description: input,
      mode: 'master',
      input,
      priority: intent.complexity === 'epic' ? 'high' : 'normal',
    });

    // Decompose using MasterAgent
    const subtasks = await this.masterAgent.decompose(parentTask);

    for (const t of subtasks) {
      eventBus.emit('orchestration:task_dispatched', {
        orchestrationId,
        taskId: t.id,
        agentId: t.assigneeId,
        role: t.title,
      });
    }

    return [parentTask, ...subtasks];
  }

  /** When a sub-task completes, notify downstream tasks and check orchestration completion */
  private onTaskDone(event: any): void {
    const { taskId, output } = event.payload || event;
    const task = getTask(taskId);
    if (!task) return;

    // Find orchestrations containing this task
    const db = getDb();
    const orchRows = db.all(
      "SELECT * FROM orchestrations WHERE status = 'running' AND task_ids LIKE ?",
      `%${taskId}%`
    ) as any[];

    for (const row of orchRows) {
      const orch = rowToOrchestration(row);

      eventBus.emit('orchestration:task_completed', {
        orchestrationId: orch.id,
        taskId,
        output: (output || '').slice(0, 200),
      });

      // Notify downstream dependent tasks via message bus
      this.notifyDownstream(task, orch);

      // Check if all tasks in this orchestration are done
      this.checkCompletion(orch);
    }
  }

  private onTaskFailed(event: any): void {
    const { taskId, error } = event.payload || event;

    const db = getDb();
    const orchRows = db.all(
      "SELECT * FROM orchestrations WHERE status = 'running' AND task_ids LIKE ?",
      `%${taskId}%`
    ) as any[];

    for (const row of orchRows) {
      const orch = rowToOrchestration(row);
      // Don't fail the whole orchestration immediately — other tasks may still complete
      eventBus.emit('orchestration:task_failed', {
        orchestrationId: orch.id,
        taskId,
        error,
      });
    }
  }

  /** Send output of completed task to downstream dependents */
  private notifyDownstream(completedTask: Task, orch: Orchestration): void {
    // Find tasks that depend on the completed task
    for (const taskId of orch.taskIds) {
      const t = getTask(taskId);
      if (!t || t.status === 'done' || t.status === 'failed') continue;

      const deps = t.dependsOn || [];
      if (deps.includes(completedTask.id)) {
        // Get executions for messaging
        const db = getDb();
        const targetExec = db.get(
          "SELECT id FROM task_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1",
          taskId
        ) as { id: string } | undefined;

        const sourceExec = db.get(
          "SELECT id FROM task_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1",
          completedTask.id
        ) as { id: string } | undefined;

        if (targetExec) {
          messageBus.send(
            sourceExec?.id || null,
            targetExec.id,
            'context_update',
            `Upstream task "${completedTask.title}" completed.\n\nOutput summary:\n${(completedTask.output || '').slice(0, 500)}`
          );

          eventBus.emit('orchestration:agent_message', {
            orchestrationId: orch.id,
            from: completedTask.assigneeId || 'system',
            to: t.assigneeId || taskId,
            content: `Context from "${completedTask.title}" delivered`,
          });
        }
      }
    }
  }

  /** Check if orchestration is complete (all tasks done or failed) */
  private checkCompletion(orch: Orchestration): void {
    const tasks = orch.taskIds.map(id => getTask(id)).filter(Boolean) as Task[];
    if (tasks.length === 0) return;

    const allTerminal = tasks.every(t => t.status === 'done' || t.status === 'failed');
    if (!allTerminal) return;

    const allDone = tasks.every(t => t.status === 'done');
    const result = tasks
      .filter(t => t.output)
      .map(t => `## ${t.title}\n${t.output}`)
      .join('\n\n---\n\n');

    updateOrchestration(orch.id, {
      status: allDone ? 'done' : 'failed',
      result,
      completedAt: new Date().toISOString(),
    });

    eventBus.emit('orchestration:done', {
      orchestrationId: orch.id,
      status: allDone ? 'done' : 'failed',
      result: result.slice(0, 500),
    });
  }
}
