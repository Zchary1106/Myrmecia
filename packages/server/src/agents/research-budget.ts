/** Admission control before the shared MCP browser queue, scoped to one execution. */
export class ResearchBudget {
  private counts = new Map<string, number>();
  private tails = new Map<string, Promise<unknown>>();
  private failures = new Map<string, number>();
  private closed = false;

  constructor(private readonly deadline: number, private readonly searchLimit = 3) {}

  close() { this.closed = true; }

  async run(name: string, operation: () => Promise<string>, signal?: AbortSignal): Promise<string> {
    const xhs = name.startsWith('mcp__xiaohongshu__');
    const search = name === 'web.search' || name === 'mcp__xiaohongshu__search_feeds';
    const key = xhs ? 'xiaohongshu' : name;
    const stopped = () => this.closed || signal?.aborted;
    if (stopped()) throw new Error('Request aborted');
    if (!xhs && !search) return operation();
    if (search) {
      const count = this.counts.get(name) || 0;
      if (count >= this.searchLimit) return '[RESEARCH_LIMIT] Search budget reached. Do not repeat searches. Summarize the evidence already collected and explicitly list missing information.';
      this.counts.set(name, count + 1);
    }
    // Reserve the last minute for synthesis. No queued tool is allowed to
    // begin after cancellation or after the research deadline.
    const work = (this.tails.get(key) || Promise.resolve()).catch(() => undefined).then(async () => {
      if (stopped()) throw new Error('Request aborted');
      if (Date.now() >= this.deadline - 60_000) return '[RESEARCH_LIMIT] Time reserved for the final answer. Use collected evidence; do not call more tools.';
      if ((this.failures.get(key) || 0) >= 2) return '[RESEARCH_UNAVAILABLE] This source repeatedly failed. Stop querying it and report missing evidence.';
      let output: string;
      try { output = await operation(); }
      catch (error) {
        if (!stopped()) this.failures.set(key, (this.failures.get(key) || 0) + 1);
        throw error;
      }
      const failed = /Search failed:|XHS_(?:UNAVAILABLE|LOGIN_REQUIRED|QUEUE_TIMEOUT|READ_TIMEOUT)|Xiaohongshu read failed/i.test(output);
      this.failures.set(key, failed ? (this.failures.get(key) || 0) + 1 : 0);
      return output;
    });
    this.tails.set(key, work);
    return work;
  }
}
