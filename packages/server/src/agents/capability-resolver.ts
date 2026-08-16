/**
 * Capability Resolver — 运行前把 Team v2 的 Role 槽位解析为具体能力。
 *
 * 解析链：Team → Role Slot → Agent + Skills + Tools + Domain。
 * 结果用于生成不可变 ExecutionPlanSnapshot，供审计与重放。
 * 未知 Skill / Tool / Domain / Agent 绑定会被明确拒绝（errors），
 * 其余无法静态判定的事项（Tool 在线状态、权限）交给 Team Preflight。
 */
import { createHash } from 'crypto';
import type {
  ContractValidationIssue,
  ExecutionPlanSnapshot,
  ResolvedRoleCapability,
  TeamContractV2,
  WorkflowNodeV2,
} from '../types.js';
import { getAgent } from '../db/models/agent.js';
import { getSkill } from '../db/models/skill.js';
import { getDomain } from './domain-registry.js';
import { getTool } from '../tools/tool-registry.js';
import { GOVERNED_PUBLISH_MCP_TOOLS, PLATFORM_MCP_SERVERS, getMcpManager } from '../tools/mcp-manager.js';
import { resolveLegacyAgentId } from './legacy-agent-alias-resolver.js';

export interface CapabilityResolverDeps {
  getAgent?: (id: string) => unknown;
  getSkill?: (id: string) => unknown;
  getTool?: (id: string) => unknown;
  getDomain?: (id: string) => unknown;
  resolveAlias?: (id: string) => { agentId: string; skills: string[]; tools: string[] } | undefined;
}

export interface ResolvedTeamPlan {
  schemaVersion: '2.0';
  teamId: string;
  teamVersion: number;
  roles: ResolvedRoleCapability[];
  policy: NonNullable<TeamContractV2['policy']>;
  errors: ContractValidationIssue[];
  warnings: ContractValidationIssue[];
}

const defaultDeps: Required<Pick<CapabilityResolverDeps, 'getAgent' | 'getSkill' | 'getTool' | 'getDomain' | 'resolveAlias'>> = {
  getAgent: id => getAgent(id),
  getSkill: id => getSkill(id),
  getTool: id => toolExists(id),
  getDomain: id => getDomain(id),
  resolveAlias: id => resolveLegacyAgentId(id),
};

