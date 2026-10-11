import { dlpCheck } from './dlp.js';
import { enforceOutputLength } from '../agents/runtime-limits.js';
import { appendExecutionAuditEvent } from '../audit/execution-audit.js';

export interface AgentOutputContext {
  agentId?: string;
  taskId?: string;
  workspaceId?: string;
  executionId?: string;
  purpose?: string;
}

export function sanitizeAgentOutput(content: string, context: AgentOutputContext): string {
  if (!content) return content;

  const purpose = context.purpose || 'agent output';
  const bounded = enforceOutputLength(content, purpose);
  const result = dlpCheck(bounded, context);
  if (result.clean) return bounded;

  const blocking = result.violations.filter(violation => violation.action === 'block');
  if (blocking.length > 0) {
    const types = Array.from(new Set(blocking.map(violation => violation.type))).join(', ');
    if (context.executionId) {
      appendExecutionAuditEvent(context.executionId, {
        type: 'dlp.blocked',
        severity: 'block',
        message: `DLP blocked ${purpose}: ${types}`,
        metadata: { purpose, violationTypes: types },
      });
    }
    throw new Error(`DLP blocked ${purpose}: ${types}`);
  }

  if (context.executionId) {
    appendExecutionAuditEvent(context.executionId, {
      type: 'dlp.redacted',
      severity: 'warn',
      message: `DLP redacted ${purpose}`,
      metadata: {
        purpose,
        violationTypes: Array.from(new Set(result.violations.map(violation => violation.type))),
      },
    });
  }
  return result.redactedContent ?? bounded;
}

/**
 * Scan accumulated text, not independent transport chunks. The retained tail
 * covers bounded multi-token default PII patterns; the unfinished final token
 * is retained in full because API-key/email tokens can have unbounded length.
 * No pending tail is published on a failed/cancelled request.
 */
export class DlpStreamGuard {
  private raw = '';
  private emitted = '';
  constructor(private readonly context: AgentOutputContext) {}
  push(delta: string): string {
    this.raw += delta;
    const safe = sanitizeAgentOutput(this.raw, this.context);
    const upper = Math.max(0, safe.length - 128);
    const completePrefix = safe.slice(0, upper);
    const boundaries = [...completePrefix.matchAll(/\s/g)];
    const end = boundaries.length ? boundaries.at(-1)!.index! + 1 : 0;
    return this.publish(safe.slice(0, end));
  }
  finish(fullText: string): { text: string; delta: string } {
    const text = sanitizeAgentOutput(fullText, this.context);
    return { text, delta: this.publish(text) };
  }
  private publish(safePrefix: string): string {
    if (!safePrefix.startsWith(this.emitted)) throw new Error('DLP_STREAM_PREFIX_CHANGED: unsafe or inconsistent stream was stopped');
    const delta = safePrefix.slice(this.emitted.length);
    this.emitted = safePrefix;
    return delta;
  }
}
