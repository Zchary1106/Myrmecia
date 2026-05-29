export type ToolGuardianSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ToolGuardianIssue {
  code: string;
  severity: ToolGuardianSeverity;
  message: string;
}

export interface ToolGuardianDecision {
  allowed: boolean;
  issues: ToolGuardianIssue[];
}

const SECRET_PATTERNS: Array<{ code: string; label: string; regex: RegExp }> = [
  { code: 'anthropic-key', label: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { code: 'openai-key', label: 'OpenAI API key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { code: 'github-token', label: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { code: 'aws-access-key', label: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { code: 'private-key', label: 'private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { code: 'generic-secret', label: 'generic secret assignment', regex: /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_.:/+=-]{24,}/gi },
];

const SHELL_BLOCK_PATTERNS: Array<{ code: string; regex: RegExp; message: string }> = [
  { code: 'pipe-to-shell', regex: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh|python|node)\b/i, message: 'Remote download piped directly to an interpreter is blocked.' },
  { code: 'obfuscated-shell', regex: /\$\{[^}]+@P\}|\$\{![^}]+\}|\beval\b|\bexec\s/i, message: 'Shell obfuscation or dynamic execution is blocked.' },
  { code: 'destructive-root-delete', regex: /\brm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+\/(?:\s|$)/i, message: 'Recursive deletion of root paths is blocked.' },
  { code: 'unsafe-permissions', regex: /\bchmod\s+(?:-R\s+)?777\b/i, message: 'World-writable permission changes are blocked.' },
  { code: 'destructive-git', regex: /\bgit\s+(?:reset\s+--hard|clean\s+-[A-Za-z]*[fdx]|filter-branch|update-ref)\b/i, message: 'Destructive git history or workspace operations are blocked.' },
  { code: 'force-push', regex: /\bgit\s+push\b[\s\S]*(?:--force|-f)\b/i, message: 'Force-pushing is blocked.' },
  { code: 'sql-destroy', regex: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i, message: 'Destructive SQL is blocked.' },
  { code: 'sql-delete-without-where', regex: /\bdelete\s+from\s+[A-Za-z0-9_."`]+(?:\s*;|\s*$)/i, message: 'DELETE statements without a WHERE clause are blocked.' },
  { code: 'exfil-upload', regex: /\b(?:curl|wget|scp|rsync)\b[\s\S]*(?:--data|-d|--upload-file|-T|@\/|@\.)/i, message: 'Potential file upload or data exfiltration is blocked.' },
  { code: 'unsafe-package-source', regex: /\b(?:npm|pnpm|yarn)\s+(?:add|install)\b[\s\S]*(?:git\+|github:|https?:\/\/|--unsafe-perm)/i, message: 'Installing dependencies from unreviewed remote package sources is blocked.' },
  { code: 'pip-remote-install', regex: /\bpip(?:3)?\s+install\b[\s\S]*(?:git\+|https?:\/\/)/i, message: 'Installing Python packages from unreviewed remote URLs is blocked.' },
];

function stringInputs(toolInput: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const value of Object.values(toolInput)) {
    if (typeof value === 'string') values.push(value);
  }
  return values;
}

function hasHighConfidenceSecret(content: string): boolean {
  return SECRET_PATTERNS.some(pattern => {
    pattern.regex.lastIndex = 0;
    return pattern.regex.test(content);
  });
}

export function redactSecrets(content: string): string {
  let redacted = content;
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    redacted = redacted.replace(pattern.regex, `[REDACTED:${pattern.code}]`);
  }
  return redacted;
}

export function reviewToolCall(toolName: string, toolInput: Record<string, unknown>): ToolGuardianDecision {
  const issues: ToolGuardianIssue[] = [];

  for (const value of stringInputs(toolInput)) {
    if (hasHighConfidenceSecret(value)) {
      issues.push({
        code: 'secret-in-tool-input',
        severity: 'high',
        message: `Tool "${toolName}" input contains a high-confidence secret.`,
      });
      break;
    }
  }

  if (toolName === 'shell_exec') {
    const command = String(toolInput.command || toolInput.cmd || '');
    for (const pattern of SHELL_BLOCK_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(command)) {
        issues.push({ code: pattern.code, severity: 'high', message: pattern.message });
      }
    }

    if (/\b(?:npm|pnpm|yarn)\s+(?:add|install)\b|\bpip(?:3)?\s+install\b|\bgo\s+get\b|\bcargo\s+add\b/i.test(command)) {
      issues.push({
        code: 'dependency-license-review',
        severity: 'medium',
        message: 'Dependency changes should pass license and supply-chain review before merge.',
      });
    }
  }

  return {
    allowed: !issues.some(issue => issue.severity === 'high' || issue.severity === 'critical'),
    issues,
  };
}

export function formatToolGuardianDecision(decision: ToolGuardianDecision): string {
  return decision.issues
    .map(issue => `${issue.code}: ${issue.message}`)
    .join('; ') || 'Tool call blocked by guardian policy';
}

export function formatToolGuardianWarnings(decision: ToolGuardianDecision): string {
  const warnings = decision.issues.filter(issue => issue.severity === 'low' || issue.severity === 'medium');
  if (warnings.length === 0) return '';
  return `Guardian warnings:\n${warnings.map(issue => `- ${issue.code}: ${issue.message}`).join('\n')}`;
}
