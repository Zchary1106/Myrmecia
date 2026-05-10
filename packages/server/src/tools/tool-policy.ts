import type { AgentDefinition } from '../types.js';
import { getTool, listToolPermissions } from './tool-registry.js';

export interface ToolPolicyDecision {
  toolId: string;
  allowed: boolean;
  reason: 'allowed' | 'unknown_tool' | 'agent_disallowed' | 'tool_disabled' | 'agent_permission_disabled' | 'approval_required';
  approvalRequired?: boolean;
}

export interface AgentToolPolicy {
  requestedTools: string[];
  allowedTools: string[];
  decisions: ToolPolicyDecision[];
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
    if (permission && !permission.enabled) {
      decisions.push({ toolId, allowed: false, reason: 'agent_permission_disabled' });
      continue;
    }

    const approvalRequired = permission?.approvalRequired ?? tool.approvalRequired;
    if (approvalRequired) {
      decisions.push({ toolId, allowed: false, reason: 'approval_required', approvalRequired: true });
      continue;
    }

    decisions.push({ toolId, allowed: true, reason: 'allowed' });
    allowedTools.push(toolId);
  }

  return { requestedTools, allowedTools, decisions };
}
