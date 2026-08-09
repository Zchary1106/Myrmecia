import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { v4 as uuid } from 'uuid';
import type { GitHubConnectionStatus, GitHubFixDiff, GitHubFixRun } from '../types.js';
import { TeamCoordinator } from '../agents/team-coordinator.js';
import { getTeam } from '../agents/team-registry.js';
import {
  createGitHubFixRun,
  getGitHubFixRun,
  listGitHubFixRuns,
  updateGitHubFixRun,
} from '../db/models/github-fix.js';

const execFileAsync = promisify(execFile);
const WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);
const MAX_COMMAND_OUTPUT = 2_000_000;

interface RepoInfo {
  nameWithOwner: string;
  url: string;
  defaultBranchRef?: { name?: string };
  viewerPermission?: string;
}

interface IssueInfo {
  number: number;
  title: string;
  body?: string;
  url: string;
  labels?: Array<{ name?: string }>;
}

export interface CreateGitHubFixInput {
  repository: string;
  issue?: string;
  bugDescription?: string;
  baseBranch?: string;
  sparsePaths?: string[];
  teamId?: string;
  workspaceId?: string;
}

export interface CreatePullRequestInput {
  title?: string;
  body?: string;
  commitMessage?: string;
}

function commandOptions(cwd?: string, timeoutMs = 120_000) {
  return {
    cwd,
    encoding: 'utf8' as const,
    timeout: timeoutMs,
    maxBuffer: MAX_COMMAND_OUTPUT,
    env: process.env,
  };
}

async function run(command: string, args: string[], cwd?: string, timeoutMs?: number): Promise<string> {
  const { stdout } = await execFileAsync(command, args, commandOptions(cwd, timeoutMs));
  return stdout.trim();
}

export function normalizeGitHubRepository(input: string): string {
  const value = input.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)) {
    return value.replace(/\.git$/, '');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Repository must be owner/name or a github.com repository URL');
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Only github.com repositories are supported');
  }
  const segments = parsed.pathname.replace(/^\/|\/$/g, '').split('/');
  if (segments.length < 2 || !segments[0] || !segments[1]) {
    throw new Error('GitHub repository URL must include owner and repository');
  }
  return `${segments[0]}/${segments[1].replace(/\.git$/, '')}`;
}

