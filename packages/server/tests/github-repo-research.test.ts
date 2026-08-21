import { describe, expect, it } from 'vitest';
import { researchPublicGitHubRepository } from '../src/github/github-repo-research.js';

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('GitHub repository promotion research', () => {
  it('creates a dated, source-linked public evidence package', async () => {
    const fetcher = async (url: string) => {
      if (url.endsWith('/readme')) return jsonResponse({
        content: Buffer.from('# Demo\nA factual demo repository.').toString('base64'),
        html_url: 'https://github.com/acme/demo/blob/main/README.md',
      });
      if (url.includes('/releases')) return jsonResponse([{ tag_name: 'v1.0.0', name: 'First release', html_url: 'https://github.com/acme/demo/releases/tag/v1.0.0', body: 'Initial release' }]);
      return jsonResponse({ name: 'demo', html_url: 'https://github.com/acme/demo', default_branch: 'main', stargazers_count: 12, forks_count: 3, open_issues_count: 2, updated_at: '2026-08-19T00:00:00Z', topics: ['agents'], license: { spdx_id: 'MIT' } });
    };

    const result = await researchPublicGitHubRepository('https://github.com/acme/demo', fetcher as typeof fetch);
    expect(result.repository).toBe('acme/demo');
    expect(result.facts.stars).toBe(12);
    expect(result.readme?.excerpt).toContain('factual demo');
    expect(result.releases[0]?.tagName).toBe('v1.0.0');
    expect(result.limitations.join(' ')).toContain('快照');
  });
});
