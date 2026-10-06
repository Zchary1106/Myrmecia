import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchBudget } from '../src/agents/research-budget.js';

afterEach(() => vi.useRealTimers());

describe('Research admission budget', () => {
  it('admits at most three searches and executes the admitted calls serially', async () => {
    const budget = new ResearchBudget(Date.now() + 600_000);
    let concurrent = 0;
    let peak = 0;
    const read = vi.fn(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent--;
      return 'evidence';
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => budget.run('mcp__xiaohongshu__search_feeds', read)));
    expect(read).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    expect(results.filter(result => result.includes('RESEARCH_LIMIT'))).toHaveLength(5);
  });

  it('does not launch queued work after cancellation', async () => {
    const budget = new ResearchBudget(Date.now() + 600_000);
    const controller = new AbortController();
    let finish!: (value: string) => void;
    const first = budget.run('mcp__xiaohongshu__search_feeds', () => new Promise(resolve => { finish = resolve; }), controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    const read = vi.fn();
    const second = budget.run('mcp__xiaohongshu__search_feeds', read, controller.signal);
    const rejected = expect(second).rejects.toThrow('aborted');
    controller.abort();
    finish('evidence');
    await first;
    await rejected;
    expect(read).not.toHaveBeenCalled();
  });

  it('reserves synthesis time and reduces search limits for recovery', async () => {
    const read = vi.fn().mockResolvedValue('evidence');
    const nearDeadline = new ResearchBudget(Date.now() + 30_000);
    expect(await nearDeadline.run('web.search', read)).toContain('Time reserved');
    expect(read).not.toHaveBeenCalled();
    const retry = new ResearchBudget(Date.now() + 600_000, 2);
    await retry.run('web.search', read);
    await retry.run('web.search', read);
    expect(await retry.run('web.search', read)).toContain('RESEARCH_LIMIT');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('opens the source circuit after repeated network errors', async () => {
    const budget = new ResearchBudget(Date.now() + 600_000);
    const read = vi.fn().mockResolvedValue('Search failed: fetch failed');
    const outputs = await Promise.all(Array.from({ length: 3 }, () => budget.run('web.search', read)));
    expect(read).toHaveBeenCalledTimes(2);
    expect(outputs[2]).toContain('RESEARCH_UNAVAILABLE');
  });

  it('also opens the circuit when the transport throws instead of returning error text', async () => {
    const budget = new ResearchBudget(Date.now() + 600_000);
    const read = vi.fn().mockRejectedValue(new Error('network unavailable'));
    await expect(budget.run('mcp__xiaohongshu__get_feed_detail', read)).rejects.toThrow('network');
    await expect(budget.run('mcp__xiaohongshu__get_feed_detail', read)).rejects.toThrow('network');
    expect(await budget.run('mcp__xiaohongshu__get_feed_detail', read)).toContain('RESEARCH_UNAVAILABLE');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
