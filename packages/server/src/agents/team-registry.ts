import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { listAgents } from '../db/models/agent.js';
import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';
import type { TeamPolicyV2, TeamRoleSlotV2 } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Team {
  id: string;
  name: string;
  emoji: string;
  lead: string;
  members: string[];      // member roles
  /** Team Contract v2 role slots (capability composition). */
  roles?: TeamRoleSlotV2[];
  policy?: TeamPolicyV2;
  domainIds?: string[];
  contractVersion?: 1 | 2;
  template?: string;      // optional pipeline template name (legacy/fallback)
  triggers: string[];
  blurb: string;
  builtin?: boolean;      // true for teams.yaml defaults (not deletable)
}

function normalizeRoles(value: unknown): TeamRoleSlotV2[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const roles = value
    .map(role => ({
      slot: String(role?.slot ?? ''),
      agentId: String(role?.agentId ?? ''),
      skills: Array.isArray(role?.skills) ? role.skills.map(String) : [],
      tools: Array.isArray(role?.tools) ? role.tools.map(String) : [],
      domainIds: Array.isArray(role?.domainIds) ? role.domainIds.map(String) : [],
    }))
    .filter(role => role.slot && role.agentId);
  return roles.length ? roles : undefined;
}

let BUILTIN: Team[] = [];

function candidatePaths(): string[] {
  return [
    process.env.MYRMECIA_RESOURCE_ROOT && join(process.env.MYRMECIA_RESOURCE_ROOT, 'agents/teams.yaml'),
    join(__dirname, '../../../../agents/teams.yaml'),
    join(__dirname, '../../../agents/teams.yaml'),
    join(process.cwd(), 'agents/teams.yaml'),
    join(process.cwd(), '../agents/teams.yaml'),
  ].filter((path): path is string => Boolean(path));
}

function normalize(t: any, builtin: boolean): Team {
  return {
    id: String(t.id),
    name: t.name || t.id,
    emoji: t.emoji || '•',
    lead: t.lead || 'master',
    members: Array.isArray(t.members) ? t.members.map(String) : [],
    roles: normalizeRoles(t.roles),
    policy: t.policy && typeof t.policy === 'object' ? t.policy : undefined,
    domainIds: Array.isArray(t.domainIds) ? t.domainIds.map(String) : undefined,
    contractVersion: t.contractVersion === 2 ? 2 : t.roles ? 2 : 1,
    template: t.template || undefined,
    triggers: Array.isArray(t.triggers) ? t.triggers.map(String) : [],
    blurb: t.blurb || '',
    builtin,
  };
}

function rowToTeam(row: any): Team {
  const j = (v: any, d: any) => { try { return JSON.parse(v); } catch { return d; } };
  return normalize({
    id: row.id, name: row.name, emoji: row.emoji, lead: row.lead,
    members: j(row.members, []), template: row.template, triggers: j(row.triggers, []), blurb: row.blurb,
    roles: j(row.roles, []), policy: j(row.policy, {}), domainIds: j(row.domain_ids, []),
    contractVersion: row.contract_version === 2 ? 2 : 1,
  }, false);
}

/** Load built-in teams from agents/teams.yaml. Safe to call multiple times. */
export function loadTeams(explicitPath?: string): Team[] {
  const path = explicitPath || candidatePaths().find(p => existsSync(p));
  if (!path || !existsSync(path)) {
    logger.warn('teams.yaml not found — built-in teams disabled');
    BUILTIN = [];
    return BUILTIN;
  }
  try {
    const parsed = parseYaml(readFileSync(path, 'utf-8')) as { teams?: any[] };
    BUILTIN = (parsed.teams || []).map(t => normalize(t, true));
    logger.info({ count: BUILTIN.length, path }, 'Loaded built-in agent teams');
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to parse teams.yaml');
    BUILTIN = [];
  }
  return BUILTIN;
}

/** Custom (DB) teams, optionally scoped to a workspace. */
function listCustom(workspaceId?: string): Team[] {
  try {
    const db = getDb();
    const rows = (workspaceId
      ? db.all('SELECT * FROM team_definitions WHERE workspace_id = ? ORDER BY created_at', workspaceId)
      : db.all('SELECT * FROM team_definitions ORDER BY created_at')) as any[];
    return rows.map(rowToTeam);
  } catch { return []; }
}

/** All teams: built-ins overlaid by any custom team with the same id. */
export function listTeams(workspaceId?: string): Team[] {
  const custom = listCustom(workspaceId);
  const byId = new Map<string, Team>();
  for (const t of BUILTIN) byId.set(t.id, t);
  for (const t of custom) byId.set(t.id, t); // custom overrides built-in
  return [...byId.values()];
}

export function getTeam(id: string, workspaceId?: string): Team | undefined {
  const key = (id || '').toLowerCase().replace(/^@/, '');
  return listTeams(workspaceId).find(t => t.id.toLowerCase() === key);
}

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 32);

export interface TeamInput {
  id?: string; name: string; emoji?: string; lead?: string;
  members: string[]; template?: string; triggers?: string[]; blurb?: string;
  roles?: TeamRoleSlotV2[]; policy?: TeamPolicyV2; domainIds?: string[];
}

