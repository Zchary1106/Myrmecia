import { BUILTIN_TOOLS } from '../tools/tool-registry.js';
import { scanForPII } from '../security/dlp.js';
import { assertShellCommandAllowed, isSandboxTool } from './tool-sandbox.js';
import { parseSkillContent } from './skill-parser.js';

export interface SkillReviewIssue {
  severity: 'block' | 'warn';
  code: string;
  message: string;
}

export interface SkillReviewResult {
  approved: boolean;
  issues: SkillReviewIssue[];
}

const MAX_IMPORTED_SKILL_CHARS = 100_000;

const PROMPT_INJECTION_PATTERNS: Array<{ code: string; regex: RegExp; message: string }> = [
  {
    code: 'ignore-instructions',
    regex: /\b(ignore|bypass|override)\b.{0,80}\b(previous|above|system|developer|safety|guardrail)\b.{0,40}\binstructions?\b/i,
    message: 'Skill content appears to override higher-priority runtime instructions.',
  },
  {
    code: 'reveal-system-prompt',
    regex: /\b(reveal|print|dump|show|expose)\b.{0,80}\b(system prompt|developer message|hidden instructions|secrets?)\b/i,
    message: 'Skill content asks the model to reveal hidden prompts or secrets.',
  },
  {
    code: 'exfiltration',
    regex: /\b(exfiltrate|send|upload|post)\b.{0,80}\b(api keys?|tokens?|secrets?|credentials?)\b/i,
    message: 'Skill content appears to exfiltrate credentials or secrets.',
  },
  {
    code: 'role-reset',
    regex: /\b(you are now|act as system|developer mode|jailbreak)\b/i,
    message: 'Skill content contains role-reset or jailbreak language.',
  },
];

const allowedImportedTools = new Set<string>([
  ...BUILTIN_TOOLS.map(tool => tool.id),
  'file_read',
  'file_write',
  'shell_exec',
  'grep',
  'search',
]);

export function reviewImportedSkillContent(content: string): SkillReviewResult {
  const issues: SkillReviewIssue[] = [];

  if (content.length > MAX_IMPORTED_SKILL_CHARS) {
    issues.push({
      severity: 'block',
      code: 'too-large',
      message: `Imported skill exceeds max size (${content.length}/${MAX_IMPORTED_SKILL_CHARS} chars).`,
    });
  }

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.regex.test(content)) {
      issues.push({ severity: 'block', code: pattern.code, message: pattern.message });
    }
  }

  const dlp = scanForPII(content);
  const blockingDlp = dlp.violations.filter(violation => violation.action === 'block');
  if (blockingDlp.length > 0) {
    issues.push({
      severity: 'block',
      code: 'embedded-secret',
      message: `Imported skill contains blocked sensitive data: ${Array.from(new Set(blockingDlp.map(v => v.type))).join(', ')}`,
    });
  }

  const parsed = parseSkillContent(content);
  if (parsed.isStructured && parsed.config) {
    for (const step of parsed.config.steps) {
      for (const toolName of step.tools || []) {
        if (!allowedImportedTools.has(toolName) && !isSandboxTool(toolName)) {
          issues.push({
            severity: 'block',
            code: 'unknown-tool',
            message: `Step "${step.name}" references unknown tool "${toolName}".`,
          });
        }
        if (toolName === 'shell_exec') {
          issues.push({
            severity: 'warn',
            code: 'shell-tool',
            message: `Step "${step.name}" uses shell_exec; runtime guardrails and cumulative time limits will apply.`,
          });
        }
      }

      if (step.validation?.command) {
        try {
          assertShellCommandAllowed(step.validation.command);
        } catch (err: any) {
          issues.push({
            severity: 'block',
            code: 'unsafe-validation',
            message: `Validation command for step "${step.name}" is unsafe: ${err.message}`,
          });
        }
      }
    }
  }

  return {
    approved: !issues.some(issue => issue.severity === 'block'),
    issues,
  };
}
