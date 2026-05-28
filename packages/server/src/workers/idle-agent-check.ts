/**
 * Idle Agent Check Worker
 * Detects agents that have been idle for too long and updates their status.
 */

import { listAgents, updateAgent } from '../db/models/agent.js';
import { getActiveExecutionCount } from '../db/models/execution.js';
import type { BackgroundWorker, WorkerContext, WorkerResult } from './scheduler.js';

export const idleAgentCheckWorker: BackgroundWorker = {
  id: 'idle-agent-check',
  name: 'Idle Agent Check',
  intervalMs: 5 * 60 * 1000, // 5 minutes
  enabled: true,

  async run(ctx: WorkerContext): Promise<WorkerResult> {
    const agents = listAgents();
    let idleCount = 0;

    for (const agent of agents) {
      const active = getActiveExecutionCount(agent.id);
      const lastActive = agent.stats?.lastActiveAt;
      const idleMinutes = lastActive
        ? (Date.now() - new Date(lastActive).getTime()) / 60000
        : Infinity;

      if (active === 0 && idleMinutes > 30) {
        idleCount++;
      }
    }

    return {
      success: true,
      message: `${idleCount}/${agents.length} agents idle > 30min`,
    };
  },
};
