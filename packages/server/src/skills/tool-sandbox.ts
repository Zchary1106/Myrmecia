/**
 * Sandboxed tool executor for the SkillExecutor.
 * Implements file_read, file_write, shell_exec, grep with workspace path confinement.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, normalize, dirname } from 'path';

const execAsync = promisify(exec);

export interface ToolResult {
  output: string;
  status: 'done' | 'failed';
}

/** Validate that a resolved path is within the workspace boundary */
function assertSafePath(workdir: string, inputPath: string): string {
  const resolved = resolve(workdir, inputPath);
  const normalized = normalize(resolved);
  if (!normalized.startsWith(normalize(workdir))) {
    throw new Error(`Path traversal blocked: "${inputPath}" resolves outside workspace`);
  }
  return resolved;
}

/** Block dangerous shell command patterns */
const BLOCKED_COMMANDS = /\b(rm\s+-rf\s+\/|sudo|chmod\s+777|curl.*\|\s*sh|wget.*\|\s*sh|eval|exec\s)/i;

/**
 * Execute a tool call within a sandboxed workspace context.
 * All file operations are confined to `workdir`.
 */
export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  workdir: string,
): Promise<ToolResult> {

  if (toolName === 'shell_exec') {
    try {
      const cmd = String(toolInput.command || toolInput.cmd || '');
      if (BLOCKED_COMMANDS.test(cmd)) {
        return { output: 'Blocked: dangerous command pattern detected', status: 'failed' };
      }
      const { stdout, stderr } = await execAsync(cmd, { cwd: workdir, timeout: 60_000, encoding: 'utf-8' });
      return { output: (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).slice(0, 8000), status: 'done' };
    } catch (err: any) {
      return { output: `Exit ${err.code}: ${(err.stdout || '') + (err.stderr || '')}`.slice(0, 4000), status: 'failed' };
    }
  }

  if (toolName === 'file_write') {
    try {
      const filePath = assertSafePath(workdir, String(toolInput.path || toolInput.file_path || ''));
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, String(toolInput.content || ''), 'utf-8');
      return { output: `Written: ${filePath}`, status: 'done' };
    } catch (err: any) {
      return { output: `Write failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'file_read') {
    try {
      const filePath = assertSafePath(workdir, String(toolInput.path || toolInput.file_path || ''));
      const content = readFileSync(filePath, 'utf-8');
      return { output: content.slice(0, 8000), status: 'done' };
    } catch (err: any) {
      return { output: `Read failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'grep' || toolName === 'search') {
    try {
      const pattern = String(toolInput.pattern || toolInput.query || '');
      const safePattern = pattern.replace(/["`$\\]/g, '');
      const { stdout } = await execAsync(
        `grep -rn "${safePattern}" . --include="*.ts" --include="*.tsx" --include="*.js" | head -30`,
        { cwd: workdir, encoding: 'utf-8', timeout: 10_000 },
      );
      return { output: stdout.slice(0, 4000) || 'No matches', status: 'done' };
    } catch (err: any) {
      return { output: err.stdout?.slice(0, 2000) || 'No matches', status: err.code === 1 ? 'done' : 'failed' };
    }
  }

  return { output: `Tool "${toolName}" is not available in skill executor sandbox.`, status: 'failed' };
}
