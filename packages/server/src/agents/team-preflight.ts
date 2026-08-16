/**
 * Team Preflight — 启动前的动态校验。
 *
 * 覆盖方案 §9.2 的运行时检查：
 * - 缺 Skill / 未知 Tool / 未知 Domain / 未知 Agent → error
 * - Tool 离线 → error
 * - 授权不足（approvalRequired 但无人工 Gate）→ error
 * - 高风险 Tool 无审批 Gate → error
 * - 策略冲突（同一 Tool 既允许又禁止）→ error
 * - 无法静态判定的事项 → warning（由调用方决定是否阻断）
 */
import type { TeamContractV2, WorkflowNodeV2 } from '../types.js';
import { validateTeamContractV2 } from '../contracts/team-composer-contracts.js';
import {
  resolveTeamCapabilities,
  resolvedPlanIsValid,
  type CapabilityResolverDeps,
  type ResolvedTeamPlan,
} from './capability-resolver.js';

export type PreflightSeverity = 'error' | 'warning';

export interface PreflightIssue {
  code: string;
  message: string;
  severity: PreflightSeverity;
  path?: string;
}

export interface ToolRuntimeStatus {
  enabled?: boolean;
  approvalRequired?: boolean;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}

export interface TeamPreflightDeps extends CapabilityResolverDeps {
  toolStatus?: (toolId: string) => ToolRuntimeStatus | undefined;
}

export interface TeamPreflightResult {
  pass: boolean;
  issues: PreflightIssue[];
  plan?: ResolvedTeamPlan;
}

export const HIGH_RISK_TOOLS = new Set(['high', 'critical']);

function error(code: string, message: string, path?: string): PreflightIssue {
  return { code, message, severity: 'error', path };
}

function warning(code: string, message: string, path?: string): PreflightIssue {
  return { code, message, severity: 'warning', path };
}

export function runTeamPreflight(
  team: TeamContractV2,
  nodes?: WorkflowNodeV2[],
  deps: TeamPreflightDeps = {},
): TeamPreflightResult {
  const issues: PreflightIssue[] = [];

  const contractValidation = validateTeamContractV2(team);
  if (!contractValidation.valid || !contractValidation.value) {
    for (const issue of contractValidation.errors) {
      issues.push(error('invalid_team_contract', `Team contract invalid: ${issue.message}`, issue.path));
    }
    return { pass: false, issues };
  }
  const validTeam = contractValidation.value;

  const plan = resolveTeamCapabilities(validTeam, nodes, deps);
  if (!resolvedPlanIsValid(plan)) {
    for (const issue of plan.errors) {
      issues.push(error(issue.code || 'capability_error', issue.message, issue.path));
    }
  }

  const requiredApprovalActions = new Set(plan.policy.requireHumanApprovalBefore || []);
  const hasHumanGate = (nodes || []).some(node => node.gate?.kind === 'human-approval');

  for (const role of plan.roles) {
    for (const toolId of role.tools) {
      const status = deps.toolStatus?.(toolId);
      if (status === undefined) continue;

      if (status.enabled === false) {
        issues.push(error('tool_offline', `Tool "${toolId}" is offline/disabled for slot "${role.slot}"`, `roles.${role.slot}.tools.${toolId}`));
      }
      if (status.approvalRequired === true && !hasHumanGate) {
        issues.push(error('tool_requires_approval', `Tool "${toolId}" requires human approval but no approval gate exists`, `roles.${role.slot}.tools.${toolId}`));
      }
      if (status.riskLevel && HIGH_RISK_TOOLS.has(status.riskLevel) && !requiredApprovalActions.has(toolId) && !hasHumanGate) {
        issues.push(error('high_risk_tool_without_gate', `High-risk tool "${toolId}" requires an approval gate`, `roles.${role.slot}.tools.${toolId}`));
      }
    }

    for (const skillId of role.skills) {
      const isPublish = skillId.includes('publish') || skillId.includes('publishing');
      if (isPublish && !requiredApprovalActions.has('publish') && !requiredApprovalActions.has('*') && !hasHumanGate) {
        issues.push(error('publish_without_approval', `Publish skill "${skillId}" on slot "${role.slot}" requires human approval`, `roles.${role.slot}.skills.${skillId}`));
      }
    }
  }

  if (plan.policy.allowedTools && plan.policy.disallowedTools) {
    const conflict = plan.policy.allowedTools.filter(tool => plan.policy.disallowedTools?.includes(tool));
    for (const toolId of conflict) {
      issues.push(error('policy_tool_conflict', `Tool "${toolId}" is both allowed and disallowed by team policy`, `policy`));
    }
  }

  if (requiredApprovalActions.size > 0) {
    const declaredActions = new Set([
      ...plan.roles.flatMap(role => role.tools),
      ...plan.roles.flatMap(role => role.skills),
    ]);
    if (plan.roles.some(role => role.skills.some(skill => skill.includes('publish') || skill.includes('publishing')))) {
      declaredActions.add('publish');
    }
    for (const action of requiredApprovalActions) {
      if (action !== '*' && !declaredActions.has(action)) {
        issues.push(warning('approval_action_undeclared', `Policy requires approval for "${action}" but no role declares it`, `policy.requireHumanApprovalBefore`));
      }
    }
  }

  for (const warningIssue of plan.warnings) {
    issues.push(warning(warningIssue.code || 'capability_warning', warningIssue.message, warningIssue.path));
  }

  return {
    pass: issues.every(issue => issue.severity !== 'error'),
    issues,
    plan,
  };
}
