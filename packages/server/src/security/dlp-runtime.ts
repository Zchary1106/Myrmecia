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
