import { execSync, exec } from 'child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { eventBus } from '../events/event-bus.js';
import { addTaskLog } from '../db/models/task.js';

/**
 * Workspace Manager
 * Provides isolated working directories for pipelines and tasks
 * using git worktrees (when in a git repo) or plain directories.
 */
export class WorkspaceManager {
  private baseDir: string;    // Root project directory
  private workspacesDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || process.cwd();
    this.workspacesDir = join(this.baseDir, '.agent-factory', 'workspaces');
    mkdirSync(this.workspacesDir, { recursive: true });
  }

  /**
   * Create an isolated workspace for a pipeline.
   * Uses git worktree if in a git repo, otherwise creates a plain directory.
   */
  async createPipelineWorkspace(pipelineId: string): Promise<WorkspaceInfo> {
    const wsPath = join(this.workspacesDir, `pipeline-${pipelineId}`);
    const branchName = `agent-factory/pipeline-${pipelineId}`;

    if (this.isGitRepo()) {
      return this.createGitWorktree(wsPath, branchName, pipelineId);
    } else {
      return this.createPlainWorkspace(wsPath, pipelineId);
    }
  }

  /**
   * Create an isolated workspace for a standalone task.
   */
  async createTaskWorkspace(taskId: string): Promise<WorkspaceInfo> {
    const wsPath = join(this.workspacesDir, `task-${taskId}`);

    if (this.isGitRepo()) {
      const branchName = `agent-factory/task-${taskId}`;
      return this.createGitWorktree(wsPath, branchName, taskId);
    } else {
      return this.createPlainWorkspace(wsPath, taskId);
    }
  }

  /**
   * Create a stage directory within a pipeline workspace.
   */
  createStageDir(pipelineWorkspace: string, stageIndex: number, stageName: string): string {
    const stageDir = join(pipelineWorkspace, `stage-${stageIndex}-${stageName.toLowerCase().replace(/\s+/g, '-')}`);
    mkdirSync(stageDir, { recursive: true });
    return stageDir;
  }

  /**
   * Write stage output as artifact files.
   */
  writeStageArtifact(stageDir: string, output: string, fileName: string = 'output.md'): string {
    const artifactPath = join(stageDir, fileName);
    writeFileSync(artifactPath, output, 'utf-8');
    return artifactPath;
  }

  /**
   * Read stage artifact.
   */
  readStageArtifact(stageDir: string, fileName: string = 'output.md'): string | null {
    const artifactPath = join(stageDir, fileName);
    try {
      return readFileSync(artifactPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Merge a pipeline workspace back into the main branch.
   */
  async mergePipelineWorkspace(pipelineId: string, commitMessage?: string): Promise<{ success: boolean; error?: string }> {
    const wsPath = join(this.workspacesDir, `pipeline-${pipelineId}`);
    const branchName = `agent-factory/pipeline-${pipelineId}`;

    if (!existsSync(wsPath)) {
      return { success: false, error: 'Workspace not found' };
    }

    if (!this.isGitRepo()) {
      return { success: true }; // Nothing to merge for plain workspaces
    }

    try {
      // Commit any uncommitted changes in the worktree
      try {
        execSync(`git -C "${wsPath}" add -A`, { stdio: 'pipe' });
        execSync(`git -C "${wsPath}" commit -m "${commitMessage || `Agent Factory: pipeline ${pipelineId} output`}" --allow-empty`, { stdio: 'pipe' });
      } catch {
        // No changes to commit, that's fine
      }

      // Get the current branch of main repo
      const mainBranch = execSync(`git -C "${this.baseDir}" rev-parse --abbrev-ref HEAD`, { encoding: 'utf-8' }).trim();

      // Merge the pipeline branch into main
      execSync(`git -C "${this.baseDir}" merge "${branchName}" --no-edit`, { stdio: 'pipe' });

      return { success: true };
    } catch (err: any) {
      return { success: false, error: `Merge failed: ${err.message}` };
    }
  }

  /**
   * Clean up a workspace (remove worktree and branch).
   */
  async cleanupWorkspace(id: string, type: 'pipeline' | 'task' = 'pipeline'): Promise<void> {
    const wsPath = join(this.workspacesDir, `${type}-${id}`);
    const branchName = `agent-factory/${type}-${id}`;

    if (!existsSync(wsPath)) return;

    if (this.isGitRepo()) {
      try {
        execSync(`git -C "${this.baseDir}" worktree remove "${wsPath}" --force`, { stdio: 'pipe' });
      } catch {
        // Force remove if worktree remove fails
        rmSync(wsPath, { recursive: true, force: true });
      }

      try {
        execSync(`git -C "${this.baseDir}" branch -D "${branchName}"`, { stdio: 'pipe' });
      } catch {
        // Branch might not exist
      }
    } else {
      rmSync(wsPath, { recursive: true, force: true });
    }
  }

  /**
   * Get workspace info.
   */
  getWorkspaceInfo(id: string, type: 'pipeline' | 'task' = 'pipeline'): WorkspaceInfo | null {
    const wsPath = join(this.workspacesDir, `${type}-${id}`);
    if (!existsSync(wsPath)) return null;

    return {
      path: wsPath,
      type,
      id,
      isGitWorktree: this.isGitRepo(),
      branchName: this.isGitRepo() ? `agent-factory/${type}-${id}` : undefined,
    };
  }

  /**
   * Get the output directory for a workspace.
   */
  getOutputDir(id: string, type: 'pipeline' | 'task' = 'task'): string | null {
    const wsPath = join(this.workspacesDir, `${type}-${id}`);
    if (!existsSync(wsPath)) return null;
    const outputDir = join(wsPath, 'output');
    mkdirSync(outputDir, { recursive: true });
    return outputDir;
  }

  /**
   * List all active workspaces.
   */
  listWorkspaces(): WorkspaceInfo[] {
    const { readdirSync } = require('fs');
    try {
      const entries = readdirSync(this.workspacesDir, { withFileTypes: true });
      return entries
        .filter((e: any) => e.isDirectory())
        .map((e: any) => {
          const match = e.name.match(/^(pipeline|task)-(.+)$/);
          if (!match) return null;
          return this.getWorkspaceInfo(match[2], match[1] as 'pipeline' | 'task');
        })
        .filter(Boolean) as WorkspaceInfo[];
    } catch {
      return [];
    }
  }

  // === Private Methods ===

  private isGitRepo(): boolean {
    try {
      execSync(`git -C "${this.baseDir}" rev-parse --git-dir`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private createGitWorktree(wsPath: string, branchName: string, id: string): WorkspaceInfo {
    if (existsSync(wsPath)) {
      return { path: wsPath, type: 'pipeline', id, isGitWorktree: true, branchName };
    }

    try {
      // Create a new branch from HEAD and set up worktree
      execSync(`git -C "${this.baseDir}" worktree add -b "${branchName}" "${wsPath}" HEAD`, { stdio: 'pipe' });
    } catch (err: any) {
      // Branch might already exist; try without -b
      try {
        execSync(`git -C "${this.baseDir}" worktree add "${wsPath}" "${branchName}"`, { stdio: 'pipe' });
      } catch {
        // Fall back to plain workspace
        return this.createPlainWorkspace(wsPath, id);
      }
    }

    // Create shared context dir and output dir in workspace
    mkdirSync(join(wsPath, '.agent-factory', 'shared'), { recursive: true });
    mkdirSync(join(wsPath, 'output'), { recursive: true });

    return {
      path: wsPath,
      type: 'pipeline',
      id,
      isGitWorktree: true,
      branchName,
    };
  }

  private createPlainWorkspace(wsPath: string, id: string): WorkspaceInfo {
    mkdirSync(wsPath, { recursive: true });
    mkdirSync(join(wsPath, '.agent-factory', 'shared'), { recursive: true });
    mkdirSync(join(wsPath, 'output'), { recursive: true });

    return {
      path: wsPath,
      type: 'pipeline',
      id,
      isGitWorktree: false,
    };
  }
}

export interface WorkspaceInfo {
  path: string;
  type: 'pipeline' | 'task';
  id: string;
  isGitWorktree: boolean;
  branchName?: string;
}

// Singleton
export const workspaceManager = new WorkspaceManager();
