import { agentRuntime } from './agent-runtime.js';
import { createTask, getTask, updateTask, listTasks, addTaskLog } from '../db/models/task.js';
import { getAgent, listAgents } from '../db/models/agent.js';
import { domainAgentForRole } from './domain-registry.js';
import { eventBus } from '../events/event-bus.js';
import { TaskQueue } from '../queue/task-queue.js';
import { getMemoryService } from '../memory/memory-service.js';
import { logger } from '../lib/logger.js';
import type { Task } from '../types.js';

interface SubTask {
  title: string;
  description: string;
  role: string;
  dependencies?: number[]; // indices of other subtasks
}

const TERMINAL_TASK_STATES = new Set(['done', 'failed', 'cancelled']);

export interface ParentTaskOutcome {
  status: 'done' | 'failed';
  output: string;
  logLevel: 'info' | 'warn';
  message: string;
}

/**
 * Decide a parent task's outcome from its subtasks. Returns `null` while any
 * subtask is still non-terminal (keep waiting). Once every subtask has settled,
 * the parent is `done` only if all subtasks are `done`; any `failed`/`cancelled`
 * subtask settles the parent as `failed` (with the deliverables still
 * consolidated into the output). This mirrors TeamCoordinator.onTaskSettled so
 * both trackers agree, and — crucially — guarantees the parent always settles
 * instead of polling forever when a subtask fails.
 */
export function evaluateParentOutcome(
  subtasks: Pick<Task, 'title' | 'status' | 'output'>[],
): ParentTaskOutcome | null {
  if (subtasks.length === 0) return null;
  if (!subtasks.every(t => TERMINAL_TASK_STATES.has(t.status))) return null;

  const output = subtasks
    .map(t => `## ${t.title}\n${t.output || '(no output)'}`)
    .join('\n\n---\n\n');
  const failed = subtasks.filter(t => t.status === 'failed');
  const cancelled = subtasks.filter(t => t.status === 'cancelled');

  if (failed.length === 0 && cancelled.length === 0) {
    return { status: 'done', output, logLevel: 'info', message: 'All subtasks completed. Task done!' };
  }
  const detail = [
    failed.length ? `${failed.length} failed: ${failed.map(t => t.title).join(', ')}` : '',
    cancelled.length ? `${cancelled.length} cancelled: ${cancelled.map(t => t.title).join(', ')}` : '',
  ].filter(Boolean).join('; ');
  return { status: 'failed', output, logLevel: 'warn', message: `Subtasks settled with issues — ${detail}` };
}

export class MasterAgent {
  private taskQueue: TaskQueue;

  /** Parent task IDs currently being monitored in-process (guards double-arming). */
  private readonly monitors = new Set<string>();

  /** Hard cap on generated subtasks to avoid runaway decompositions. */
  private static readonly MAX_SUBTASKS = 25;
  private readonly pollIntervalMs = 5000;
  /** Wall-clock ceiling for waiting on subtasks before the parent is force-failed. */
  private readonly maxMonitorMs = Number(process.env.MASTER_MONITOR_TIMEOUT_MS) || 30 * 60 * 1000;

  constructor(taskQueue: TaskQueue) {
    this.taskQueue = taskQueue;
  }

