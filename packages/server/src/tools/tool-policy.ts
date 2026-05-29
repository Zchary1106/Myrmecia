import type { AgentDefinition } from '../types.js';
import { getTool, listToolPermissions, getToolParamConstraints } from './tool-registry.js';
import { validateParamConstraints } from './param-constraints.js';
import type { ConstraintViolation } from './param-constraints.js';

export interface ToolPolicyDecision {
  toolId: string;
  allowed: boolean;
  reason: 'allowed' | 'unknown_tool' | 'agent_disallowed' | 'tool_disabled' | 'agent_permission_disabled' | 'approval_required' | 'tool_prompt_injection' | 'network_disallowed';
  approvalRequired?: boolean;
}

export interface AgentToolPolicy {
  requestedTools: string[];
  allowedTools: string[];
  decisions: ToolPolicyDecision[];
}

const TOOL_PROMPT_INJECTION_PATTERNS = [
  /\b(ignore|bypass|override)\b.{0,80}\b(previous|above|system|developer|safety|guardrail)\b.{0,40}\binstructions?\b/i,
  /\b(reveal|print|dump|show|expose)\b.{0,80}\b(system prompt|developer message|hidden instructions|secrets?)\b/i,
  /\b(you are now|act as system|developer mode|jailbreak)\b/i,
];

function boolMetadata(metadata: Record<string, unknown>, key: string): boolean {
  return metadata[key] === true;
}

function hasToolPromptInjection(tool: ReturnType<typeof getTool>): boolean {
  if (!tool) return false;
  const content = `${tool.name}\n${tool.description}\n${JSON.stringify(tool.metadata || {})}`;
  return TOOL_PROMPT_INJECTION_PATTERNS.some(pattern => pattern.test(content));
}

function metadataRequiresApproval(tool: NonNullable<ReturnType<typeof getTool>>): boolean {
  const metadata = tool.metadata || {};
  return tool.riskLevel === 'high'
    || boolMetadata(metadata, 'destructive')
    || boolMetadata(metadata, 'writesOutsideWorkspace');
}

export function resolveAllowedToolsForAgent(agent: AgentDefinition): AgentToolPolicy {
  const requestedTools = Array.from(new Set(agent.allowedTools || agent.config.allowedTools || []));
  const disallowed = new Set(agent.disallowedTools || []);
  const permissions = new Map(listToolPermissions({ agentId: agent.id }).map(permission => [permission.toolId, permission]));
  const decisions: ToolPolicyDecision[] = [];
  const allowedTools: string[] = [];

  for (const toolId of requestedTools) {
    const tool = getTool(toolId);
    const permission = permissions.get(toolId);

    if (!tool) {
      decisions.push({ toolId, allowed: false, reason: 'unknown_tool' });
      continue;
    }
    if (disallowed.has(toolId)) {
      decisions.push({ toolId, allowed: false, reason: 'agent_disallowed' });
      continue;
    }
    if (!tool.enabled) {
      decisions.push({ toolId, allowed: false, reason: 'tool_disabled' });
      continue;
    }
    if (hasToolPromptInjection(tool)) {
      decisions.push({ toolId, allowed: false, reason: 'tool_prompt_injection' });
      continue;
    }
    if (boolMetadata(tool.metadata || {}, 'network') && agent.config.allowNetwork === false) {
      decisions.push({ toolId, allowed: false, reason: 'network_disallowed' });
      continue;
    }
    if (permission && !permission.enabled) {
      decisions.push({ toolId, allowed: false, reason: 'agent_permission_disabled' });
      continue;
    }

    const approvalRequired = permission?.approvalRequired ?? (tool.approvalRequired || metadataRequiresApproval(tool));
    if (approvalRequired) {
      decisions.push({ toolId, allowed: false, reason: 'approval_required', approvalRequired: true });
      continue;
    }

    decisions.push({ toolId, allowed: true, reason: 'allowed' });
    allowedTools.push(toolId);
  }

  return { requestedTools, allowedTools, decisions };
}

/**
 * Validate a tool call's parameters against tool constraints.
 * Returns violations array — empty if all parameters are valid.
 */
export function validateToolParams(
  toolId: string,
  params: Record<string, unknown>,
): ConstraintViolation[] {
  const tool = getTool(toolId);
  if (!tool) return [{ param: '', value: '', constraint: 'unknown_tool', message: `Tool "${toolId}" not found` }];

  if (!tool.enabled) return [{ param: '', value: '', constraint: 'tool_disabled', message: `Tool "${toolId}" is disabled` }];

  const constraints = getToolParamConstraints(toolId);
  if (Object.keys(constraints).length === 0) return [];

  return validateParamConstraints(params, constraints);
}

export type { ConstraintViolation };
