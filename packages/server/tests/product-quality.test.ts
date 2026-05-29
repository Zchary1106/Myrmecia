import { describe, expect, it } from 'vitest';
import { evaluateProductQuality } from '../src/quality/product-quality.js';

describe('product quality gate', () => {
  it('blocks failed UX/product signals and preserves warnings', () => {
    const result = evaluateProductQuality([
      { area: 'accessibility', status: 'pass', summary: 'keyboard flow ok' },
      { area: 'react', status: 'fail', summary: 'error state missing' },
      { area: 'performance', status: 'warn', summary: 'slow render path' },
    ]);

    expect(result.passed).toBe(false);
    expect(result.blockers[0]).toContain('react');
    expect(result.warnings[0]).toContain('performance');
  });
});
