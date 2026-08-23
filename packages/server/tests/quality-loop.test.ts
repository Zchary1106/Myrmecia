import { describe, expect, it } from 'vitest';
import { createReviewPrompt, inheritExecutionContext, isQualityChildTask, parseReviewDecision } from '../src/pipelines/quality-loop.js';
import type { Task } from '../src/types.js';

describe('quality loop review contract', () => {
  it('accepts an explicit approved JSON decision', () => {
    expect(parseReviewDecision('{"approved":true,"findings":[]}').decision).toMatchObject({ approved: true, findings: [] });
  });

  it('never approves a substring or an invalid review response', () => {
    expect(parseReviewDecision('NOT APPROVED').decision).toBeUndefined();
    expect(parseReviewDecision('APPROVED').error).toContain('valid JSON');
  });

  it('rejects an approved review with unresolved findings', () => {
    const result = parseReviewDecision(JSON.stringify({
      approved: true,
      findings: [{ severity: 'high', evidence: 'missing check', requiredFix: 'add check' }],
    }));
    expect(result.decision).toBeUndefined();
    expect(result.error).toContain('must not contain findings');
  });

  it('preserves the complete execution context for QA child tasks', () => {
    const context = inheritExecutionContext({
      workdir: '/repo', workspacePath: '/repo', workspaceId: 'workspace-1', modelId: 'gpt-5',
      reasoningEffort: 'high', contextLength: 128000, domainId: 'software',
    } as Task);
    expect(context).toEqual({
      workdir: '/repo', workspacePath: '/repo', workspaceId: 'workspace-1', modelId: 'gpt-5',
      reasoningEffort: 'high', contextLength: 128000, domainId: 'software',
    });
  });

  it('does not recursively quality-gate Test, Review, or Fix child tasks', () => {
    expect(isQualityChildTask({ title: 'Test: feature', parentTaskId: 'task_parent' })).toBe(true);
    expect(isQualityChildTask({ title: 'Review: feature', parentTaskId: 'task_parent' })).toBe(true);
    expect(isQualityChildTask({ title: 'Fix: feature', parentTaskId: 'task_parent' })).toBe(true);
    expect(isQualityChildTask({ title: 'Implement feature', parentTaskId: 'task_parent' })).toBe(false);
  });

  it('provides bounded diff, changed-file, and test evidence to the reviewer', () => {
    const prompt = createReviewPrompt({ title: 'Implement change', output: 'developer summary', workdir: '/repo' } as Task, {
      schemaVersion: 1, status: 'passed', commands: ['pnpm test'], failures: [], changedFiles: ['src/change.ts'],
      summary: 'passed', createdAt: '2026-01-01T00:00:00.000Z', evidence: { command: 'pnpm test', cwd: '/repo', exitCode: 0 },
    }, { changedFiles: ['src/other.ts'], diff: 'diff --git a/src/change.ts b/src/change.ts' });
    expect(prompt).toContain('src/change.ts');
    expect(prompt).toContain('src/other.ts');
    expect(prompt).toContain('"exitCode": 0');
    expect(prompt).toContain('Git diff');
  });
});
