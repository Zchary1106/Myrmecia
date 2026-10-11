import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { createAgent, listAgents, getAgent, updateAgent } from '../db/models/agent.js';
import { getActiveExecutionCount, reconcileTerminalTaskExecutions } from '../db/models/execution.js';
import { agentRuntime } from './agent-runtime.js';
import { domainAgentForRole } from './domain-registry.js';
import { logger } from '../lib/logger.js';
import type { AgentDefinition, Task } from '../types.js';
import { normalizeAgentContract } from '../contracts/team-composer-contracts.js';
import { agentWithPinnedSetup } from './agent-setup-snapshot.js';
import { configuredConcurrency } from '../db/models/agent-config-version.js';
import { getTask } from '../db/models/task.js';
import { getDb } from '../db/database.js';

import { AgentConcurrencyError } from './agent-concurrency.js';
export { AgentConcurrencyError } from './agent-concurrency.js';

export class AgentManager {
  private registryPath: string;
  private admissions = new Map<string, Set<string>>();

  constructor(registryPath: string) {
    this.registryPath = registryPath;
  }

  /** Load agents from registry.yaml into DB if not already present */
  async initializeFromRegistry() {
    try {
      const reconciled = reconcileTerminalTaskExecutions();
      if (reconciled.length > 0) {
        logger.warn(
          { executionIds: reconciled.map(execution => execution.id), count: reconciled.length },
          'Reconciled terminal tasks with stale running executions',
        );
      }
      const content = readFileSync(this.registryPath, 'utf-8');
      const registry = parseYaml(content);

      for (const def of registry.agents || []) {
        const { contract, inferred } = normalizeAgentContract(def);
        const existing = getAgent(def.id);
        const allowedTools = def.allowedTools || def.allowed_tools || [];
        const disallowedTools = def.disallowedTools || def.disallowed_tools || [];
        const modelPolicy = def.model ? {
          tier: def.model.tier,
          preferredModel: def.model.model,
          fallbackModel: def.model.fallbackModel,
          maxTokens: def.model.maxTokens,
          maxResponseTokens: def.model.maxResponseTokens,
          maxToolCalls: def.model.maxToolCalls,
          maxWallClockMs: def.model.maxWallClockMs,
          escalateOn: def.model.escalateOn,
        } : undefined;
        if (!existing) {
          createAgent({
            id: def.id,
            name: def.name,
            role: def.role,
            emoji: def.emoji,
            description: def.description,
            whenToUse: def.description || '',
            skillPath: def.skill,
            capabilities: def.capabilities || [],
            triggers: def.triggers || [],
            allowedTools,
            disallowedTools,
            model: def.model?.model,
            maxTurns: 50,
            config: {
              model: def.model?.model,
              modelPolicy,
              contract,
              maxConcurrent: 1,
              timeout: 300,
              maxTurns: 50,
              allowedTools,
            },
          });
          logger.info({ id: def.id, name: def.name }, 'Registered agent');
        } else {
          updateAgent(def.id, {
            description: def.description,
            whenToUse: def.description || existing.whenToUse,
            skillPath: def.skill,
            capabilities: def.capabilities || existing.capabilities,
            triggers: def.triggers || existing.triggers,
            allowedTools,
            disallowedTools,
            model: def.model?.model || existing.model,
            config: {
              ...existing.config,
              model: def.model?.model || existing.config.model,
              modelPolicy: modelPolicy || existing.config.modelPolicy,
              contract,
              allowedTools,
            },
          });
        }
        if (inferred) {
          logger.debug({ agentId: def.id }, 'Agent Contract inferred from legacy registry fields');
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to load agent registry');
    }
  }

  /** Assign and execute a task on a specific agent */
  async executeTask(agentId: string, task: Task): Promise<string> {
    let agent = getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    agent = agentWithPinnedSetup(task.id, agent);

    // Check concurrency
    const active = this.capacityUse(agentId);
    const max = agent.config.maxConcurrent || 1;
    if (active >= max) throw new AgentConcurrencyError(agentId, max);
    const pending = this.admissions.get(agentId) || new Set<string>();
    pending.add(task.id); this.admissions.set(agentId, pending);
    try {
      const result = await agentRuntime.execute(agent, task);
      return result.output;
    } finally { pending.delete(task.id); if (!pending.size) this.admissions.delete(agentId); }
  }

  private capacityUse(agentId: string): number {
    const admissions = this.admissions.get(agentId);
    if (!admissions?.size) return getActiveExecutionCount(agentId);
    const running = getDb().all<{ task_id: string }>("SELECT task_id FROM task_executions WHERE agent_def_id = ? AND status = 'running'", agentId);
    return new Set([...admissions, ...running.map(row => row.task_id)]).size;
  }

  /** Whether an Agent can accept another execution without exceeding its limit. */
  hasCapacity(agentId: string, taskId?: string): boolean {
    const agent = getAgent(agentId);
    if (!agent) return false;
    const task = taskId ? getTask(taskId) : undefined;
    const max = task ? agentWithPinnedSetup(task.id, agent).config.maxConcurrent || 1
      : configuredConcurrency(agent, getDb().get<{ workspace_id: string }>('SELECT workspace_id FROM agents WHERE id = ?', agentId)?.workspace_id || 'default');
    return this.capacityUse(agentId) < max;
  }

  /** Find an available agent for a role (with capacity). When a domainId is given,
   *  prefer an available agent bound to that domain. */
  findAvailableAgent(role: string, domainId?: string): AgentDefinition | undefined {
    let agents = listAgents({ role });
    if (agents.length === 0) {
      // Templates/workflows often reference an agent by its id (e.g. "pm",
      // "dev", "qa") rather than its role ("product-manager", "developer",
      // "tester"). Fall back to an id match so those pipelines aren't blocked.
      const byId = getAgent(role);
      if (byId) agents = [byId];
    }
    let available = agents.filter(a => {
      const active = this.capacityUse(a.id);
      const workspaceId = getDb().get<{ workspace_id: string }>('SELECT workspace_id FROM agents WHERE id = ?', a.id)?.workspace_id || 'default';
      return active < configuredConcurrency(a, workspaceId);
    });

    if (available.length === 0) return undefined;

    // Domain routing: if this work belongs to a domain, prefer the domain's
    // bound agents (when any are available for this role).
    if (domainId) {
      const preferredId = domainAgentForRole(domainId, role);
      const domainScoped = preferredId ? available.filter(a => a.id === preferredId) : [];
      if (domainScoped.length) available = domainScoped;
    }

    if (available.length === 1) return available[0];

    // Weighted random selection based on route_weight
    const weights = available.map(a => (a as any).routeWeight ?? 1.0);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let rand = Math.random() * totalWeight;

    for (let i = 0; i < available.length; i++) {
      rand -= weights[i];
      if (rand <= 0) return available[i];
    }

    return available[available.length - 1];
  }

  /** Stop a running task on an agent */
  cancelTask(taskId: string) {
    agentRuntime.cancel(taskId);
  }

  /** Get all agents with their current activity */
  getStatusSummary() {
    const agents = listAgents();
    return {
      total: agents.length,
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        emoji: a.emoji,
        activeExecutions: getActiveExecutionCount(a.id),
        maxConcurrent: a.config.maxConcurrent || 1,
      })),
    };
  }
}