function toolExists(id: string): unknown {
  if (getTool(id)) return true;
  if (!id.startsWith('mcp__')) return false;
  const known = getMcpManager().listTools().some(tool => tool.qualifiedName === id);
  if (known) return true;
  if (GOVERNED_PUBLISH_MCP_TOOLS.includes(id as (typeof GOVERNED_PUBLISH_MCP_TOOLS)[number])) return true;
  const server = id.split('__')[1];
  return (PLATFORM_MCP_SERVERS as readonly string[]).includes(server);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function issue(path: string, message: string, code: string): ContractValidationIssue {
  return { path, message, code };
}

/**
 * Resolve a Team v2 into concrete role capabilities.
 * Optional `nodes` aggregates per-slot requiredCapabilities from pipeline nodes.
 */
export function resolveTeamCapabilities(
  team: TeamContractV2,
  nodes?: WorkflowNodeV2[],
  deps: CapabilityResolverDeps = {},
): ResolvedTeamPlan {
  const d = { ...defaultDeps, ...deps };
  const roles: ResolvedRoleCapability[] = [];
  const errors: ContractValidationIssue[] = [];
  const warnings: ContractValidationIssue[] = [];

  const capabilitiesBySlot = new Map<string, string[]>();
  for (const node of nodes || []) {
    const existing = capabilitiesBySlot.get(node.roleSlot) || [];
    capabilitiesBySlot.set(node.roleSlot, dedupe([...existing, ...node.requiredCapabilities]));
  }

  for (const role of team.roles) {
    const alias = d.resolveAlias(role.agentId);
    const agentId = alias?.agentId ?? role.agentId;
    const legacyAgentId = alias ? role.agentId : undefined;

    if (d.getAgent && !d.getAgent(agentId)) {
      errors.push(issue(
        `roles.${role.slot}.agentId`,
        `Agent "${agentId}" is not registered${legacyAgentId ? ` (legacy alias of "${legacyAgentId}")` : ''}`,
        'unknown_agent',
      ));
    }

    const skills = dedupe([...(alias?.skills ?? []), ...(role.skills ?? [])]);
    for (const skill of skills) {
      if (d.getSkill && !d.getSkill(skill)) {
        errors.push(issue(`roles.${role.slot}.skills.${skill}`, `Skill "${skill}" is not registered`, 'unknown_skill'));
      }
    }

    const tools = dedupe([...(alias?.tools ?? []), ...(role.tools ?? [])]);
    for (const tool of tools) {
      if (d.getTool && !d.getTool(tool)) {
        errors.push(issue(`roles.${role.slot}.tools.${tool}`, `Tool "${tool}" is not registered`, 'unknown_tool'));
      }
    }

    const domainIds = role.domainIds ?? [];
    for (const domainId of domainIds) {
      if (d.getDomain && !d.getDomain(domainId)) {
        errors.push(issue(`roles.${role.slot}.domainIds.${domainId}`, `Domain pack "${domainId}" is not registered`, 'unknown_domain'));
      }
    }

    const resolvedDomains = domainIds
      .map(domainId => d.getDomain(domainId))
      .filter((domain): domain is { id: string; version?: number } => Boolean(domain))
      .map(domain => ({ id: domain.id, version: domain.version ?? 1 }));

    if (skills.length === 0 && tools.length === 0) {
      warnings.push(issue(
        `roles.${role.slot}`,
        `Role slot "${role.slot}" declares no skills or tools`,
        'empty_capability_slot',
      ));
    }

    roles.push({
      slot: role.slot,
      agentId,
      ...(legacyAgentId ? { legacyAgentId } : {}),
      skills,
      tools,
      domainIds,
      ...(resolvedDomains.length ? { domains: resolvedDomains } : {}),
      capabilities: capabilitiesBySlot.get(role.slot) || [],
    });
  }

  return {
    schemaVersion: '2.0',
    teamId: team.id,
    teamVersion: team.version,
    roles,
    policy: team.policy || {},
    errors,
    warnings,
  };
}

export function resolvedPlanIsValid(plan: ResolvedTeamPlan): boolean {
  return plan.errors.length === 0;
}

/**
 * Build an immutable ExecutionPlanSnapshot from a resolved plan.
 * The checksum covers the canonical JSON of every field except `checksum`.
 */
export function buildExecutionPlanSnapshot(
  plan: ResolvedTeamPlan,
  options: {
    snapshotId: string;
    pipelineTemplate?: string;
    pipelineVersion?: string;
    gates?: ExecutionPlanSnapshot['gates'];
    modelPolicy?: Record<string, unknown>;
    contextBudget?: Record<string, unknown>;
    createdAt?: string;
  },
): ExecutionPlanSnapshot {
  const { snapshotId, pipelineTemplate, pipelineVersion, gates = [], modelPolicy, contextBudget } = options;
  const createdAt = options.createdAt || new Date().toISOString();
  const body = {
    schemaVersion: '2.0' as const,
    snapshotId,
    teamId: plan.teamId,
    teamVersion: plan.teamVersion,
    ...(pipelineTemplate ? { pipelineTemplate } : {}),
    ...(pipelineVersion ? { pipelineVersion } : {}),
    roles: plan.roles,
    policy: plan.policy,
    gates,
    ...(modelPolicy ? { modelPolicy } : {}),
    ...(contextBudget ? { contextBudget } : {}),
    createdAt,
  };
  const canonical = canonicalStringify(body);
  const checksum = sha256Hex(canonical);
  return { ...body, checksum };
}

/** Canonical JSON: object keys sorted recursively, so the checksum is stable. */
export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
