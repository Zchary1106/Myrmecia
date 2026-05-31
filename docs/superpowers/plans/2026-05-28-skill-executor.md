# Skill Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the passive markdown skill system into an active step-driven execution framework that matches tasks to skills via LLM, executes step-by-step, and validates each step with shell commands.

**Architecture:** A `SkillExecutor` service intercepts execution in `TsAgentLoop` when a structured skill (YAML frontmatter with `executor: step-driven`) is resolved. It iterates through defined steps, calling the LLM per step with scoped instructions/tools, then runs a validation command. A `SkillMatcher` uses LLM to select the best skill for a task when no explicit assignment exists.

**Tech Stack:** TypeScript, OpenAI-compatible API (existing client), `yaml` package (already in deps), `child_process.exec` for validation commands.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/shared/src/index.ts` | Add `SkillStep`, `SkillExecutorConfig` interfaces |
| `packages/server/src/skills/skill-parser.ts` | Parse YAML frontmatter from skill content, extract steps |
| `packages/server/src/skills/skill-matcher.ts` | LLM-based semantic matching of task → skill |
| `packages/server/src/skills/skill-executor.ts` | Step-level execution loop with retry logic |
| `packages/server/src/skills/step-validator.ts` | Run validation shell commands, report pass/fail |
| `packages/server/src/agents/ts-agent-loop.ts` | Integration point: delegate to SkillExecutor when structured skill detected |
| `packages/server/tests/skill-executor.test.ts` | Unit tests for executor, parser, validator, matcher |
| `agents/dev.md` | Upgrade with YAML frontmatter as example structured skill |

---

### Task 1: Shared Types

**Files:**
- Modify: `packages/shared/src/index.ts:45-84`

- [ ] **Step 1: Write the new interfaces**

Add after line 84 (`SkillDetail` interface) in `packages/shared/src/index.ts`:

```typescript
export interface SkillStepValidation {
  /** Shell command to run. Supports ${workdir}, ${output}, ${stepName} variables */
  command: string;
  /** Message shown on validation failure */
  failMessage?: string;
}

export interface SkillStep {
  name: string;
  instruction: string;
  tools?: string[];
  maxTurns?: number;
  maxRetries?: number;
  validation?: SkillStepValidation;
}

export interface SkillExecutorConfig {
  executor: 'step-driven';
  trigger?: {
    keywords?: string[];
    taskModes?: string[];
    agentRoles?: string[];
  };
  steps: SkillStep[];
  recovery?: {
    onStepFailure?: 'retry_then_skip' | 'retry_then_fail' | 'skip' | 'fail';
    maxTotalRetries?: number;
  };
}
```

- [ ] **Step 2: Build to verify types compile**

Run: `pnpm --filter @agent-factory/shared build`
Expected: Clean build, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): add SkillStep and SkillExecutorConfig types"
```

---

### Task 2: Skill Parser

**Files:**
- Create: `packages/server/src/skills/skill-parser.ts`
- Create: `packages/server/tests/skill-executor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/skill-executor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseSkillContent } from '../src/skills/skill-parser.js';

describe('skill-parser', () => {
  it('parses YAML frontmatter with steps into SkillExecutorConfig', () => {
    const content = `---
executor: step-driven
trigger:
  keywords: ["implement", "feature"]
  taskModes: ["direct"]
steps:
  - name: analyze
    instruction: "Analyze requirements"
    tools: [file_read]
    maxTurns: 3
    validation:
      command: "test -n '\${output}'"
      failMessage: "Output must not be empty"
  - name: implement
    instruction: "Write code"
    tools: [file_write, shell_exec]
    maxTurns: 10
    maxRetries: 3
    validation:
      command: "cd \${workdir} && pnpm test"
recovery:
  onStepFailure: retry_then_fail
  maxTotalRetries: 5
---

# Dev Skill

