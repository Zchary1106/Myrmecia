import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { createAgent, listAgents, getAgent, updateAgent } from '../db/models/agent.js';
import { getActiveExecutionCount } from '../db/models/execution.js';
import { agentRuntime } from './agent-runtime.js';
import type { AgentDefinition, Task } from '../types.js';

export class AgentManager {
  private registryPath: string;

  constructor(registryPath: string) {
    this.registryPath = registryPath;
  }

  /** Load agents from registry.yaml into DB if not already present */
  async initializeFromRegistry() {
    try {
      const content = readFileSync(this.registryPath, 'utf-8');
      const registry = parseYaml(content);

      for (const def of registry.agents || []) {
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
              maxConcurrent: 1,
              timeout: 300,
              maxTurns: 50,
              allowedTools,
            },
          });
          console.log(`  Registered agent: ${def.emoji} ${def.name}`);
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
              allowedTools,
            },
          });
        }
      }
    } catch (err: any) {
      console.error('Failed to load agent registry:', err.message);
    }
  }

  /** Assign and execute a task on a specific agent */
  async executeTask(agentId: string, task: Task): Promise<string> {
    const agent = getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Check concurrency
    const active = getActiveExecutionCount(agentId);
    const max = agent.config.maxConcurrent || 1;
    if (active >= max) throw new Error(`Agent ${agentId} at max concurrency (${max})`);

    const result = await agentRuntime.execute(agent, task);
    return result.output;
  }

  /** Find an available agent for a role (with capacity) */
  findAvailableAgent(role: string): AgentDefinition | undefined {
    let agents = listAgents({ role });
    if (agents.length === 0) {
      // Templates/workflows often reference an agent by its id (e.g. "pm",
      // "dev", "qa") rather than its role ("product-manager", "developer",
      // "tester"). Fall back to an id match so those pipelines aren't blocked.
      const byId = getAgent(role);
      if (byId) agents = [byId];
    }
    const available = agents.filter(a => {
      const active = getActiveExecutionCount(a.id);
      return active < (a.config.maxConcurrent || 1);
    });

    if (available.length === 0) return undefined;
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
