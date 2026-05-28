import { describe, it, expect } from 'vitest';
import { parseSkillContent } from '../src/skills/skill-parser.js';
import { validateStep } from '../src/skills/step-validator.js';

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
      workdir: '/tmp',
      output: 'some output',
      stepName: 'analyze',
    });
    expect(result.pass).toBe(true);
    expect(result.stdout).toContain('/tmp analyze');
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
