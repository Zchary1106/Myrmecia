import { describe, expect, it } from 'vitest';

import { buildContextBudgetPlan } from './context-compactor';

describe('buildContextBudgetPlan', () => {
  it('keeps task-critical facts and converts old raw logs into references', () => {
    const plan = buildContextBudgetPlan(
      { maxInputTokens: 100, reservedOutputTokens: 25, fixedTokens: 5, recentWindowTokens: 20 },
      [
        { id: 'goal', kind: 'goal', content: 'Ship a resumable execution flow', tokenCount: 18 },
        { id: 'constraint', kind: 'constraint', content: 'Do not change the workspace', tokenCount: 18 },
        { id: 'question', kind: 'open_question', content: 'Which provider supports resume?', tokenCount: 18 },
        { id: 'failure', kind: 'failure_evidence', content: 'Test command exited 1', tokenCount: 18 },
        { id: 'log', kind: 'tool_output', content: 'x'.repeat(5000), tokenCount: 1200, artifactId: 'artifact-1' },
      ],
    );

    expect(plan.protectedFacts.map((fact) => fact.id)).toEqual(['goal', 'constraint', 'question', 'failure']);
    expect(plan.references).toEqual([expect.objectContaining({ artifactId: 'artifact-1', id: 'log' })]);
    expect(plan.compactedToolOutputCount).toBe(1);
    expect(plan.hardBudgetExceeded).toBe(true);
  });
});
