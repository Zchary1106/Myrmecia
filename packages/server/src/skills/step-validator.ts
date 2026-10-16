import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'fs';
import { join, relative } from 'path';
import { assertShellCommandAllowed } from './tool-sandbox.js';
import { parseVerificationCommand } from '@myrmecia/shared';

const execAsync = promisify(exec);

/** POSIX single-quote escaping — makes backticks, $, spaces, and quotes literal. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ValidateStepInput {
  command: string;
  workdir: string;
  output: string;
  stepName: string;
  timeoutMs?: number;
  /** Trusted operator-submitted test criterion, not an LLM-generated command. */
  testCommand?: string;
}

export interface ValidateStepResult {
  pass: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: number;
}

const ENV_NAMES: Record<string, string> = {
  output: 'STEP_OUTPUT',
  workdir: 'STEP_WORKDIR',
  stepName: 'STEP_NAME',
};

const TEST_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.agent-factory', 'coverage', '.next', 'out']);

function collectTestFiles(dir: string, pattern: RegExp, depth: number, acc: string[]): void {
  if (depth > 4 || acc.length >= 50) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (acc.length >= 50) return;
    if (name.startsWith('.') && name !== '.') continue;
    if (TEST_SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      collectTestFiles(full, pattern, depth + 1, acc);
    } else if (pattern.test(name)) {
      acc.push(full);
    }
  }
}

/**
 * Best-effort detection of the command that runs a workspace's tests. Resolution
 * order:
 *   1. An explicit, non-placeholder `scripts.test` in package.json (pnpm/yarn/npm).
 *   2. Standalone `*.test.ts/js` files discovered under the workspace, run with
 *      Node's built-in test runner (tsx loader for TypeScript).
 *   3. A known Python/Go/Rust project's test runner.
 *   4. Unavailable: no check can be fabricated from missing/scopeless tests.
 *
 * The returned string never contains `$(...)`/backticks, so it stays within the
 * shell-command allow-list used by validateStep.
 */
export function resolveTestCommand(workdir: string): string {
  const isMonorepoRoot =
    existsSync(join(workdir, 'pnpm-workspace.yaml')) ||
    existsSync(join(workdir, 'lerna.json'));
  const pkgPath = join(workdir, 'package.json');
  let workspacePackages = isMonorepoRoot;
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      workspacePackages ||= Array.isArray(pkg?.workspaces) || !!pkg?.workspaces?.packages;
      const testScript = pkg?.scripts?.test;
      if (typeof testScript === 'string' && testScript.trim() && !/no test specified/i.test(testScript)) {
        const runner = existsSync(join(workdir, 'pnpm-lock.yaml')) ? 'pnpm'
          : existsSync(join(workdir, 'yarn.lock')) ? 'yarn'
          : 'npm';
        return `${runner} test`;
      }
    } catch (error) {
      throw new Error('TEST_COMMAND_UNAVAILABLE: package.json could not be inspected; configure a project validation command', { cause: error });
    }
  }
  if (workspacePackages) throw new Error('TEST_COMMAND_UNAVAILABLE: monorepo has no root test script; select a package or submit a scoped validation command');
  if (existsSync(join(workdir, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(workdir, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(workdir, 'pytest.ini')) || existsSync(join(workdir, 'pyproject.toml'))
    || existsSync(join(workdir, 'setup.cfg'))) return 'python -m pytest';

  const tsTests: string[] = [];
  collectTestFiles(workdir, /\.test\.(ts|tsx|mts|cts)$/, 0, tsTests);
  if (tsTests.length) {
    return `node --import tsx --test ${tsTests.map(f => shellQuote(relative(workdir, f))).join(' ')}`;
  }

  const jsTests: string[] = [];
  collectTestFiles(workdir, /\.test\.(js|mjs|cjs|jsx)$/, 0, jsTests);
  if (jsTests.length) {
    return `node --test ${jsTests.map(f => shellQuote(relative(workdir, f))).join(' ')}`;
  }

  throw new Error('TEST_COMMAND_UNAVAILABLE: no real test script or supported tests found; configure tests before accepting delivery');
}

function substituteVars(command: string, vars: Record<string, string>): string {
  let result = command;
  for (const key of Object.keys(vars)) {
    const envName = ENV_NAMES[key];
    if (envName) {
      // Replace ${key} — and any quotes the skill author wrapped around it —
      // with a safely double-quoted shell env reference. The real value is
      // passed via the environment (see validateStep), so arbitrary model
      // output (newlines, quotes, $(...), backticks) can neither break the
      // command nor inject into the shell.
      const re = new RegExp(`['"]?\\$\\{${key}\\}['"]?`, 'g');
      result = result.replace(re, () => `"$${envName}"`);
    } else {
      result = result.replaceAll(`\${${key}}`, vars[key]);
    }
  }
  return result;
}

export async function validateStep(input: ValidateStepInput): Promise<ValidateStepResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;

  const vars: Record<string, string> = {
    workdir: input.workdir,
    output: input.output,
    stepName: input.stepName,
  };
  // Resolve the workspace test command lazily — only when referenced — so we
  // don't scan the filesystem for steps that don't need it.
  try {
    if (input.command.includes('${testCmd}')) {
      if (input.testCommand) {
        const submitted = parseVerificationCommand(input.testCommand);
        if (!submitted || submitted.kind !== 'test') throw new Error('TEST_COMMAND_DENIED: override must be an operator-submitted bounded test command');
        vars.testCmd = submitted.shellCommand;
      } else vars.testCmd = resolveTestCommand(input.workdir);
    }
    const command = substituteVars(input.command, vars);
    assertShellCommandAllowed(command);
    const { stdout, stderr } = await execAsync(command, {
      cwd: input.workdir,
      timeout: timeoutMs,
      shell: '/bin/bash',
      encoding: 'utf-8',
      env: {
        ...process.env,
        STEP_OUTPUT: input.output,
        STEP_WORKDIR: input.workdir,
        STEP_NAME: input.stepName,
      },
    });
    return { pass: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: any) {
    if (err.killed) {
      return { pass: false, error: `Validation timeout after ${timeoutMs}ms`, exitCode: null as any };
    }
    return {
      pass: false,
      stdout: err.stdout?.trim(),
      stderr: err.stderr?.trim(),
      error: err.message,
      exitCode: err.code,
    };
  }
}
