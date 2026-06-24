import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { logger } from '../lib/logger.js';
import { listAgents } from '../db/models/agent.js';
import {
  listDomainRows, getDomainRow, insertDomainRow, updateDomainRow, deleteDomainRow,
} from '../db/models/domain.js';
import type { DomainPack, DomainPackInput } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_RETRIEVAL = { enabled: true, topK: 6, minScore: 0.35 };

let BUILTIN: DomainPack[] = [];

function candidatePaths(): string[] {
  return [
    join(__dirname, '../../../../agents/domains.yaml'),
    join(__dirname, '../../../agents/domains.yaml'),
    join(process.cwd(), 'agents/domains.yaml'),
    join(process.cwd(), '../agents/domains.yaml'),
  ];
}

const slug = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48);

/** A URL-safe id from an explicit id or name, falling back to a random suffix
 *  when the name has no ASCII slug (e.g. Chinese-only names). */
function makeDomainId(explicitId: string | undefined, name: string): string {
  return slug(explicitId || name) || `domain-${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize raw YAML / input into a complete DomainPack. */
function normalize(d: any, builtin: boolean): DomainPack {
  const retrieval = d.retrieval || {};
  return {
    id: String(d.id),
    name: d.name || d.id,
    emoji: d.emoji || '📘',
    persona: d.persona || '',
    guidelines: Array.isArray(d.guidelines) ? d.guidelines.map(String) : [],
    terminology: d.terminology && typeof d.terminology === 'object' ? d.terminology : {},
    disclaimer: d.disclaimer || undefined,
    tone: d.tone || undefined,
    retrieval: {
      enabled: retrieval.enabled ?? DEFAULT_RETRIEVAL.enabled,
      topK: Number(retrieval.topK ?? DEFAULT_RETRIEVAL.topK),
      minScore: Number(retrieval.minScore ?? DEFAULT_RETRIEVAL.minScore),
    },
    knowledgeIds: Array.isArray(d.knowledgeIds) ? d.knowledgeIds.map(String) : [],
    agentIds: Array.isArray(d.agents) ? d.agents.map(String)
      : Array.isArray(d.agentIds) ? d.agentIds.map(String) : [],
    builtin,
  };
}

/** Load built-in domain packs from agents/domains.yaml. Safe to call multiple times. */
export function loadDomains(explicitPath?: string): DomainPack[] {
  const path = explicitPath || candidatePaths().find(p => existsSync(p));
  if (!path || !existsSync(path)) {
    logger.warn('domains.yaml not found — built-in domain packs disabled');
    BUILTIN = [];
    return BUILTIN;
  }
  try {
    const parsed = parseYaml(readFileSync(path, 'utf-8')) as { domains?: any[] };
    BUILTIN = (parsed.domains || []).map(d => normalize(d, true));
    logger.info({ count: BUILTIN.length, path }, 'Loaded built-in domain packs');
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to parse domains.yaml');
    BUILTIN = [];
  }
  return BUILTIN;
}

function listCustom(workspaceId?: string): DomainPack[] {
  try {
    return listDomainRows(workspaceId);
  } catch {
    return [];
  }
}

/** All domains: built-ins overlaid by any custom domain with the same id. */
export function listDomains(workspaceId?: string): DomainPack[] {
  const custom = listCustom(workspaceId);
  const byId = new Map<string, DomainPack>();
  for (const d of BUILTIN) byId.set(d.id, d);
  for (const d of custom) byId.set(d.id, d); // custom overrides built-in
  return [...byId.values()];
}

export function getDomain(id: string, workspaceId?: string): DomainPack | undefined {
  const key = (id || '').toLowerCase();
  return listDomains(workspaceId).find(d => d.id.toLowerCase() === key);
}

function applyInput(base: DomainPack, input: Partial<DomainPackInput>): DomainPack {
  return {
    ...base,
    name: input.name ?? base.name,
    emoji: input.emoji ?? base.emoji,
    persona: input.persona ?? base.persona,
    guidelines: input.guidelines ?? base.guidelines,
    terminology: input.terminology ?? base.terminology,
    disclaimer: input.disclaimer ?? base.disclaimer,
    tone: input.tone ?? base.tone,
    retrieval: { ...base.retrieval, ...(input.retrieval || {}) },
    knowledgeIds: input.knowledgeIds ?? base.knowledgeIds,
    agentIds: input.agentIds ?? base.agentIds,
  };
}

const emptyPack = (workspaceId: string): DomainPack => ({
  id: '', name: '', emoji: '📘', persona: '', guidelines: [], terminology: {},
  retrieval: { ...DEFAULT_RETRIEVAL }, knowledgeIds: [], agentIds: [],
  workspaceId, builtin: false,
});

export function createDomain(input: DomainPackInput, workspaceId = 'default'): DomainPack {
  const id = makeDomainId(input.id, input.name);
  if (!input.name?.trim()) throw new Error('domain name is required');
  if (!input.persona?.trim()) throw new Error('domain persona is required');
  if (BUILTIN.some(d => d.id === id) || listCustom().some(d => d.id === id)) {
    throw new Error(`domain "${id}" already exists`);
  }
  const pack = applyInput({ ...emptyPack(workspaceId), id }, input);
  return insertDomainRow(pack);
}

export function updateDomain(id: string, patch: Partial<DomainPackInput>, workspaceId = 'default'): DomainPack {
  const existing = listCustom().find(d => d.id === id);
  if (existing) {
    return updateDomainRow(id, applyInput(existing, patch));
  }
  // Editing a built-in: materialize it as a custom override.
  const base = BUILTIN.find(d => d.id === id);
  if (!base) throw new Error(`domain "${id}" not found`);
  return insertDomainRow(applyInput({ ...base, workspaceId, builtin: false }, patch));
}

export function deleteDomain(id: string): { reverted: boolean } {
  const custom = listCustom().find(d => d.id === id);
  if (!custom) throw new Error(`domain "${id}" is not a custom domain`);
  deleteDomainRow(id);
  // If a built-in with this id exists, deletion just reverts to the built-in.
  return { reverted: BUILTIN.some(d => d.id === id) };
}

/** Bind / unbind knowledge document ids to a domain (idempotent union). */
export function bindKnowledge(id: string, documentIds: string[], workspaceId = 'default'): DomainPack {
  const domain = getDomain(id, workspaceId);
  if (!domain) throw new Error(`domain "${id}" not found`);
  const merged = [...new Set([...domain.knowledgeIds, ...documentIds])];
  return updateDomain(id, { knowledgeIds: merged }, workspaceId);
}

/** Resolve the domain that applies to an agent (explicit domainId wins). */
export function resolveDomainForAgent(agentId: string, domainId?: string, workspaceId?: string): DomainPack | undefined {
  if (domainId) return getDomain(domainId, workspaceId);
  return listDomains(workspaceId).find(d => d.agentIds.includes(agentId));
}

/**
 * Pick an agent bound to a domain that matches the requested role. Used to route
 * work to domain specialists when a task/pipeline carries a domainId. Returns the
 * agent id, or undefined when the domain has no matching bound agent.
 */
export function domainAgentForRole(domainId: string | undefined, role: string, workspaceId?: string): string | undefined {
  if (!domainId || !role) return undefined;
  const domain = getDomain(domainId, workspaceId);
  if (!domain || !domain.agentIds.length) return undefined;
  const agents = listAgents();
  const match = agents.find(a =>
    domain.agentIds.includes(a.id) && (a.role === role || a.role.includes(role) || a.id === role),
  );
  return match?.id;
}

export { getDomainRow };
