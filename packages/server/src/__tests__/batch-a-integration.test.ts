import { describe, it, expect, vi } from 'vitest';
import { eventBus } from '../events/event-bus.js';

/**
 * Smoke test: verify all three modules register their EventBus listeners
 * without throwing during construction.
 */
describe('Batch A integration', () => {
  it('CoverageChecker registers on task:done', async () => {
    const onSpy = vi.spyOn(eventBus, 'on');
    const { CoverageChecker } = await import('../workers/coverage-check.js');
    new CoverageChecker({ enabled: true });
    expect(onSpy).toHaveBeenCalledWith('task:done', expect.any(Function));
    onSpy.mockRestore();
  });

  it('ExecutionScorer registers on task:done', async () => {
    const onSpy = vi.spyOn(eventBus, 'on');
    const { ExecutionScorer } = await import('../evaluation/execution-scorer.js');
    new ExecutionScorer();
    expect(onSpy).toHaveBeenCalledWith('task:done', expect.any(Function));
    onSpy.mockRestore();
  });

  it('PipelineRollback registers on task:failed', async () => {
    const onSpy = vi.spyOn(eventBus, 'on');
    const { PipelineRollback } = await import('../pipelines/pipeline-rollback.js');
    new PipelineRollback();
    expect(onSpy).toHaveBeenCalledWith('task:failed', expect.any(Function));
    onSpy.mockRestore();
  });
});
