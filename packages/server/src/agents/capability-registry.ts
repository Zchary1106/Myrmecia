import { listAgents } from '../db/models/agent.js';
import { getActiveExecutionCount } from '../db/models/execution.js';
import { eventBus } from '../events/event-bus.js';
import { logger } from '../lib/logger.js';
import type { AgentDefinition } from '../types.js';

export class CapabilityRegistry {
  private capabilityToAgents = new Map<string, string[]>();
  private agentToCapabilities = new Map<string, string[]>();
  private agentsById = new Map<string, AgentDefinition>();

  constructor() {
    eventBus.on('agent:status', () => this.refresh());
  }

  buildIndex(): void {
    this.capabilityToAgents.clear();
    this.agentToCapabilities.clear();
    this.agentsById.clear();

    const agents = listAgents();
    for (const agent of agents) {
      this.agentsById.set(agent.id, agent);
      const caps = agent.capabilities || [];
      this.agentToCapabilities.set(agent.id, caps);

      for (const cap of caps) {
        const existing = this.capabilityToAgents.get(cap) || [];
        existing.push(agent.id);
        this.capabilityToAgents.set(cap, existing);
      }
    }

    logger.info({ capabilities: this.capabilityToAgents.size, agents: agents.length }, 'Capability index built');
  }

  refresh(): void {
    this.buildIndex();
  }

  findProvider(capability: string): AgentDefinition | undefined {
    const agentIds = this.capabilityToAgents.get(capability);
    if (!agentIds || agentIds.length === 0) return undefined;

    const available = agentIds
      .map(id => this.agentsById.get(id))
      .filter((a): a is AgentDefinition => {
        if (!a) return false;
        const active = getActiveExecutionCount(a.id);
        return active < (a.config.maxConcurrent || 1);
      });

    if (available.length === 0) return undefined;
    if (available.length === 1) return available[0];

    const weights = available.map(a => (a as any).routeWeight ?? 1.0);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let rand = Math.random() * totalWeight;
    for (let i = 0; i < available.length; i++) {
      rand -= weights[i];
      if (rand <= 0) return available[i];
    }
    return available[available.length - 1];
  }

  findAllProviders(capability: string): AgentDefinition[] {
    const agentIds = this.capabilityToAgents.get(capability) || [];
    return agentIds
      .map(id => this.agentsById.get(id))
      .filter((a): a is AgentDefinition => !!a);
  }

  getAgentCapabilities(agentId: string): string[] {
    return this.agentToCapabilities.get(agentId) || [];
  }

  listCapabilities(): Array<{ capability: string; providerCount: number }> {
    return Array.from(this.capabilityToAgents.entries()).map(([capability, agents]) => ({
      capability,
      providerCount: agents.length,
    }));
  }
}
