import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

export interface InjectionResult {
  detected: boolean;
  patterns: string[];
  severity?: 'low' | 'medium' | 'high';
}

// Patterns ordered by severity (high → low)
const INJECTION_PATTERNS: Array<{ regex: RegExp; name: string; severity: 'low' | 'medium' | 'high' }> = [
  // High severity — direct instruction override
  { regex: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i, name: 'ignore_previous', severity: 'high' },
  { regex: /disregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|programming|rules?)/i, name: 'disregard_instructions', severity: 'high' },
  { regex: /you\s+are\s+now\s+(?!going\s+to\s+(?:build|create|implement))/i, name: 'role_override', severity: 'high' },
  { regex: /(?:new|override|replace)\s+(?:system\s+)?(?:prompt|instruction|persona)/i, name: 'prompt_override', severity: 'high' },

  // Medium severity — information extraction
  { regex: /(?:print|output|show|reveal|display|repeat)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?)\s*(?:verbatim|exactly|word.for.word)?/i, name: 'prompt_extraction', severity: 'medium' },
  { regex: /what\s+(?:are|is)\s+your\s+(?:system\s+)?(?:prompt|instructions?|rules?)/i, name: 'prompt_query', severity: 'medium' },

  // Medium severity — jailbreak patterns
  { regex: /\bDAN\b.*(?:do\s+anything|no\s+(?:rules|limits|restrictions))/i, name: 'dan_jailbreak', severity: 'medium' },
  { regex: /(?:pretend|act\s+as\s+if)\s+(?:you\s+)?(?:have\s+no|don'?t\s+have)\s+(?:rules|restrictions|limits)/i, name: 'restriction_bypass', severity: 'medium' },

  // Medium severity — obfuscated variants (leet speak)
  { regex: /[i1l][gq9]n[o0]r[e3]\s+pr[e3]v[i1l][o0][u\xfc]s/i, name: 'obfuscated_ignore', severity: 'medium' },
];

/**
 * Detect prompt injection patterns in text input.
 */
export function detectInjection(input: string): InjectionResult {
  if (!input || input.length === 0) {
    return { detected: false, patterns: [] };
  }

  const matched: Array<{ name: string; severity: 'low' | 'medium' | 'high' }> = [];

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.regex.test(input)) {
      matched.push({ name: pattern.name, severity: pattern.severity });
    }
  }

  if (matched.length === 0) {
    return { detected: false, patterns: [] };
  }

  const severityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const maxSeverity = matched.reduce(
    (max, m) => (severityOrder[m.severity] > severityOrder[max] ? m.severity : max),
    'low' as 'low' | 'medium' | 'high',
  );

  return {
    detected: true,
    patterns: matched.map((m) => m.name),
    severity: maxSeverity,
  };
}

/**
 * Express middleware that screens task input fields for injection patterns.
 * High severity: blocks request (403).
 * Medium/Low: logs warning, adds header, allows through.
 */
export function inputSanitizerMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
    next();
    return;
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    next();
    return;
  }

  const fieldsToCheck = ['input', 'title', 'description', 'prompt', 'content', 'skill'];
  const textsToScan: string[] = [];

  for (const field of fieldsToCheck) {
    if (typeof (body as Record<string, unknown>)[field] === 'string' && ((body as Record<string, unknown>)[field] as string).length > 0) {
      textsToScan.push((body as Record<string, unknown>)[field] as string);
    }
  }

  if (textsToScan.length === 0) {
    next();
    return;
  }

  const combined = textsToScan.join('\n');
  const result = detectInjection(combined);

  if (!result.detected) {
    next();
    return;
  }

  logger.warn({
    event: 'injection_detected',
    severity: result.severity,
    patterns: result.patterns,
    path: req.path,
    method: req.method,
  }, `Prompt injection detected (${result.severity}): ${result.patterns.join(', ')}`);

  if (result.severity === 'high') {
    res.status(403).json({
      error: 'Input rejected',
      reason: 'Potentially harmful input pattern detected',
      patterns: result.patterns,
    });
    return;
  }

  // Medium/Low — allow but tag
  res.setHeader('X-Injection-Warning', result.patterns.join(','));
  next();
}
