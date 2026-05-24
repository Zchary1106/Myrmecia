import { describe, it, expect } from 'vitest';
import { shouldLoopContinue, type LoopConfig } from './loop-stage.js';

describe('shouldLoopContinue', () => {
  const baseLoop: LoopConfig = { maxIterations: 3, exitCondition: 'pass', currentIteration: 0 };

  it('continues when output does not indicate pass', () => {
    const result = shouldLoopContinue(baseLoop, 'FAIL: 2 tests failed');
    expect(result.continue).toBe(true);
    expect(result.nextIteration).toBe(1);
  });

  it('stops when output indicates pass', () => {
    const result = shouldLoopContinue(baseLoop, 'All tests passed. PASS');
    expect(result.continue).toBe(false);
    expect(result.reason).toBe('exit_condition_met');
  });

  it('stops when maxIterations reached', () => {
    const exhausted: LoopConfig = { ...baseLoop, currentIteration: 3 };
    const result = shouldLoopContinue(exhausted, 'FAIL: still broken');
    expect(result.continue).toBe(false);
    expect(result.reason).toBe('max_iterations');
  });

  it('supports custom regex exit condition', () => {
    const custom: LoopConfig = { maxIterations: 5, exitCondition: 'custom', exitPattern: 'LGTM|approved', currentIteration: 0 };
    expect(shouldLoopContinue(custom, 'Changes look good. LGTM').continue).toBe(false);
    expect(shouldLoopContinue(custom, 'Needs more work').continue).toBe(true);
  });

  it('approve condition looks for approval keywords', () => {
    const approve: LoopConfig = { maxIterations: 3, exitCondition: 'approve', currentIteration: 0 };
    expect(shouldLoopContinue(approve, 'Approved. Ship it.').continue).toBe(false);
    expect(shouldLoopContinue(approve, 'Rejected. Fix the auth logic.').continue).toBe(true);
  });
});