function resolveLead(input: { lead?: string; roles?: TeamRoleSlotV2[] }): string {
  if (input.lead) return input.lead;
  if (input.roles?.length) return input.roles[0].slot;
  return 'master';
}

export function createTeam(input: TeamInput, workspaceId = 'default'): Team {
  const id = slug(input.id || input.name);
  if (!id) throw new Error('team id/name is required');
  if (BUILTIN.some(t => t.id === id) || listCustom(workspaceId).some(t => t.id === id)) {
    throw new Error(`team "${id}" already exists`);
  }
  if (!input.members?.length && !input.roles?.length) {
    throw new Error('a team needs at least one member role or v2 role slot');
  }
  const db = getDb();
  db.run(
    'INSERT INTO team_definitions (id, name, emoji, lead, members, roles, policy, domain_ids, contract_version, template, triggers, blurb, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, input.name, input.emoji || '🐜', resolveLead(input),
    JSON.stringify(input.members),
    JSON.stringify(input.roles || []), JSON.stringify(input.policy || {}),
    JSON.stringify(input.domainIds || []), input.roles?.length ? 2 : 1,
    input.template || null, JSON.stringify(input.triggers || []), input.blurb || '', workspaceId,
  );
  return getTeam(id, workspaceId)!;
}

export function updateTeam(id: string, patch: Partial<TeamInput>, workspaceId = 'default'): Team {
  const db = getDb();
  const existing = listCustom(workspaceId).find(t => t.id === id);
  if (!existing) {
    // Editing a built-in: materialize it as a custom override.
    const base = BUILTIN.find(t => t.id === id);
    if (!base) throw new Error(`team "${id}" not found`);
    return createTeamOverride(base, patch, workspaceId);
  }
  const merged = { ...existing, ...patch };
  db.run(
    'UPDATE team_definitions SET name = ?, emoji = ?, lead = ?, members = ?, roles = ?, policy = ?, domain_ids = ?, contract_version = ?, template = ?, triggers = ?, blurb = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?',
    merged.name, merged.emoji, resolveLead(merged),
    JSON.stringify(merged.members),
    JSON.stringify(merged.roles || []), JSON.stringify(merged.policy || {}),
    JSON.stringify(merged.domainIds || []), merged.roles?.length ? 2 : 1,
    merged.template || null, JSON.stringify(merged.triggers || []), merged.blurb || '', id, workspaceId,
  );
  return getTeam(id, workspaceId)!;
}

function createTeamOverride(base: Team, patch: Partial<TeamInput>, workspaceId: string): Team {
  const merged = { ...base, ...patch };
  getDb().run(
    'INSERT INTO team_definitions (id, name, emoji, lead, members, roles, policy, domain_ids, contract_version, template, triggers, blurb, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    base.id, merged.name, merged.emoji, resolveLead(merged),
    JSON.stringify(merged.members),
    JSON.stringify(merged.roles || []), JSON.stringify(merged.policy || {}),
    JSON.stringify(merged.domainIds || []), merged.roles?.length ? 2 : 1,
    merged.template || null, JSON.stringify(merged.triggers || []), merged.blurb || '', workspaceId,
  );
  return getTeam(base.id, workspaceId)!;
}

export function deleteTeam(id: string, workspaceId = 'default'): { reverted: boolean } {
  const custom = listCustom(workspaceId).find(t => t.id === id);
  if (!custom) throw new Error(`team "${id}" is not a custom team`);
  getDb().run('DELETE FROM team_definitions WHERE id = ? AND workspace_id = ?', id, workspaceId);
  // If a built-in with this id exists, deletion just reverts to the built-in.
  const reverted = BUILTIN.some(t => t.id === id);
  if (!reverted) {
    getDb().run('DELETE FROM team_template_versions WHERE team_id = ? AND workspace_id = ?', id, workspaceId);
  }
  return { reverted };
}

/** Resolve a team's member roles to concrete agent ids that currently exist. */
export function resolveTeamAgents(team: Team): { role: string; agentId: string; name: string }[] {
  const agents = listAgents();
  const out: { role: string; agentId: string; name: string }[] = [];
  for (const slot of team.roles || []) {
    const agent = agents.find(a => a.id === slot.agentId);
    if (agent) out.push({ role: slot.slot, agentId: agent.id, name: agent.name });
  }
  for (const role of team.members) {
    if (out.some(entry => entry.role === role)) continue;
    const agent = agents.find(a => a.role === role || a.id === role || a.role.includes(role));
    if (agent) out.push({ role, agentId: agent.id, name: agent.name });
  }
  return out;
}

/** Suggest a team for a free-text goal from trigger keywords. */
export function suggestTeam(goal: string, workspaceId?: string): Team | undefined {
  const low = (goal || '').toLowerCase();
  let best: Team | undefined;
  let score = 0;
  for (const t of listTeams(workspaceId)) {
    const s = t.triggers.reduce((n, kw) => n + (low.includes(kw.toLowerCase()) ? 1 : 0), 0);
    if (s > score) { score = s; best = t; }
  }
  return score > 0 ? best : undefined;
}
