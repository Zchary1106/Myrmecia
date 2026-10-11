export class AgentConcurrencyError extends Error {
  readonly code = 'AGENT_CONCURRENCY_LIMIT';
  constructor(readonly agentId: string, readonly maxConcurrent: number) {
    super(`Agent ${agentId} at max concurrency (${maxConcurrent})`);
    this.name = 'AgentConcurrencyError';
  }
}
