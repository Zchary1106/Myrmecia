import { describe, it, expect } from 'vitest';
import { parseSkillContent } from '../src/skills/skill-parser.js';
import { validateStep } from '../src/skills/step-validator.js';
import { buildMatcherPrompt, parseMatcherResponse } from '../src/skills/skill-matcher.js';

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
