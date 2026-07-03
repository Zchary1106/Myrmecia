import { validateStep } from './step-validator.js';
import { logger } from '../lib/logger.js';
import type { SkillExecutorConfig, SkillStep } from '../types.js';

export interface LlmCallOptions {
  maxTurns?: number;
  stepName?: string;
}

export type LlmCallFn = (
  systemPrompt: string,
  userPrompt: string,
  allowedTools?: string[],
  options?: LlmCallOptions,
) => Promise<string>;

export interface SkillExecutorOptions {
  config: SkillExecutorConfig;
  promptContent: string;
  workdir: string;
  llmCall: LlmCallFn;
  onStepStart?: (stepIndex: number, step: SkillStep) => void;
  onStepDone?: (stepIndex: number, step: SkillStep, output: string) => void;
  onStepFailed?: (stepIndex: number, step: SkillStep, error: string) => void;
  abortSignal?: AbortSignal;
}

export interface StepResult {
  name: string;
  status: 'done' | 'failed' | 'skipped';
  output?: string;
  retries: number;
  validationOutput?: string;
  error?: string;
}

export interface ExecutorResult {
  success: boolean;
  steps: StepResult[];
  finalOutput: string;
}

export class SkillExecutor {
  private config: SkillExecutorConfig;
  private promptContent: string;
  private workdir: string;
  private llmCall: LlmCallFn;
  private onStepStart?: SkillExecutorOptions['onStepStart'];
  private onStepDone?: SkillExecutorOptions['onStepDone'];
  private onStepFailed?: SkillExecutorOptions['onStepFailed'];
  private abortSignal?: AbortSignal;

  constructor(options: SkillExecutorOptions) {
    this.config = options.config;
    this.promptContent = options.promptContent;
    this.workdir = options.workdir;
    this.llmCall = options.llmCall;
    this.onStepStart = options.onStepStart;
    this.onStepDone = options.onStepDone;
    this.onStepFailed = options.onStepFailed;
    this.abortSignal = options.abortSignal;
  }

  async run(taskInput: string): Promise<ExecutorResult> {
    const steps: StepResult[] = [];
    let previousOutputs: string[] = [];
    let totalRetries = 0;
    const maxTotalRetries = this.config.recovery?.maxTotalRetries ?? 10;
    const failurePolicy = this.config.recovery?.onStepFailure ?? 'retry_then_fail';

    for (let i = 0; i < this.config.steps.length; i++) {
      if (this.abortSignal?.aborted) {
        steps.push({ name: this.config.steps[i].name, status: 'skipped', retries: 0 });
        continue;
      }

      const step = this.config.steps[i];
      this.onStepStart?.(i, step);

      const maxRetries = step.maxRetries ?? 0;
      let lastOutput = '';
      let lastError = '';
      let retries = 0;
      let passed = false;

      for (let attempt = 0; attempt <= maxRetries && totalRetries <= maxTotalRetries; attempt++) {
        if (attempt > 0) {
          retries++;
          totalRetries++;
        }

        const systemPrompt = this.buildStepSystemPrompt(step, previousOutputs);
        const userPrompt = attempt === 0
          ? `Task: ${taskInput}\n\nStep "${step.name}": ${step.instruction}`
          : `Task: ${taskInput}\n\nStep "${step.name}" (retry ${attempt}): ${step.instruction}\n\nPrevious attempt failed: ${lastError}\nPlease fix the issue and try again.`;

        lastOutput = await this.llmCall(systemPrompt, userPrompt, step.tools, {
          maxTurns: step.maxTurns,
          stepName: step.name,
        });

        if (step.validation) {
          const validationResult = await validateStep({
            command: step.validation.command,
            workdir: this.workdir,
            output: lastOutput,
            stepName: step.name,
          });

          if (validationResult.pass) {
            passed = true;
            break;
          } else {
            lastError = step.validation.failMessage
              || validationResult.error
              || validationResult.stderr
              || 'Validation failed';
          }
        } else {
          passed = true;
          break;
        }
      }

      if (passed) {
        steps.push({ name: step.name, status: 'done', output: lastOutput, retries });
        previousOutputs.push(`[${step.name}]: ${lastOutput}`);
        this.onStepDone?.(i, step, lastOutput);
      } else if (step.validation?.optional) {
        // Advisory (soft) gate: the validation did not pass, but the deliverable
        // is still accepted. Record the result and continue without failing the
        // task. Used for checks whose signal is useful but should not gate success
        // (e.g. running tests inside a shared repo worktree).
        const note = `validation advisory: ${lastError}`;
        logger.warn({ step: step.name, workdir: this.workdir, retries }, `Step "${step.name}" ${note}`);
        steps.push({ name: step.name, status: 'done', output: lastOutput, retries, validationOutput: lastError });
        previousOutputs.push(`[${step.name}]: ${lastOutput}\n(note: ${note})`);
        this.onStepDone?.(i, step, lastOutput);
      } else {
        const errorMsg = `Step "${step.name}" failed after ${retries} retries: ${lastError}`;
        steps.push({ name: step.name, status: 'failed', output: lastOutput, retries, error: errorMsg });
        this.onStepFailed?.(i, step, errorMsg);

        if (failurePolicy === 'fail' || failurePolicy === 'retry_then_fail') {
          break;
        }
        previousOutputs.push(`[${step.name}]: SKIPPED - ${lastError}`);
      }
    }

    const finalOutput = steps
      .filter(s => s.output)
      .map(s => `## ${s.name}\n${s.output}`)
      .join('\n\n');

    return {
      success: steps.every(s => s.status === 'done'),
      steps,
      finalOutput,
    };
  }

  private buildStepSystemPrompt(step: SkillStep, previousOutputs: string[]): string {
    const parts = [this.promptContent];

    if (step.tools?.length) {
      parts.push(`\n## Available Tools for this step: ${step.tools.join(', ')}`);
    }

    if (previousOutputs.length > 0) {
      parts.push(`\n## Previous Step Outputs:\n${previousOutputs.join('\n')}`);
    }

    return parts.join('\n');
  }
}
