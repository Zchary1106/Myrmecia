import { normalizeGitHubRepository } from './github-fix-service.js';

const GITHUB_API = 'https://api.github.com';
const README_LIMIT = 20_000;

export interface GitHubRepoEvidencePackage {
  sourceType: 'github_public_repository';
  repository: string;
  repositoryUrl: string;
  fetchedAt: string;
  facts: {
    name: string;
    description: string | null;
    homepage: string | null;
    defaultBranch: string;
    visibility: 'public';
    stars: number;
    forks: number;
    openIssues: number;
    language: string | null;
    topics: string[];
    license: string | null;
    updatedAt: string;
  };
  readme: { sourceUrl: string; excerpt: string; truncated: boolean } | null;
  releases: Array<{ name: string; tagName: string; publishedAt: string | null; url: string; notesExcerpt: string }>;
  evidenceUrls: string[];
  limitations: string[];
}

type FetchLike = typeof fetch;

function githubHeaders(): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Myrmecia-Repo-Promotion/0.1',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fetchJson(fetcher: FetchLike, url: string): Promise<any> {
  const response = await fetcher(url, { headers: githubHeaders() });
  if (response.status === 404) {
    throw new Error('GitHub 仓库不存在、不是公开仓库，或当前 GitHub API 无权读取它。');
  }
  if (response.status === 403) {
    throw new Error('GitHub API 暂时限流，请稍后重试。');
  }
  if (!response.ok) throw new Error(`GitHub API 请求失败（${response.status}）。`);
  return response.json();
}

function decodeReadme(content: unknown): string {
  if (typeof content !== 'string') return '';
  return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8').replace(/\0/g, '').trim();
}

export async function researchPublicGitHubRepository(
  input: string,
  fetcher: FetchLike = fetch,
): Promise<GitHubRepoEvidencePackage> {
  const repository = normalizeGitHubRepository(input);
  const baseUrl = `${GITHUB_API}/repos/${repository}`;
  const [repo, readmeResult, releasesResult] = await Promise.all([
    fetchJson(fetcher, baseUrl),
    fetcher(`${baseUrl}/readme`, { headers: githubHeaders() }),
    fetcher(`${baseUrl}/releases?per_page=3`, { headers: githubHeaders() }),
  ]);

  let readme: GitHubRepoEvidencePackage['readme'] = null;
  if (readmeResult.ok) {
    const raw = await readmeResult.json() as { content?: string; html_url?: string };
    const fullText = decodeReadme(raw.content);
    readme = {
      sourceUrl: raw.html_url || `${repo.html_url}/blob/${repo.default_branch}/README.md`,
      excerpt: fullText.slice(0, README_LIMIT),
      truncated: fullText.length > README_LIMIT,
    };
  }

  const releases = releasesResult.ok
    ? (await releasesResult.json() as any[]).filter(release => !release.draft).map(release => ({
      name: String(release.name || release.tag_name || 'Untitled release'),
      tagName: String(release.tag_name || ''),
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
      url: String(release.html_url || repo.html_url),
      notesExcerpt: String(release.body || '').slice(0, 2_000),
    }))
    : [];

  return {
    sourceType: 'github_public_repository',
    repository,
    repositoryUrl: String(repo.html_url || `https://github.com/${repository}`),
    fetchedAt: new Date().toISOString(),
    facts: {
      name: String(repo.name || repository.split('/')[1]),
      description: typeof repo.description === 'string' ? repo.description : null,
      homepage: typeof repo.homepage === 'string' && repo.homepage.trim() ? repo.homepage : null,
      defaultBranch: String(repo.default_branch || 'main'),
      visibility: 'public',
      stars: Number(repo.stargazers_count || 0),
      forks: Number(repo.forks_count || 0),
      openIssues: Number(repo.open_issues_count || 0),
      language: typeof repo.language === 'string' ? repo.language : null,
      topics: Array.isArray(repo.topics) ? repo.topics.filter((topic: unknown) => typeof topic === 'string').slice(0, 20) : [],
      license: typeof repo.license?.spdx_id === 'string' ? repo.license.spdx_id : null,
      updatedAt: String(repo.updated_at || ''),
    },
    readme,
    releases,
    evidenceUrls: [String(repo.html_url || `https://github.com/${repository}`), ...(readme ? [readme.sourceUrl] : []), ...releases.map(release => release.url)],
    limitations: [
      '仅使用 GitHub 公开 API 快照；Star、Fork、Issue 数会变化，发布前应保留抓取时间。',
      'README 和 Release 描述是仓库作者提供的资料，不等同于独立性能验证。',
      ...(readme?.truncated ? ['README 过长，内容核心包仅使用前 20,000 个字符。'] : []),
      ...(!readme ? ['未获取到 README；不得补写未在其他证据中出现的功能或安装步骤。'] : []),
    ],
  };
}
