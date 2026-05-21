import { eventBus } from '../events/event-bus.js';
import { createCommLog, updateCommLog, getCommLog, listCommLogs } from '../db/models/agent-comm-log.js';
import { logger } from '../lib/logger.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { TaskQueue } from '../queue/task-queue.js';
import type { CommRequest, CommMessage, CommResponse, CommMessageRecord } from '../types.js';

export class AgentComms {
  private registry: CapabilityRegistry;
  private runtime: AgentRuntime;
  private taskQueue: TaskQueue;

  constructor(registry: CapabilityRegistry, runtime: AgentRuntime, taskQueue: TaskQueue) {
    this.registry = registry;
    this.runtime = runtime;
    this.taskQueue = taskQueue;

    eventBus.on('task:done', (event) => {
      const { taskId } = event.payload as { taskId: string };
      this.onAsyncTaskDone(taskId);
    });
  }

  async request(req: CommRequest): Promise<CommResponse> {
    const provider = this.registry.findProvider(req.capability);
    if (!provider) {
      throw new Error(`No available agent providing capability: ${req.capability}`);
    }

    const log = createCommLog({
      fromAgentId: req.from,
      toAgentId: provider.id,
      capability: req.capability,
      mode: 'sync',
      payloadSummary: JSON.stringify(req.payload).slice(0, 500),
    });

    updateCommLog(log.id, { status: 'running' });
    eventBus.emit('agent:comm:request', { commId: log.id, from: req.from, to: provider.id, capability: req.capability });

    const startTime = Date.now();
    const timeout = req.timeout || 60000;

    try {
      const taskInput = typeof req.payload === 'string' ? req.payload : JSON.stringify(req.payload);

      const resultPromise = this.runtime.execute(provider, {
        id: `comm_task_${log.id}`,
        title: `[Comm] ${req.capability} from ${req.from}`,
        description: taskInput,
        input: taskInput,
        mode: 'direct' as any,
        status: 'running' as any,
        priority: 'normal' as any,
        assigneeId: provider.id,
        createdBy: 'master' as any,
        dependsOn: [],
        retryCount: 0,
        maxRetries: 0,
        createdAt: new Date().toISOString(),
      } as any);

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeout)
      );

      const result = await Promise.race([resultPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      updateCommLog(log.id, {
        status: 'done',
        outputSummary: result.output.slice(0, 500),
        durationMs,
        completedAt: new Date().toISOString(),
      });

      const response: CommResponse = {
        success: true,
        providerId: provider.id,
        output: result.output,
        durationMs,
      };

      eventBus.emit('agent:comm:response', { commId: log.id, response });
      logger.info({ commId: log.id, from: req.from, to: provider.id, capability: req.capability, durationMs }, 'Sync comm completed');

      return response;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const status = err.message === 'Timeout' ? 'timeout' : 'failed';

      updateCommLog(log.id, {
        status,
        outputSummary: err.message,
        durationMs,
        completedAt: new Date().toISOString(),
      });

      logger.warn({ commId: log.id, error: err.message, status }, 'Sync comm failed');

      return {
        success: false,
        providerId: provider.id,
        output: err.message,
        durationMs,
      };
    }
  }

  async send(msg: CommMessage): Promise<string> {
    const provider = this.registry.findProvider(msg.capability);
    if (!provider) {
      throw new Error(`No available agent providing capability: ${msg.capability}`);
    }

    const log = createCommLog({
      fromAgentId: msg.from,
      toAgentId: provider.id,
      capability: msg.capability,
      mode: 'async',
      payloadSummary: JSON.stringify(msg.payload).slice(0, 500),
    });

    const taskInput = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);

    const task = await this.taskQueue.enqueue({
      title: `[Async Comm] ${msg.capability} from ${msg.from}`,
      description: taskInput,
      input: taskInput,
      mode: 'direct',
      assigneeId: provider.id,
    });

    updateCommLog(log.id, { status: 'running', taskId: task.id });

    eventBus.emit('agent:comm:message', { commId: log.id, from: msg.from, to: provider.id, capability: msg.capability, taskId: task.id });
    logger.info({ commId: log.id, taskId: task.id, from: msg.from, to: provider.id }, 'Async comm dispatched');

    return log.id;
  }

  getMessageStatus(messageId: string): CommMessageRecord | undefined {
    return getCommLog(messageId);
  }

  private onAsyncTaskDone(taskId: string): void {
    const logs = listCommLogs({ status: 'running' });
    const log = logs.find(l => l.taskId === taskId);
    if (!log) return;

    updateCommLog(log.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
    });

    eventBus.emit('agent:comm:response', { commId: log.id, taskId });
  }
}
