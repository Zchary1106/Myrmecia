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
