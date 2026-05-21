import { describe, it, expect, vi } from 'vitest';

vi.mock('../events/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

describe('Batch B integration', () => {
  it('SkillWatcher can be constructed without errors', async () => {
    const { SkillWatcher } = await import('../skills/skill-watcher.js');
    const watcher = new SkillWatcher('/tmp/nonexistent');
    expect(watcher).toBeDefined();
  });

  it('cost-dashboard query builders produce valid SQL', async () => {
    const { buildSummaryQuery, buildByAgentQuery, buildByModelQuery } = await import('../routes/cost-dashboard.js');

    const summary = buildSummaryQuery({ period: 'day' });
    expect(summary.sql).toContain('model_usage_stats');
    expect(summary.params).toHaveLength(2);

    const byAgent = buildByAgentQuery({ period: 'week' });
    expect(byAgent.sql).toContain('agent_id');

    const byModel = buildByModelQuery({ period: 'month' });
    expect(byModel.sql).toContain('model_id');
  });
});
