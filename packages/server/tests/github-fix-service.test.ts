import { describe, expect, it } from 'vitest';
import {
  buildGitHubFixPrompt,
  normalizeGitHubRepository,
  parseIssueNumber,
} from '../src/github/github-fix-service.js';

describe('GitHub fix service input handling', () => {
  it('normalizes supported GitHub repository references', () => {
    expect(normalizeGitHubRepository('openai/openai-node')).toBe('openai/openai-node');
    expect(normalizeGitHubRepository('https://github.com/openai/openai-node.git')).toBe('openai/openai-node');
    expect(() => normalizeGitHubRepository('https://gitlab.com/openai/openai-node')).toThrow('Only github.com');
    expect(() => normalizeGitHubRepository('not a repo')).toThrow('owner/name');
  });

  it('parses issue numbers and rejects cross-repository issue URLs', () => {
    expect(parseIssueNumber('#123', 'openai/openai-node')).toBe(123);
    expect(parseIssueNumber('https://github.com/openai/openai-node/issues/456', 'openai/openai-node')).toBe(456);
    expect(() => parseIssueNumber(
      'https://github.com/openai/openai-python/issues/456',
      'openai/openai-node',
    )).toThrow('selected repository');
  });

  it('builds a governed prompt that forbids autonomous GitHub writes', () => {
    const prompt = buildGitHubFixPrompt({
      repository: 'openai/openai-node',
      repositoryUrl: 'https://github.com/openai/openai-node',
      issue: {
        number: 123,
        title: 'Fix a bug',
        body: 'Steps to reproduce',
        url: 'https://github.com/openai/openai-node/issues/123',
        labels: [{ name: 'bug' }],
      },
      baseBranch: 'main',
      workBranch: 'codex/fix-issue-123',
      teamName: 'Bugfix Team',
    });

    expect(prompt).toContain('Issue #123');
    expect(prompt).toContain('regression coverage');
    expect(prompt).toContain('existing roles, Skills, and Tools');
    expect(prompt).toContain('Only teammates that already have repository write Tools');
    expect(prompt).toContain('Do not commit, push, fork, open a pull request');
  });
});
