import { describe, expect, it } from 'vitest';

import {
  appendManagedContextArtifact,
  appendManagedContextSummary,
  buildManagedContextPrompt,
  createManagedContextState,
} from './context-manager';

describe('managed context state', () => {
  it('keeps summary versions and returns artifact indexes instead of raw content', () => {
    let state = createManagedContextState({ goals: ['Fix timeout'], constraints: ['Preserve workspace'] });
    state = appendManagedContextSummary(state, 'First checkpoint', '2026-01-01T00:00:00.000Z');
    state = appendManagedContextSummary(state, 'Second checkpoint', '2026-01-01T00:01:00.000Z');
    state = appendManagedContextArtifact(state, {
      id: 'tool-1',
      kind: 'tool_output',
      artifactId: 'artifact-1',
      label: 'pnpm test output',
      createdAt: '2026-01-01T00:02:00.000Z',
    });

    const prompt = buildManagedContextPrompt(state);
    expect(prompt.latestSummary).toMatchObject({ version: 2, content: 'Second checkpoint' });
    expect(prompt.artifactReferences).toEqual([expect.objectContaining({ artifactId: 'artifact-1', label: 'pnpm test output' })]);
    expect(JSON.stringify(prompt)).not.toContain('raw stdout');
  });
});
