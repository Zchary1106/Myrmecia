import { agentRuntime } from './agent-runtime.js';
import { createTask, getTask, updateTask, listTasks, addTaskLog } from '../db/models/task.js';
import { getAgent, listAgents } from '../db/models/agent.js';
import { eventBus } from '../events/event-bus.js';
import { TaskQueue } from '../queue/task-queue.js';
import { getMemoryService } from '../memory/memory-service.js';
import type { Task } from '../types.js';

interface SubTask {
  title: string;
  description: string;
  role: string;
  dependencies?: number[]; // indices of other subtasks
}

export class MasterAgent {
  private taskQueue: TaskQueue;

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
      if (!jsonMatch) throw new Error('Failed to parse decomposition output');

      const subtaskDefs: SubTask[] = JSON.parse(jsonMatch[0]);
      addTaskLog(parentTask.id, 'info', `Decomposed into ${subtaskDefs.length} subtasks`, 'master');

      // Create subtasks in DB
      const createdTasks: Task[] = [];
      const taskIdMap: string[] = [];

      for (let i = 0; i < subtaskDefs.length; i++) {
        const def = subtaskDefs[i];
        const depTaskIds = (def.dependencies || [])
          .filter(idx => idx < taskIdMap.length)
          .map(idx => taskIdMap[idx]);

        // Find available agent for this role (restricted to the team roster in team mode)
        const def_role = roleFilter && !roleFilter.has(def.role) ? allowedRoles[0] : def.role;
        const agent = listAgents().find(a =>
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

  /** Monitor subtasks and consolidate when all done */
  private async monitorSubtasks(parentTaskId: string) {
    const check = async () => {
      const subtasks = listTasks({ parentTaskId });
      const allDone = subtasks.every(t => t.status === 'done');
      const anyFailed = subtasks.some(t => t.status === 'failed');

      if (allDone && subtasks.length > 0) {
        // Consolidate outputs
        const output = subtasks
          .map(t => `## ${t.title}\n${t.output || '(no output)'}`)
          .join('\n\n---\n\n');

        updateTask(parentTaskId, {
          status: 'done',
          output,
          completedAt: new Date().toISOString(),
        });
        addTaskLog(parentTaskId, 'info', 'All subtasks completed. Task done!', 'master');
        eventBus.emit('task:done', { taskId: parentTaskId, agentId: 'master', workspaceId: getTask(parentTaskId)?.workspaceId, output });
        return;
      }

      if (anyFailed) {
        const failedTasks = subtasks.filter(t => t.status === 'failed');
        addTaskLog(parentTaskId, 'warn',
          `${failedTasks.length} subtask(s) failed: ${failedTasks.map(t => t.title).join(', ')}`,
          'master');
      }

      // Keep checking
      setTimeout(check, 5000);
    };

    setTimeout(check, 3000);
  }
}
