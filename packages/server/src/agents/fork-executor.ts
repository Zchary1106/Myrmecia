import { agentRuntime, type TaskResult } from './agent-runtime.js';
import { getAgent } from '../db/models/agent.js';
import { createTask, getTask, updateTask } from '../db/models/task.js';
import { createExecution, getExecution, listExecutionMessages } from '../db/models/execution.js';
import { messageBus } from './message-bus.js';
import { eventBus } from '../events/event-bus.js';
import type { AgentDefinition, Task, TaskExecution } from '../types.js';

/**
 * Fork Executor — two modes of agent spawning (aligned with Claude Code)
 *
 * 1. Fork mode: inherits parent context (like Claude Code's fork subagent)
 *    - Shares conversation history via prompt prefix
 *    - Suitable for "investigate this" type sub-tasks
 *
 * 2. Spawn mode: fresh agent with zero context (like Claude Code's subagent_type)
 *    - Full briefing required in prompt
 *    - Suitable for specialized tasks (review, testing, etc.)
 */

export interface SpawnOptions {
  parentExecutionId?: string;
  workdir?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  mode?: 'direct' | 'master';
  workspaceId?: string;
}

export class ForkExecutor {

  /**
   * Fork: create a sub-execution that inherits parent's conversation context.
   * The parent's execution messages are prepended to the prompt as context.
   */
  async fork(parentExecutionId: string, directive: string, agentDefId?: string): Promise<TaskResult> {
    const parentExec = getExecution(parentExecutionId);
    if (!parentExec) throw new Error(`Parent execution ${parentExecutionId} not found`);

    // Use same agent as parent, or a different one
    const agentId = agentDefId || parentExec.agentDefId;
    const agent = getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Build context from parent's execution messages
    const parentMessages = listExecutionMessages(parentExecutionId, { limit: 50 });
    const contextLines = parentMessages
      .filter(m => m.type === 'agent_text' || m.type === 'user_input')
      .map(m => `[${m.type === 'user_input' ? 'User' : 'Agent'}]: ${m.content}`)
      .join('\n');

    const fullPrompt = contextLines
      ? `[INHERITED CONTEXT FROM PARENT EXECUTION]\n${contextLines}\n\n[NEW DIRECTIVE]\n${directive}`
      : directive;

    // Create a sub-task
    const parentTask = getTask(parentExec.taskId);
    const task = createTask({
      title: directive.slice(0, 80),
      description: directive,
      mode: 'direct',
      input: fullPrompt,
      assigneeId: agentId,
      parentTaskId: parentExec.taskId,
      workdir: parentTask?.workdir,
      workspaceId: parentTask?.workspaceId,
      createdBy: 'master',
    });

    // Execute (creates its own execution instance internally)
    const result = await agentRuntime.execute(agent, task);

    // Notify parent via message bus
    messageBus.send(result.executionId, parentExecutionId, 'progress_update',
      `Fork completed: ${directive.slice(0, 50)} → ${result.output.slice(0, 200)}`);

    return result;
  }

  /**
   * Spawn: create a completely new execution with zero inherited context.
   * The prompt must contain all necessary context (like Claude Code's subagent_type).
   */
  async spawn(agentDefId: string, prompt: string, opts?: SpawnOptions): Promise<TaskResult> {
    const agent = getAgent(agentDefId);
    if (!agent) throw new Error(`Agent ${agentDefId} not found`);

    const task = createTask({
      title: prompt.slice(0, 80),
      description: prompt,
      mode: opts?.mode || 'direct',
      priority: opts?.priority || 'normal',
      input: prompt,
      assigneeId: agentDefId,
      workdir: opts?.workdir,
      workspaceId: opts?.workspaceId,
      createdBy: 'master',
    });

    const result = await agentRuntime.execute(agent, task);

    // If spawned from a parent, notify it
    if (opts?.parentExecutionId) {
      messageBus.send(result.executionId, opts.parentExecutionId, 'progress_update',
        `Spawn completed (${agent.name}): ${result.output.slice(0, 200)}`);
    }

    return result;
  }

  /**
   * Spawn multiple agents in parallel (like Claude Code's parallel agent launches).
   * Returns when all complete.
   */
  async spawnParallel(tasks: Array<{ agentDefId: string; prompt: string; opts?: SpawnOptions }>): Promise<TaskResult[]> {
    const promises = tasks.map(t => this.spawn(t.agentDefId, t.prompt, t.opts));
    return Promise.allSettled(promises).then(results =>
      results
        .filter((r): r is PromiseFulfilledResult<TaskResult> => r.status === 'fulfilled')
        .map(r => r.value)
    );
  }
}

export const forkExecutor = new ForkExecutor();
