import type {
  ExternalAgent,
  ExternalAgentAdapter,
  ExternalAgentHealth,
  ExternalAgentInvocationContext,
  ExternalAgentRun,
  ExternalAgentTriggerType,
} from '@myrmecia/shared';
import {
  createExternalAgentRun,
  getExternalAgent,
  updateExternalAgent,
  updateExternalAgentRun,
} from '../db/models/external-agent.js';
import { HttpAgentAdapter, LocalCliAgentAdapter } from './external-agent-adapters.js';

export class ExternalAgentRuntime {
  private readonly adapters: ExternalAgentAdapter[];

  constructor(adapters: ExternalAgentAdapter[] = [new LocalCliAgentAdapter(), new HttpAgentAdapter()]) {
    this.adapters = adapters;
  }

  private adapterFor(agent: ExternalAgent): ExternalAgentAdapter {
    const adapter = this.adapters.find(candidate => candidate.kind === agent.adapter.kind);
    if (!adapter) throw new Error(`No adapter is registered for "${agent.adapter.kind}".`);
    return adapter;
  }

  async validate(agent: ExternalAgent): Promise<void> {
    await this.adapterFor(agent).validate(agent);
  }

  async healthCheck(agent: ExternalAgent): Promise<ExternalAgentHealth> {
    const health = await this.adapterFor(agent).healthCheck(agent);
    updateExternalAgent(agent.id, agent.workspaceId || 'default', {
      status: health.status === 'healthy' ? 'active' : 'degraded',
      lastHealthCheckAt: health.checkedAt,
      lastHealthStatus: health.status,
    });
    return health;
  }

  async run(
    externalAgentId: string,
    workspaceId: string,
    invocation: ExternalAgentInvocationContext,
    triggerType: ExternalAgentTriggerType = 'manual',
  ): Promise<ExternalAgentRun> {
    const agent = getExternalAgent(externalAgentId, workspaceId);
    if (!agent) throw new Error('External Agent was not found in this workspace.');
    if (agent.status === 'disabled') throw new Error('External Agent is disabled.');
    await this.validate(agent);
    const run = createExternalAgentRun({
      externalAgentId: agent.id,
      workspaceId,
      taskId: invocation.taskId,
      triggerType,
      status: 'running',
      invocation,
      artifactIds: [],
      startedAt: new Date().toISOString(),
    });
    const result = await this.adapterFor(agent).execute(agent, invocation);
    return updateExternalAgentRun(run.id, workspaceId, {
      status: result.status,
      outputSummary: result.outputSummary,
      error: result.error,
      artifactIds: result.artifactIds || [],
      completedAt: result.status === 'waiting_for_callback' ? undefined : new Date().toISOString(),
    }) || run;
  }
}

let runtime: ExternalAgentRuntime | undefined;

export function getExternalAgentRuntime(): ExternalAgentRuntime {
  runtime ||= new ExternalAgentRuntime();
  return runtime;
}