export function parseIssueNumber(input: string | undefined, repository: string): number | undefined {
  const value = input?.trim();
  if (!value) return undefined;
  const direct = value.match(/^#?(\d+)$/);
  if (direct) return Number(direct[1]);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Issue must be a number or github.com issue URL');
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') throw new Error('Issue URL must use github.com');
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
  if (!match) throw new Error('Issue URL is not valid');
  if (`${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Issue URL must belong to the selected repository');
  }
  return Number(match[3]);
}

function validateBranchName(value: string): string {
  const branch = value.trim();
  if (!branch || branch.startsWith('-') || branch.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error('Base branch contains unsupported characters');
  }
  return branch;
}

function validateSparsePaths(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map(value => value.trim()).filter(Boolean).map(value => {
    if (
      value.startsWith('/')
      || value.startsWith('-')
      || value.includes('..')
      || !/^[A-Za-z0-9._/@+-]+$/.test(value)
    ) {
      throw new Error(`Sparse checkout path contains unsupported characters: ${value}`);
    }
    return value.replace(/\/+$/, '');
  }))].slice(0, 50);
}

function buildWorkBranch(issueNumber: number | undefined, runId: string): string {
  return `codex/fix-${issueNumber ? `issue-${issueNumber}` : runId.replace(/^ghfix_/, '')}`;
}

export function buildGitHubFixPrompt(run: {
  repository: string;
  repositoryUrl: string;
  issue?: IssueInfo;
  bugDescription?: string;
  baseBranch: string;
  workBranch: string;
  teamName?: string;
}): string {
  const issueBlock = run.issue
    ? `Issue #${run.issue.number}: ${run.issue.title}\nURL: ${run.issue.url}\nLabels: ${(run.issue.labels || []).map(label => label.name).filter(Boolean).join(', ') || 'none'}\n\n${run.issue.body || '(No issue body)'}`
    : `Bug report supplied by operator:\n${run.bugDescription || '(No description supplied)'}`;
  return `Work as the selected ${run.teamName || 'agent team'} on a bug in the managed GitHub repository checkout.

Repository: ${run.repository}
Repository URL: ${run.repositoryUrl}
Base branch: ${run.baseBranch}
Working branch: ${run.workBranch}

${issueBlock}

Team objective:
- Use the selected team's existing roles, Skills, and Tools rather than inventing a new GitHub-specific Agent.
- Read AGENTS.md and repository-local instructions before changing files.
- Reproduce or otherwise establish evidence for the bug before implementing a fix.
- Add or update regression coverage when practical.
- Review the final diff, run relevant validation, and report CI or release-readiness concerns.
- Consolidate one final result: root cause, changed files, validation, review findings, and remaining risks.

Safety:
- Only teammates that already have repository write Tools may modify files.
- Work only inside the provided checkout.
- Do not commit, push, fork, open a pull request, merge, publish, or modify GitHub settings.
- Do not expose tokens, secrets, private issue data, or local credential files.
- If the bug cannot be reproduced, state that clearly and add evidence rather than guessing.`;
}

export class GitHubFixService {
  private readonly root: string;

  constructor(
    private readonly teamCoordinator: TeamCoordinator,
    root?: string,
  ) {
    const workspaceRoot = root || process.env.MYRMECIA_WORKSPACE_ROOT || process.cwd();
    this.root = join(workspaceRoot, '.agent-factory', 'github-fixes');
  }

  async connectionStatus(): Promise<GitHubConnectionStatus> {
    try {
      const login = await run('gh', ['api', 'user', '--jq', '.login'], undefined, 20_000);
      return { authenticated: true, login };
    } catch (error) {
      return {
        authenticated: false,
        message: error instanceof Error ? error.message : 'GitHub CLI authentication is unavailable',
      };
    }
  }

  async create(input: CreateGitHubFixInput): Promise<GitHubFixRun> {
    const repository = normalizeGitHubRepository(input.repository);
    const issueNumber = parseIssueNumber(input.issue, repository);
    const workspaceId = input.workspaceId || 'default';
    const teamId = input.teamId || 'bugfix';
    const sparsePaths = validateSparsePaths(input.sparsePaths);
    const team = getTeam(teamId, workspaceId);
    if (!team) throw new Error(`Unknown team: ${teamId}`);
    if (!issueNumber && !input.bugDescription?.trim()) {
      throw new Error('Provide a GitHub issue or a bug description');
    }

    const repoInfo = JSON.parse(await run('gh', [
      'repo', 'view', repository,
      '--json', 'nameWithOwner,url,defaultBranchRef,viewerPermission',
    ], undefined, 30_000)) as RepoInfo;
    const baseBranch = validateBranchName(input.baseBranch || repoInfo.defaultBranchRef?.name || 'main');
    const issue = issueNumber
      ? JSON.parse(await run('gh', [
        'issue', 'view', String(issueNumber),
        '--repo', repoInfo.nameWithOwner,
        '--json', 'number,title,body,url,labels',
      ], undefined, 30_000)) as IssueInfo
      : undefined;

    const id = `ghfix_${uuid().slice(0, 8)}`;
    const repoName = repoInfo.nameWithOwner.split('/')[1];
    const localPath = join(this.root, id, repoName);
    const workBranch = buildWorkBranch(issueNumber, id);
    await mkdir(join(this.root, id), { recursive: true });

    createGitHubFixRun({
      id,
      workspaceId,
      repository: repoInfo.nameWithOwner,
      repositoryUrl: repoInfo.url,
      issueNumber,
      issueUrl: issue?.url,
      issueTitle: issue?.title,
      baseBranch,
      workBranch,
      localPath,
      viewerPermission: repoInfo.viewerPermission || 'READ',
      status: 'preparing',
    });

    try {
      // A repair run only needs the selected base branch. Avoid downloading a
      // popular repository's complete history before Agents can begin work.
      const cloneArgs = [
        'repo', 'clone', repoInfo.nameWithOwner, localPath, '--',
        '--filter=blob:none', '--depth=1', '--single-branch', '--branch', baseBranch,
        ...(sparsePaths.length ? ['--sparse'] : []),
      ];
      await run('gh', cloneArgs, undefined, 300_000);
      if (sparsePaths.length) {
        await run('git', ['sparse-checkout', 'set', ...sparsePaths], localPath, 300_000);
      }
      await run('git', ['switch', '-c', workBranch], localPath, 30_000);
      const prompt = buildGitHubFixPrompt({
        repository: repoInfo.nameWithOwner,
        repositoryUrl: repoInfo.url,
        issue,
        bugDescription: input.bugDescription?.trim(),
        baseBranch,
        workBranch,
        teamName: team.name,
      });
      const teamResult = await this.teamCoordinator.dispatch(
        teamId,
        prompt,
        workspaceId,
        localPath,
      );
      return updateGitHubFixRun(id, {
        status: 'running',
        taskId: teamResult.run.parentTaskId,
        teamRunId: teamResult.run.id,
        error: null,
      })!;
    } catch (error) {
      updateGitHubFixRun(id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  list(workspaceId: string): GitHubFixRun[] {
    return listGitHubFixRuns(workspaceId);
  }

  get(id: string): GitHubFixRun | undefined {
    return getGitHubFixRun(id);
  }

  async diff(id: string): Promise<GitHubFixDiff> {
    const fixRun = getGitHubFixRun(id);
    if (!fixRun) throw new Error('GitHub fix run not found');
    const status = await run('git', ['status', '--short'], fixRun.localPath, 15_000);
    const stat = await run('git', ['diff', '--stat', 'HEAD'], fixRun.localPath, 15_000);
    const patch = await run('git', ['diff', '--no-ext-diff', '--unified=3', 'HEAD'], fixRun.localPath, 30_000);
    return {
      status,
      stat,
      patch: patch.slice(0, 500_000),
      hasChanges: Boolean(status.trim()),
    };
  }

  async createPullRequest(id: string, input: CreatePullRequestInput): Promise<GitHubFixRun> {
    const fixRun = getGitHubFixRun(id);
    if (!fixRun) throw new Error('GitHub fix run not found');
    if (fixRun.status !== 'ready') throw new Error('The fix task must complete before creating a pull request');
    const diff = await this.diff(id);
    if (!diff.hasChanges) throw new Error('No repository changes are available to commit');

    const connection = await this.connectionStatus();
    if (!connection.authenticated || !connection.login) throw new Error('GitHub CLI is not authenticated');
    const title = input.title?.trim() || `fix: ${fixRun.issueTitle || 'resolve reported bug'}`;
    const issueReference = fixRun.issueNumber ? `\n\nFixes #${fixRun.issueNumber}` : '';
    const body = (input.body?.trim() || [
      '## Summary',
      '',
      '- Fixes the reported bug.',
      '- Adds or updates regression coverage.',
      '',
      '## Validation',
      '',
      '- See task output and repository checks.',
    ].join('\n')) + issueReference;
    const commitMessage = input.commitMessage?.trim() || title;

    await run('git', ['add', '-A'], fixRun.localPath, 30_000);
    await run('git', [
      '-c', `user.name=${connection.login}`,
      '-c', `user.email=${connection.login}@users.noreply.github.com`,
      'commit', '-m', commitMessage,
    ], fixRun.localPath, 60_000);

    let head = fixRun.workBranch;
    let forkRepository: string | undefined;
    if (WRITE_PERMISSIONS.has(fixRun.viewerPermission.toUpperCase())) {
      await run('git', ['push', '-u', 'origin', fixRun.workBranch], fixRun.localPath, 120_000);
    } else {
      const repoName = fixRun.repository.split('/')[1];
      forkRepository = `${connection.login}/${repoName}`;
      try {
        await run('gh', ['repo', 'view', forkRepository, '--json', 'nameWithOwner'], undefined, 20_000);
      } catch {
        await run('gh', ['repo', 'fork', fixRun.repository, '--clone=false'], undefined, 120_000);
      }
      try {
        await run('git', ['remote', 'remove', 'fork'], fixRun.localPath, 10_000);
      } catch {
        // No previous fork remote.
      }
      await run('git', ['remote', 'add', 'fork', `https://github.com/${forkRepository}.git`], fixRun.localPath, 10_000);
      await run('git', ['push', '-u', 'fork', fixRun.workBranch], fixRun.localPath, 120_000);
      head = `${connection.login}:${fixRun.workBranch}`;
    }

    const prUrl = await run('gh', [
      'pr', 'create',
      '--repo', fixRun.repository,
      '--base', fixRun.baseBranch,
      '--head', head,
      '--title', title,
      '--body', body,
    ], fixRun.localPath, 120_000);
    return updateGitHubFixRun(id, {
      status: 'pr_created',
      prUrl: prUrl.split('\n').find(line => line.startsWith('https://')) || prUrl,
      ...(forkRepository ? { forkRepository } : {}),
      error: null,
    })!;
  }

  async cleanup(id: string): Promise<void> {
    const fixRun = getGitHubFixRun(id);
    if (!fixRun) return;
    await rm(join(this.root, id), { recursive: true, force: true });
  }
}
