import { agentRuntime } from './agent-runtime.js';
import { createTask, getTask, updateTask, listTasks, addTaskLog } from '../db/models/task.js';
import { getAgent, listAgents } from '../db/models/agent.js';
import { eventBus } from '../events/event-bus.js';
import { TaskQueue } from '../queue/task-queue.js';
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

  /** Decompose a high-level task into subtasks using Claude */
  async decompose(parentTask: Task): Promise<Task[]> {
    const masterAgent = listAgents().find(a => a.role === 'orchestrator' || a.id === 'master');
    if (!masterAgent) throw new Error('Master agent not found');

    addTaskLog(parentTask.id, 'info', 'Master Agent analyzing and decomposing task...', 'master');
    eventBus.emit('task:log', { taskId: parentTask.id, agentId: 'master', message: 'Decomposing task...' });

    const prompt = `You are a project manager AI. Analyze the following task and break it down into atomic subtasks.

For each subtask, provide:
- title: short descriptive title
- description: detailed prompt for the agent who will execute it
- role: one of [pm, ui, dev, qa, ops, review]
- dependencies: array of subtask indices (0-based) that must complete before this one

IMPORTANT: Output ONLY a valid JSON array. No markdown, no explanation.

Task: ${parentTask.description || parentTask.title}

Example output:
[
  {"title": "Write PRD", "description": "Write a detailed product spec for...", "role": "pm", "dependencies": []},
  {"title": "Design UI", "description": "Design the UI based on the spec...", "role": "ui", "dependencies": [0]},
  {"title": "Implement", "description": "Implement the code based on...", "role": "dev", "dependencies": [1]}
]`;

    try {
      const result = await agentRuntime.execute(masterAgent, {
        ...parentTask,
        input: prompt,
        id: `${parentTask.id}_decompose`,
      } as Task);

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

        // Find available agent for this role
        const agent = listAgents().find(a =>
          a.role === def.role ||
          a.role.includes(def.role) ||
          a.id === def.role
        );

        const task = await this.taskQueue.enqueue({
          title: def.title,
          description: def.description,
          mode: 'master',
          input: def.description,
          assigneeId: agent?.id,
          parentTaskId: parentTask.id,
          dependsOn: depTaskIds,
          workdir: parentTask.workdir,
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
        eventBus.emit('task:done', { taskId: parentTaskId, agentId: 'master', output });
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