  /** Decompose a high-level task into subtasks using Claude.
   *  When `options.allowedRoles` is set (team mode), the breakdown is restricted
   *  to those roles and subtasks are only assigned to agents in that roster. */
  async decompose(parentTask: Task, options?: { allowedRoles?: string[]; teamName?: string }): Promise<Task[]> {
    const masterAgent = listAgents().find(a => a.role === 'orchestrator' || a.id === 'master');
    if (!masterAgent) throw new Error('Master agent not found');

    addTaskLog(parentTask.id, 'info', 'Master Agent analyzing and decomposing task...', 'master');
    eventBus.emit('task:log', { taskId: parentTask.id, agentId: 'master', workspaceId: parentTask.workspaceId, message: 'Decomposing task...' });

    // Recall lessons / past decompositions for similar work to guide the breakdown.
    const memoryBlock = await getMemoryService().buildContextBlock({
      query: parentTask.description || parentTask.title,
      scope: parentTask.workspaceId ? { workspace: parentTask.workspaceId } : undefined,
      types: ['procedural', 'episodic', 'semantic'],
      heading: '## Lessons from similar past work (use these to inform the breakdown)',
      tokenBudget: 800,
    }).catch(() => '');

    const allowedRoles = options?.allowedRoles && options.allowedRoles.length
      ? options.allowedRoles
      : ['pm', 'ui', 'dev', 'qa', 'ops', 'review'];
    const teamLine = options?.teamName
      ? `You are coordinating the "${options.teamName}". Assign every subtask to one of YOUR teammates only.\n`
      : '';

    const prompt = `You are a project manager AI. Analyze the following task and break it down into atomic subtasks.
${teamLine}
For each subtask, provide:
- title: short descriptive title
- description: detailed prompt for the agent who will execute it
- role: one of [${allowedRoles.join(', ')}]
- dependencies: array of subtask indices (0-based) that must complete before this one

Maximize parallelism: only add a dependency when a subtask truly needs another's output.

IMPORTANT: Output ONLY a valid JSON array. No markdown, no explanation.
${memoryBlock ? `\n${memoryBlock}\n` : ''}
Task: ${parentTask.description || parentTask.title}

Example output:
[
  {"title": "Write PRD", "description": "Write a detailed product spec for...", "role": "${allowedRoles[0]}", "dependencies": []},
  {"title": "Implement", "description": "Implement the code based on...", "role": "${allowedRoles[Math.min(1, allowedRoles.length - 1)]}", "dependencies": [0]}
]`;

    const roleFilter = options?.allowedRoles && options.allowedRoles.length
      ? new Set(options.allowedRoles)
      : null;

    try {
      // Run the decomposition on a real (standalone) task row so the execution's
      // foreign key (task_executions.task_id -> tasks.id) is satisfied. It is NOT
      // a child of the parent, so monitorSubtasks() won't wait on it.
      const decomposeTask = createTask({
        title: `Plan: ${parentTask.title}`.slice(0, 80),
        description: prompt,
        mode: 'master',
        input: prompt,
        workspaceId: parentTask.workspaceId,
        workdir: parentTask.workdir,
      });

      const result = await agentRuntime.execute(masterAgent, decomposeTask);

      // Parse subtasks from output
      const jsonMatch = result.output.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('Failed to parse decomposition output: no JSON array found');

      let subtaskDefs: SubTask[];
      try {
        subtaskDefs = JSON.parse(jsonMatch[0]);
      } catch (parseErr: any) {
        throw new Error(`Failed to parse decomposition output: ${parseErr.message}`);
      }
      if (!Array.isArray(subtaskDefs) || subtaskDefs.length === 0) {
        throw new Error('Decomposition produced no subtasks');
      }
      if (subtaskDefs.length > MasterAgent.MAX_SUBTASKS) {
        addTaskLog(parentTask.id, 'warn',
          `Decomposition produced ${subtaskDefs.length} subtasks; capping at ${MasterAgent.MAX_SUBTASKS}`,
          'master');
        subtaskDefs = subtaskDefs.slice(0, MasterAgent.MAX_SUBTASKS);
      }
      addTaskLog(parentTask.id, 'info', `Decomposed into ${subtaskDefs.length} subtasks`, 'master');

      // Create subtasks in DB
      const createdTasks: Task[] = [];
      const taskIdMap: string[] = [];

      for (let i = 0; i < subtaskDefs.length; i++) {
        const def = subtaskDefs[i];
        const depTaskIds = (def.dependencies || [])
          .filter(idx => idx < taskIdMap.length)
          .map(idx => taskIdMap[idx]);

        // Find available agent for this role (restricted to the team roster in team mode).
        // When the parent task carries a domain, prefer the domain's bound agent for the role.
        const def_role = roleFilter && !roleFilter.has(def.role) ? allowedRoles[0] : def.role;
        const domainAgentId = domainAgentForRole(parentTask.domainId, def_role, parentTask.workspaceId);
        const domainAgent = domainAgentId
          ? listAgents().find(a => a.id === domainAgentId && (!roleFilter || roleFilter.has(a.role)))
          : undefined;
        const agent = domainAgent || listAgents().find(a =>
          (!roleFilter || roleFilter.has(a.role)) && (
            a.role === def_role ||
            a.role.includes(def_role) ||
            a.id === def_role
          )
        ) || listAgents().find(a => a.role === def_role || a.id === def_role);

        const task = await this.taskQueue.enqueue({
          title: def.title,
          description: def.description,
          mode: 'master',
          input: def.description,
          assigneeId: agent?.id,
          parentTaskId: parentTask.id,
          dependsOn: depTaskIds,
          workdir: parentTask.workdir,
          workspaceId: parentTask.workspaceId,
          domainId: parentTask.domainId,
        });

        createdTasks.push(task);
        taskIdMap.push(task.id);

        addTaskLog(parentTask.id, 'info',
          `Created subtask: ${def.title} → ${agent?.emoji || '?'} ${agent?.name || def.role}`,
          'master');
      }

      updateTask(parentTask.id, { status: 'running' });
      eventBus.emit('task:log', {
        taskId: parentTask.id,
        agentId: 'master',
        workspaceId: parentTask.workspaceId,
        message: `Created ${createdTasks.length} subtasks`,
      });

      // Start monitoring
      this.monitorSubtasks(parentTask.id);

      return createdTasks;
    } catch (err: any) {
      addTaskLog(parentTask.id, 'error', `Decomposition failed: ${err.message}`, 'master');
      throw err;
    }
  }

