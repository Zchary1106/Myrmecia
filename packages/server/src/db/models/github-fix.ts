import { getDb } from '../database.js';
import { getTask } from './task.js';
import type { GitHubFixRun, GitHubFixStatus } from '../../types.js';

function rowToRun(row: any): GitHubFixRun {
  const task = row.task_id ? getTask(row.task_id) : undefined;
  const effectiveStatus: GitHubFixStatus = row.status === 'running' && task?.status === 'done'
    ? 'ready'
    : row.status === 'running' && (task?.status === 'failed' || task?.status === 'cancelled')
      ? 'failed'
      : row.status;
  return {
    id: row.id,
    workspaceId: row.workspace_id || 'default',
    repository: row.repository,
    repositoryUrl: row.repository_url,
    issueNumber: row.issue_number ?? undefined,
    issueUrl: row.issue_url || undefined,
    issueTitle: row.issue_title || undefined,
    baseBranch: row.base_branch,
    workBranch: row.work_branch,
    localPath: row.local_path,
    viewerPermission: row.viewer_permission,
    forkRepository: row.fork_repository || undefined,
    status: effectiveStatus,
    taskId: row.task_id || undefined,
    teamRunId: row.team_run_id || undefined,
    taskStatus: task?.status,
    prUrl: row.pr_url || undefined,
    error: row.error || task?.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createGitHubFixRun(data: Omit<GitHubFixRun, 'createdAt' | 'updatedAt' | 'taskStatus'>): GitHubFixRun {
  getDb().run(`
    INSERT INTO github_fix_runs (
      id, workspace_id, repository, repository_url, issue_number, issue_url,
      issue_title, base_branch, work_branch, local_path, viewer_permission,
      fork_repository, status, task_id, team_run_id, pr_url, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    data.id,
    data.workspaceId,
    data.repository,
    data.repositoryUrl,
    data.issueNumber ?? null,
    data.issueUrl || null,
    data.issueTitle || null,
    data.baseBranch,
    data.workBranch,
    data.localPath,
    data.viewerPermission,
    data.forkRepository || null,
    data.status,
    data.taskId || null,
    data.teamRunId || null,
    data.prUrl || null,
    data.error || null,
  );
  return getGitHubFixRun(data.id)!;
}

export function getGitHubFixRun(id: string): GitHubFixRun | undefined {
  const row = getDb().get('SELECT * FROM github_fix_runs WHERE id = ?', id);
  return row ? rowToRun(row) : undefined;
}

export function listGitHubFixRuns(workspaceId = 'default', limit = 50): GitHubFixRun[] {
  return getDb().all(
    'SELECT * FROM github_fix_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?',
    workspaceId,
    limit,
  ).map(rowToRun);
}

export function updateGitHubFixRun(id: string, updates: Partial<{
  status: GitHubFixStatus;
  taskId: string;
  teamRunId: string;
  forkRepository: string;
  prUrl: string;
  error: string | null;
}>): GitHubFixRun | undefined {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.taskId !== undefined) { sets.push('task_id = ?'); params.push(updates.taskId); }
  if (updates.teamRunId !== undefined) { sets.push('team_run_id = ?'); params.push(updates.teamRunId); }
  if (updates.forkRepository !== undefined) { sets.push('fork_repository = ?'); params.push(updates.forkRepository); }
  if (updates.prUrl !== undefined) { sets.push('pr_url = ?'); params.push(updates.prUrl); }
  if (updates.error !== undefined) { sets.push('error = ?'); params.push(updates.error); }
  if (!sets.length) return getGitHubFixRun(id);
  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  getDb().run(`UPDATE github_fix_runs SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getGitHubFixRun(id);
}