You are a developer...`;

    const result = parseSkillContent(content);
    expect(result.isStructured).toBe(true);
    expect(result.config!.executor).toBe('step-driven');
    expect(result.config!.steps).toHaveLength(2);
    expect(result.config!.steps[0].name).toBe('analyze');
    expect(result.config!.steps[0].validation!.command).toBe("test -n '${output}'");
    expect(result.config!.steps[1].maxRetries).toBe(3);
    expect(result.config!.recovery!.onStepFailure).toBe('retry_then_fail');
    expect(result.promptContent).toContain('# Dev Skill');
    expect(result.promptContent).not.toContain('executor: step-driven');
  });

  it('returns isStructured=false for plain markdown skills', () => {
    const content = `# Simple Skill\n\nYou are an agent...`;
    const result = parseSkillContent(content);
    expect(result.isStructured).toBe(false);
    expect(result.config).toBeUndefined();
    expect(result.promptContent).toBe(content);
  });

  it('returns isStructured=false for frontmatter without executor field', () => {
    const content = `---\ntitle: Not a structured skill\n---\n\n# Skill`;
    const result = parseSkillContent(content);
    expect(result.isStructured).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-factory/server exec vitest run tests/skill-executor.test.ts -t "skill-parser"`
Expected: FAIL — cannot resolve `../src/skills/skill-parser.js`

- [ ] **Step 3: Implement the parser**

Create `packages/server/src/skills/skill-parser.ts`:

```typescript
import { parse as parseYaml } from 'yaml';
import type { SkillExecutorConfig, SkillStep } from '../types.js';

export interface ParsedSkill {
  isStructured: boolean;
  config?: SkillExecutorConfig;
  promptContent: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseSkillContent(content: string): ParsedSkill {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { isStructured: false, promptContent: content };
  }

  const [, yamlStr, markdownBody] = match;
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseYaml(yamlStr);
  } catch {
    return { isStructured: false, promptContent: content };
  }

  if (!frontmatter || frontmatter.executor !== 'step-driven') {
    return { isStructured: false, promptContent: markdownBody.trim() || content };
  }

  const steps: SkillStep[] = (frontmatter.steps as any[] || []).map(s => ({
    name: s.name,
    instruction: s.instruction,
    tools: s.tools,
    maxTurns: s.maxTurns,
    maxRetries: s.maxRetries,
    validation: s.validation ? {
      command: s.validation.command,
      failMessage: s.validation.failMessage,
    } : undefined,
  }));

  const config: SkillExecutorConfig = {
    executor: 'step-driven',
    trigger: frontmatter.trigger as SkillExecutorConfig['trigger'],
    steps,
    recovery: frontmatter.recovery as SkillExecutorConfig['recovery'],
  };

  return {
    isStructured: true,
    config,
    promptContent: markdownBody.trim(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-factory/server exec vitest run tests/skill-executor.test.ts -t "skill-parser"`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/skills/skill-parser.ts packages/server/tests/skill-executor.test.ts
git commit -m "feat(skills): add skill content parser with YAML frontmatter support"
```

---

### Task 3: Step Validator

**Files:**
- Create: `packages/server/src/skills/step-validator.ts`
- Modify: `packages/server/tests/skill-executor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/tests/skill-executor.test.ts`:

```typescript
import { validateStep } from '../src/skills/step-validator.js';

describe('step-validator', () => {
  it('returns pass=true when command exits 0', async () => {
    const result = await validateStep({
      command: 'echo "hello"',
      workdir: '/tmp',
      output: 'test output',
      stepName: 'test-step',
    });
    expect(result.pass).toBe(true);
    expect(result.stdout).toContain('hello');
  });

  it('returns pass=false when command exits non-zero', async () => {
    const result = await validateStep({
      command: 'exit 1',
      workdir: '/tmp',
      output: '',
      stepName: 'test-step',
    });
    expect(result.pass).toBe(false);
  });

  it('substitutes ${workdir}, ${output}, ${stepName} variables', async () => {
    const result = await validateStep({
      command: 'echo "${workdir} ${stepName}"',
      workdir: '/my/path',
      output: 'some output',
      stepName: 'analyze',
    });
    expect(result.pass).toBe(true);
    expect(result.stdout).toContain('/my/path analyze');
  });

  it('returns pass=false on timeout', async () => {
    const result = await validateStep({
      command: 'sleep 10',
      workdir: '/tmp',
      output: '',
      stepName: 'slow',
      timeoutMs: 100,
    });
    expect(result.pass).toBe(false);
    expect(result.error).toContain('timeout');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-factory/server exec vitest run tests/skill-executor.test.ts -t "step-validator"`
Expected: FAIL — cannot resolve `../src/skills/step-validator.js`

- [ ] **Step 3: Implement the validator**

Create `packages/server/src/skills/step-validator.ts`:

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

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

function substituteVars(command: string, vars: Record<string, string>): string {
  let result = command;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`\${${key}}`, value);
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
    const { stdout, stderr } = await execAsync(command, {
      cwd: input.workdir,
      timeout: timeoutMs,
      shell: '/bin/bash',
      encoding: 'utf-8',
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-factory/server exec vitest run tests/skill-executor.test.ts -t "step-validator"`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/skills/step-validator.ts packages/server/tests/skill-executor.test.ts
git commit -m "feat(skills): add step validator with variable substitution and timeout"
```

---

### Task 4: Skill Matcher (LLM-based)

**Files:**
- Create: `packages/server/src/skills/skill-matcher.ts`
- Modify: `packages/server/tests/skill-executor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/tests/skill-executor.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildMatcherPrompt, parseMatcherResponse } from '../src/skills/skill-matcher.js';

describe('skill-matcher', () => {
  it('builds a prompt listing available skills for the LLM to choose from', () => {
    const skills = [
      { id: 'dev', name: 'TDD Dev Skill', description: 'Test-driven development', trigger: { keywords: ['implement'], agentRoles: ['developer'] } },
      { id: 'review', name: 'Code Review', description: 'Review code for bugs', trigger: { keywords: ['review'], agentRoles: ['reviewer'] } },
    ];
    const prompt = buildMatcherPrompt('Implement a login feature', skills);
    expect(prompt).toContain('TDD Dev Skill');
    expect(prompt).toContain('Code Review');
    expect(prompt).toContain('Implement a login feature');
  });

  it('parses a valid LLM response with skill ID', () => {
    const result = parseMatcherResponse('{"skillId": "dev", "confidence": 0.9, "reason": "task involves implementation"}');
    expect(result.skillId).toBe('dev');
    expect(result.confidence).toBe(0.9);
  });

  it('returns null skillId for "none" response', () => {
    const result = parseMatcherResponse('{"skillId": "none", "confidence": 0.1, "reason": "no match"}');
    expect(result.skillId).toBeNull();
  });

  it('handles malformed LLM response gracefully', () => {
    const result = parseMatcherResponse('I think dev skill is best');
    expect(result.skillId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-factory/server exec vitest run tests/skill-executor.test.ts -t "skill-matcher"`
Expected: FAIL — cannot resolve `../src/skills/skill-matcher.js`

- [ ] **Step 3: Implement the matcher**

Create `packages/server/src/skills/skill-matcher.ts`:

```typescript
import OpenAI from 'openai';
import { listSkills, getLatestPublishedSkillVersion } from '../db/models/skill.js';
import { parseSkillContent } from './skill-parser.js';
import { logger } from '../lib/logger.js';
import type { SkillExecutorConfig } from '../types.js';

export interface SkillCandidate {
  id: string;
  name: string;
  description?: string;
  trigger?: SkillExecutorConfig['trigger'];
}

export interface MatchResult {
  skillId: string | null;
  confidence: number;
  reason?: string;
}

export function buildMatcherPrompt(taskInput: string, skills: SkillCandidate[]): string {
  const skillList = skills.map((s, i) =>
    `${i + 1}. ID: "${s.id}" | Name: "${s.name}" | Description: ${s.description || 'N/A'} | Keywords: ${s.trigger?.keywords?.join(', ') || 'N/A'} | Roles: ${s.trigger?.agentRoles?.join(', ') || 'any'}`
  ).join('\n');

  return `You are a skill matcher. Given a task description and available skills, select the BEST matching skill.

## Available Skills:
${skillList}

## Task:
${taskInput}

## Instructions:
- If a skill clearly matches the task, return its ID with high confidence.
- If no skill is a good fit, return "none".
- Respond with ONLY valid JSON: {"skillId": "<id or none>", "confidence": <0.0-1.0>, "reason": "<brief reason>"}`;
}

export function parseMatcherResponse(response: string): MatchResult {
  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return { skillId: null, confidence: 0 };

    const parsed = JSON.parse(jsonMatch[0]);
    const skillId = parsed.skillId === 'none' ? null : (parsed.skillId || null);
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    return { skillId, confidence, reason: parsed.reason };
  } catch {
    return { skillId: null, confidence: 0 };
  }
}

/**
 * Match a task to the best available structured skill using LLM.
 * Returns the skill ID or null if no good match.
 */
export async function matchSkillForTask(
  taskInput: string,
  agentRole?: string,
): Promise<MatchResult> {
  // Gather all published skills that have structured executor config
  const allSkills = listSkills();
  const candidates: SkillCandidate[] = [];

  for (const skill of allSkills) {
    const version = getLatestPublishedSkillVersion(skill.id);
    if (!version) continue;
    const parsed = parseSkillContent(version.content);
    if (!parsed.isStructured) continue;

    // Filter by agent role if specified in trigger
    const trigger = parsed.config!.trigger;
    if (trigger?.agentRoles && agentRole && !trigger.agentRoles.includes(agentRole)) {
      continue;
    }

    candidates.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      trigger,
    });
  }

  if (candidates.length === 0) {
    return { skillId: null, confidence: 0, reason: 'No structured skills available' };
  }

  // Call LLM to select
  try {
    const client = new OpenAI({
      baseURL: process.env.AGENT_FACTORY_BASE_URL || 'https://morninglab.japaneast.cloudapp.azure.com/v1',
      apiKey: process.env.AGENT_FACTORY_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    });

    const prompt = buildMatcherPrompt(taskInput, candidates);
    const response = await client.chat.completions.create({
      model: process.env.AGENT_FACTORY_MODEL || 'gpt-5.4-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 200,
    });

    const content = response.choices[0]?.message?.content || '';
    return parseMatcherResponse(content);
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Skill matcher LLM call failed');
    return { skillId: null, confidence: 0, reason: `LLM error: ${err.message}` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-factory/server exec vitest run tests/skill-executor.test.ts -t "skill-matcher"`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/skills/skill-matcher.ts packages/server/tests/skill-executor.test.ts
git commit -m "feat(skills): add LLM-based skill matcher with prompt builder and response parser"
```

---

### Task 5: Skill Executor Core

**Files:**
- Create: `packages/server/src/skills/skill-executor.ts`
- Modify: `packages/server/tests/skill-executor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/tests/skill-executor.test.ts`:

```typescript
import { SkillExecutor } from '../src/skills/skill-executor.js';
import type { SkillExecutorConfig, SkillStep } from '@agent-factory/shared';

describe('skill-executor', () => {
  const mockConfig: SkillExecutorConfig = {
    executor: 'step-driven',
    steps: [
      { name: 'analyze', instruction: 'Analyze the code', maxTurns: 2, validation: { command: 'echo "ok"' } },
      { name: 'implement', instruction: 'Write code', maxTurns: 3, maxRetries: 1, validation: { command: 'echo "done"' } },
    ],
    recovery: { onStepFailure: 'retry_then_fail', maxTotalRetries: 3 },
  };

  it('executes all steps in sequence and returns combined output', async () => {
    const mockLlmCall = vi.fn()
      .mockResolvedValueOnce('Analysis: need to change file A')
      .mockResolvedValueOnce('Implementation complete');

    const executor = new SkillExecutor({
      config: mockConfig,
      promptContent: 'You are a dev',
      workdir: '/tmp',
      llmCall: mockLlmCall,
    });

    const result = await executor.run('Build a login page');

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].name).toBe('analyze');
    expect(result.steps[0].status).toBe('done');
    expect(result.steps[0].output).toBe('Analysis: need to change file A');
    expect(result.steps[1].name).toBe('implement');
    expect(result.steps[1].status).toBe('done');
    expect(mockLlmCall).toHaveBeenCalledTimes(2);
  });

  it('retries a step when validation fails', async () => {
    const failConfig: SkillExecutorConfig = {
      executor: 'step-driven',
      steps: [
        { name: 'code', instruction: 'Write code', maxTurns: 2, maxRetries: 2,
          validation: { command: 'exit 1', failMessage: 'Tests fail' } },
      ],
      recovery: { onStepFailure: 'retry_then_fail', maxTotalRetries: 5 },
    };

    let callCount = 0;
    const mockLlmCall = vi.fn().mockImplementation(async () => {
      callCount++;
      return `Attempt ${callCount}`;
    });

    const executor = new SkillExecutor({
      config: failConfig,
      promptContent: 'You are a dev',
      workdir: '/tmp',
      llmCall: mockLlmCall,
    });

    const result = await executor.run('Fix the bug');

    expect(result.success).toBe(false);
    // 1 initial + 2 retries = 3 calls
    expect(mockLlmCall).toHaveBeenCalledTimes(3);
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].retries).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-factory/server exec vitest run tests/skill-executor.test.ts -t "skill-executor"`
Expected: FAIL — cannot resolve `../src/skills/skill-executor.js`

- [ ] **Step 3: Implement the executor**

Create `packages/server/src/skills/skill-executor.ts`:

```typescript
import { validateStep } from './step-validator.js';
import { logger } from '../lib/logger.js';
import type { SkillExecutorConfig, SkillStep } from '../types.js';

export type LlmCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

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

        // Build step prompt
        const systemPrompt = this.buildStepSystemPrompt(step, previousOutputs);
        const userPrompt = attempt === 0
          ? `Task: ${taskInput}\n\nStep "${step.name}": ${step.instruction}`
          : `Task: ${taskInput}\n\nStep "${step.name}" (retry ${attempt}): ${step.instruction}\n\nPrevious attempt failed: ${lastError}\nPlease fix the issue and try again.`;

        // Call LLM
        lastOutput = await this.llmCall(systemPrompt, userPrompt);

        // Validate if command defined
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
          // No validation = auto-pass
          passed = true;
          break;
        }
      }

      if (passed) {
        steps.push({ name: step.name, status: 'done', output: lastOutput, retries });
        previousOutputs.push(`[${step.name}]: ${lastOutput}`);
        this.onStepDone?.(i, step, lastOutput);
      } else {
        const errorMsg = `Step "${step.name}" failed after ${retries} retries: ${lastError}`;
        steps.push({ name: step.name, status: 'failed', output: lastOutput, retries, error: errorMsg });
        this.onStepFailed?.(i, step, errorMsg);

        if (failurePolicy === 'fail' || failurePolicy === 'retry_then_fail') {
          // Stop execution
          break;
        }
        // 'skip' or 'retry_then_skip' — continue to next step
        previousOutputs.push(`[${step.name}]: SKIPPED - ${lastError}`);
      }
    }

    const allDone = steps.every(s => s.status === 'done' || s.status === 'skipped');
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-factory/server exec vitest run tests/skill-executor.test.ts -t "skill-executor"`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/skills/skill-executor.ts packages/server/tests/skill-executor.test.ts
git commit -m "feat(skills): add SkillExecutor with step-level execution and retry logic"
```

---

### Task 6: Integrate into TsAgentLoop

**Files:**
- Modify: `packages/server/src/agents/ts-agent-loop.ts`

- [ ] **Step 1: Add imports at top of ts-agent-loop.ts**

Add after existing imports:

```typescript
import { parseSkillContent } from '../skills/skill-parser.js';
import { SkillExecutor } from '../skills/skill-executor.js';
import { matchSkillForTask } from '../skills/skill-matcher.js';
import { getLatestPublishedSkillVersion } from '../db/models/skill.js';
```

- [ ] **Step 2: Add skill execution detection in the `execute` method**

In `ts-agent-loop.ts`, inside the `execute` method, after `buildSystemPrompt` and before the LLM call span creation, add the structured skill check. Find the line:

```typescript
    const systemPrompt = buildSystemPrompt(agent, toolPolicy, runtimeSkill);
```

After it, add:

```typescript
    // Check if the resolved skill is structured (step-driven)
    const parsedSkill = runtimeSkill
      ? parseSkillContent(runtimeSkill.version.content)
      : null;

    if (parsedSkill?.isStructured && parsedSkill.config) {
      // Delegate to SkillExecutor for step-driven execution
      return this.executeWithSkillExecutor(
        agent, task, abortController, executionId, traceId, rootSpanId,
        tracker, parsedSkill, toolPolicy, systemPrompt,
      );
    }
```

- [ ] **Step 3: Add the `executeWithSkillExecutor` private method**

Add as a new method on the `TsAgentLoop` class:

```typescript
  private async executeWithSkillExecutor(
    agent: AgentDefinition,
    task: Task,
    abortController: AbortController,
    executionId: string,
    traceId: string,
    rootSpanId: string,
    tracker: ProgressTracker,
    parsedSkill: { config: SkillExecutorConfig; promptContent: string },
    toolPolicy: ReturnType<typeof resolveAllowedToolsForAgent>,
    systemPrompt: string,
  ): Promise<TaskResult> {
    const startTime = Date.now();
    const client = this.getClient();
    const modelSelection = selectModelForAgent(agent);
    const selectedModel = modelSelection.modelId;

    addTaskLog(task.id, 'info', `Skill Executor: ${parsedSkill.config.steps.length} steps`, 'system');

    // LLM call function for the executor
    const llmCall = async (stepSystemPrompt: string, userPrompt: string): Promise<string> => {
      if (abortController.signal.aborted) throw new Error('Execution aborted');

      const response = await client.chat.completions.create({
        model: selectedModel,
        messages: [
          { role: 'system', content: stepSystemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 4096,
      });

      const content = response.choices[0]?.message?.content || '';
      tracker.cumulativeOutputTokens += response.usage?.completion_tokens || 0;
      tracker.latestInputTokens = response.usage?.prompt_tokens || 0;
      return content;
    };

    const executor = new SkillExecutor({
      config: parsedSkill.config,
      promptContent: parsedSkill.promptContent || systemPrompt,
      workdir: task.workdir || process.cwd(),
      llmCall,
      abortSignal: abortController.signal,
      onStepStart: (idx, step) => {
        const span = createTraceSpan({
          traceId, parentSpanId: rootSpanId,
          type: 'skill.step', name: `Step: ${step.name}`,
          metadata: { stepIndex: idx, instruction: step.instruction.slice(0, 200) },
        });
        addTaskLog(task.id, 'info', `▶ Step ${idx + 1}/${parsedSkill.config.steps.length}: ${step.name}`, agent.id);
        addExecutionMessage({ executionId, type: 'progress', content: `Starting step: ${step.name}` });
        eventBus.emit('execution:progress', {
          executionId, taskId: task.id, agentDefId: agent.id,
          progress: { ...getProgressSnapshot(tracker), summary: `Step: ${step.name}` },
        });
      },
      onStepDone: (idx, step, output) => {
        addTaskLog(task.id, 'info', `✓ Step "${step.name}" done`, agent.id);
        addExecutionMessage({ executionId, type: 'agent_text', content: output.slice(0, 500) });
      },
      onStepFailed: (idx, step, error) => {
        addTaskLog(task.id, 'warn', `✗ Step "${step.name}" failed: ${error}`, agent.id);
      },
    });

    const result = await executor.run(task.input);

    const durationMs = Date.now() - startTime;
    const costUSD = estimateCost(selectedModel, tracker.latestInputTokens, tracker.cumulativeOutputTokens);

    recordModelUsage({
      modelId: selectedModel,
      agentId: agent.id,
      taskId: task.id,
      executionId,
      status: result.success ? 'success' : 'failed',
      inputTokens: tracker.latestInputTokens,
      outputTokens: tracker.cumulativeOutputTokens,
      costUSD,
      latencyMs: durationMs,
      routeReason: `skill-executor: ${parsedSkill.config.steps.length} steps`,
    });

    if (!result.success) {
      const failedStep = result.steps.find(s => s.status === 'failed');
      throw new Error(`Skill execution failed at step "${failedStep?.name}": ${failedStep?.error}`);
    }

    return {
      output: result.finalOutput,
      costUSD,
      inputTokens: tracker.latestInputTokens,
      outputTokens: tracker.cumulativeOutputTokens,
      durationMs,
      numTurns: result.steps.length,
      executionId,
    };
  }
```

- [ ] **Step 4: Add missing import for SkillExecutorConfig type**

Add to the import from `../types.js`:

```typescript
import type { SkillExecutorConfig } from '../types.js';
```

(Or ensure it's exported from the shared types and re-exported in server's types.ts)

- [ ] **Step 5: Build to verify compilation**

Run: `pnpm --filter @agent-factory/server build`
Expected: Clean build (or pre-existing errors only, no new errors from this change)

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/agents/ts-agent-loop.ts
git commit -m "feat(agents): integrate SkillExecutor into TsAgentLoop for step-driven skills"
```

---

### Task 7: Upgrade dev.md with YAML Frontmatter

**Files:**
- Modify: `agents/dev.md`

- [ ] **Step 1: Add YAML frontmatter to dev.md**

Prepend to `agents/dev.md`:

```markdown
---
executor: step-driven
trigger:
  keywords: ["implement", "feature", "build", "create", "add", "code"]
  taskModes: ["direct"]
  agentRoles: ["developer"]
steps:
  - name: analyze
    instruction: "Analyze the task requirements. Identify which files need to be created or modified. List the public interfaces/APIs that will be affected. Output a brief plan."
    tools: [file_read, grep]
    maxTurns: 3
    validation:
      command: "test -n '${output}'"
      failMessage: "Analysis output must not be empty"
  - name: write_tests
    instruction: "Based on the analysis, write failing test cases that define the expected behavior. Tests should be specific and cover edge cases."
    tools: [file_write, shell_exec]
    maxTurns: 5
    validation:
      command: "cd ${workdir} && pnpm test 2>&1 | grep -qE '(FAIL|fail|Error)'"
      failMessage: "Tests should fail initially (TDD red phase)"
    maxRetries: 2
  - name: implement
    instruction: "Write the minimal implementation code to make all tests pass. Follow existing project conventions. No over-engineering."
    tools: [file_write, file_read, shell_exec]
    maxTurns: 10
    validation:
      command: "cd ${workdir} && pnpm test"
      failMessage: "Tests must pass"
    maxRetries: 3
  - name: refactor
    instruction: "Clean up the implementation. Remove duplication, improve naming, ensure code is readable. Tests must still pass after refactoring."
    tools: [file_write, shell_exec]
    maxTurns: 5
    validation:
      command: "cd ${workdir} && pnpm test"
      failMessage: "Tests must still pass after refactoring"
recovery:
  onStepFailure: retry_then_fail
  maxTotalRetries: 8
---

```

Keep the existing markdown content below the frontmatter unchanged.

- [ ] **Step 2: Verify the file is valid by running the parser against it**

Run: `pnpm --filter @agent-factory/server exec vitest run tests/skill-executor.test.ts`
Expected: All existing tests still pass (parser handles real-world content)

- [ ] **Step 3: Commit**

```bash
git add agents/dev.md
git commit -m "feat(agents): upgrade dev.md with step-driven TDD skill definition"
```

---

### Task 8: Re-export Types from Server Package

**Files:**
- Modify: `packages/server/src/types.ts` (or wherever server re-exports shared types)

- [ ] **Step 1: Check current re-export pattern**

Run: `grep -n "from.*shared" packages/server/src/types.ts | head`

If `types.ts` re-exports from `@agent-factory/shared`, add:

```typescript
export type { SkillStep, SkillStepValidation, SkillExecutorConfig } from '@agent-factory/shared';
```

If instead it duplicates types, add the interfaces directly (same as in Task 1).

- [ ] **Step 2: Build**

Run: `pnpm --filter @agent-factory/server build`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/types.ts
git commit -m "feat(server): re-export SkillExecutorConfig types from shared"
```

---

### Task 9: Integration Test (End-to-End)

**Files:**
- Modify: `packages/server/tests/skill-executor.test.ts`

- [ ] **Step 1: Add integration test**

Append to `packages/server/tests/skill-executor.test.ts`:

```typescript
import { parseSkillContent } from '../src/skills/skill-parser.js';
import { SkillExecutor } from '../src/skills/skill-executor.js';

describe('skill-executor integration', () => {
  it('parses a real skill file and executes steps with mock LLM', async () => {
    const skillContent = `---
executor: step-driven
steps:
  - name: plan
    instruction: "Create a plan"
    maxTurns: 1
    validation:
      command: "test -n '\${output}'"
  - name: execute
    instruction: "Execute the plan"
    maxTurns: 1
    validation:
      command: "echo done"
---

# Test Skill

You are a test agent.`;

    const parsed = parseSkillContent(skillContent);
    expect(parsed.isStructured).toBe(true);

    const mockLlm = vi.fn()
      .mockResolvedValueOnce('Plan: do X then Y')
      .mockResolvedValueOnce('Executed X and Y successfully');

    const executor = new SkillExecutor({
      config: parsed.config!,
      promptContent: parsed.promptContent,
      workdir: '/tmp',
      llmCall: mockLlm,
    });

    const result = await executor.run('Build something');
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.finalOutput).toContain('Plan: do X then Y');
    expect(result.finalOutput).toContain('Executed X and Y successfully');
  });
});
```

- [ ] **Step 2: Run full test suite**

Run: `pnpm --filter @agent-factory/server exec vitest run tests/skill-executor.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/server/tests/skill-executor.test.ts
git commit -m "test(skills): add end-to-end integration test for skill executor"
```

---

## Summary

| Task | Component | Est. Time |
|------|-----------|-----------|
| 1 | Shared types | 2 min |
| 2 | Skill parser | 5 min |
| 3 | Step validator | 5 min |
| 4 | Skill matcher (LLM) | 5 min |
| 5 | Skill executor core | 8 min |
| 6 | TsAgentLoop integration | 8 min |
| 7 | dev.md upgrade | 2 min |
| 8 | Type re-exports | 2 min |
| 9 | Integration test | 3 min |
| **Total** | | **~40 min** |