  /**
   * Re-arm monitoring for parent tasks that were left running (e.g. after a
   * server restart). A parent task is any running task that has child subtasks.
   * Returns the number of monitors resumed. Safe to call multiple times — the
   * in-process guard prevents double-arming.
   */
  resumeMonitoring(): number {
    let resumed = 0;
    for (const parent of listTasks({ status: 'running' })) {
      if (this.monitors.has(parent.id)) continue;
      const children = listTasks({ parentTaskId: parent.id });
      if (children.length === 0) continue;
      this.monitorSubtasks(parent.id);
      resumed++;
    }
    if (resumed > 0) {
      logger.info({ resumed }, 'MasterAgent resumed monitoring of interrupted parent tasks');
    }
    return resumed;
  }

  /** Monitor subtasks and finalize the parent once every subtask has settled. */
  private monitorSubtasks(parentTaskId: string, startedAt = Date.now()): void {
    if (this.monitors.has(parentTaskId)) return; // already being monitored
    this.monitors.add(parentTaskId);

    const finalize = (
      status: 'done' | 'failed',
      output: string,
      logLevel: 'info' | 'warn' | 'error',
      logMessage: string,
    ) => {
      this.monitors.delete(parentTaskId);
      updateTask(parentTaskId, { status, output, completedAt: new Date().toISOString() });
      addTaskLog(parentTaskId, logLevel, logMessage, 'master');
      const workspaceId = getTask(parentTaskId)?.workspaceId;
      if (status === 'done') {
        eventBus.emit('task:done', { taskId: parentTaskId, agentId: 'master', workspaceId, output });
      } else {
        eventBus.emit('task:failed', { taskId: parentTaskId, agentId: 'master', workspaceId, error: logMessage, output });
      }
    };

    const consolidate = (subtasks: Task[]): string =>
      subtasks.map(t => `## ${t.title}\n${t.output || '(no output)'}`).join('\n\n---\n\n');

    const check = async () => {
      if (!this.monitors.has(parentTaskId)) return; // finalized/cancelled elsewhere

      const parent = getTask(parentTaskId);
      if (!parent) {
        this.monitors.delete(parentTaskId);
        return;
      }
      // If the parent was already settled by another path, stop monitoring.
      if (TERMINAL_TASK_STATES.has(parent.status)) {
        this.monitors.delete(parentTaskId);
        return;
      }

      const subtasks = listTasks({ parentTaskId });
      const outcome = evaluateParentOutcome(subtasks);
      if (outcome) {
        finalize(outcome.status, outcome.output, outcome.logLevel, outcome.message);
        return;
      }

      // Deadline guard: never poll forever if a subtask is wedged in a
      // non-terminal state (e.g. a lost worker after a crash).
      if (Date.now() - startedAt > this.maxMonitorMs) {
        const current = listTasks({ parentTaskId });
        const unsettled = current
          .filter(t => !TERMINAL_TASK_STATES.has(t.status))
          .map(t => `${t.title} (${t.status})`);
        finalize(
          'failed',
          consolidate(current),
          'error',
          `Master monitor timed out after ${Math.round(this.maxMonitorMs / 60000)}m. Unsettled: ${unsettled.join(', ') || 'none'}`,
        );
        return;
      }

      setTimeout(check, this.pollIntervalMs);
    };

    setTimeout(check, 3000);
  }
}
