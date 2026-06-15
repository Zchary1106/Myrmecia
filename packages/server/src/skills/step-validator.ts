import { exec } from 'child_process';
import { promisify } from 'util';
import { assertShellCommandAllowed } from './tool-sandbox.js';

const execAsync = promisify(exec);

export interface ValidateStepInput {
  command: string;
  workdir: string;
  output: string;
  stepName: string;
  timeoutMs?: number;
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

  const command = substituteVars(input.command, {
    workdir: input.workdir,
    output: input.output,
    stepName: input.stepName,
  });

  try {
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
