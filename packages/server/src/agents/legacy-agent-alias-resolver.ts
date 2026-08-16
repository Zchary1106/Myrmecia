/**
 * Legacy Agent Alias Resolver — 旧 Agent ID 兼容层。
 *
 * 迁移期间，旧 ID（任务型 Agent）映射到「稳定角色 + Skills + Tools」。
 * 历史 Pipeline / 执行记录保留原始 ID；新运行通过 Capability Resolver
 * 将旧 ID 解析为新角色与 Skill 快照。
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LegacyAgentAlias {
  agentId: string;
  skills: string[];
  tools: string[];
}

export interface LegacyAgentAliasEntry extends LegacyAgentAlias {
  legacyAgentId: string;
}

const ALIAS_FILE = 'agents/legacy-agent-aliases.yaml';

let BUILTIN = new Map<string, LegacyAgentAlias>();

function candidatePaths(): string[] {
  return [
    process.env.MYRMECIA_RESOURCE_ROOT && join(process.env.MYRMECIA_RESOURCE_ROOT, ALIAS_FILE),
    join(__dirname, '../../../../agents/legacy-agent-aliases.yaml'),
    join(__dirname, '../../../agents/legacy-agent-aliases.yaml'),
    join(process.cwd(), ALIAS_FILE),
    join(process.cwd(), '../agents/legacy-agent-aliases.yaml'),
  ].filter((path): path is string => Boolean(path));
}

function normalize(entry: any, legacyAgentId: string): LegacyAgentAlias {
  return {
    agentId: String(entry.agentId || legacyAgentId),
    skills: Array.isArray(entry.skills) ? entry.skills.map(String) : [],
    tools: Array.isArray(entry.tools) ? entry.tools.map(String) : [],
  };
}

/** Load built-in legacy aliases from agents/legacy-agent-aliases.yaml. Safe to call multiple times. */
export function loadLegacyAgentAliases(explicitPath?: string): Map<string, LegacyAgentAlias> {
  const path = explicitPath || candidatePaths().find(p => existsSync(p));
  if (!path || !existsSync(path)) {
    logger.warn('legacy-agent-aliases.yaml not found — legacy alias resolution disabled');
    BUILTIN = new Map();
    return BUILTIN;
  }
  try {
    const parsed = parseYaml(readFileSync(path, 'utf-8')) as { legacyAgentAliases?: Record<string, any> };
    const aliases = new Map<string, LegacyAgentAlias>();
    for (const [legacyAgentId, entry] of Object.entries(parsed.legacyAgentAliases || {})) {
      aliases.set(legacyAgentId, normalize(entry, legacyAgentId));
    }
    BUILTIN = aliases;
    logger.info({ count: BUILTIN.size, path }, 'Loaded legacy agent aliases');
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to parse legacy-agent-aliases.yaml');
    BUILTIN = new Map();
  }
  return BUILTIN;
}

export function isLegacyAgent(agentId: string): boolean {
  return BUILTIN.has(agentId);
}

export function resolveLegacyAgentId(agentId: string): LegacyAgentAlias | undefined {
  return BUILTIN.get(agentId);
}

export function listLegacyAliases(): LegacyAgentAliasEntry[] {
  return Array.from(BUILTIN.entries()).map(([legacyAgentId, alias]) => ({
    legacyAgentId,
    ...alias,
  }));
}
