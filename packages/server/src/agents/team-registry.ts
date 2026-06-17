import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { listAgents } from '../db/models/agent.js';
import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Team {
  id: string;
  name: string;
  emoji: string;
  lead: string;
  members: string[];      // member roles
  template?: string;      // optional pipeline template name (legacy/fallback)
  triggers: string[];
  blurb: string;
  builtin?: boolean;      // true for teams.yaml defaults (not deletable)
}

let BUILTIN: Team[] = [];

function candidatePaths(): string[] {
  return [
    join(__dirname, '../../../../agents/teams.yaml'),
    join(__dirname, '../../../agents/teams.yaml'),
    join(process.cwd(), 'agents/teams.yaml'),
    join(process.cwd(), '../agents/teams.yaml'),
  ];
}

function normalize(t: any, builtin: boolean): Team {
  return {
    id: String(t.id),
    name: t.name || t.id,
    emoji: t.emoji || '•',
    lead: t.lead || 'master',
    members: Array.isArray(t.members) ? t.members.map(String) : [],
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
}

export function createTeam(input: TeamInput, workspaceId = 'default'): Team {
  const id = slug(input.id || input.name);
  if (!id) throw new Error('team id/name is required');
  if (BUILTIN.some(t => t.id === id) || listCustom().some(t => t.id === id)) {
    throw new Error(`team "${id}" already exists`);
  }
  if (!input.members?.length) throw new Error('a team needs at least one member role');
  const db = getDb();
  db.run(
    'INSERT INTO team_definitions (id, name, emoji, lead, members, template, triggers, blurb, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, input.name, input.emoji || '🐜', input.lead || 'master',
    JSON.stringify(input.members), input.template || null,
    JSON.stringify(input.triggers || []), input.blurb || '', workspaceId,
  );
  return getTeam(id)!;
}

export function updateTeam(id: string, patch: Partial<TeamInput>, workspaceId = 'default'): Team {
  const db = getDb();
  const existing = listCustom().find(t => t.id === id);
  if (!existing) {
    // Editing a built-in: materialize it as a custom override.
    const base = BUILTIN.find(t => t.id === id);
    if (!base) throw new Error(`team "${id}" not found`);
    return createTeamOverride(base, patch, workspaceId);
  }
  const merged = { ...existing, ...patch };
  db.run(
    'UPDATE team_definitions SET name = ?, emoji = ?, lead = ?, members = ?, template = ?, triggers = ?, blurb = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    merged.name, merged.emoji, merged.lead,
    JSON.stringify(merged.members), merged.template || null,
    JSON.stringify(merged.triggers || []), merged.blurb || '', id,
  );
  return getTeam(id)!;
}

function createTeamOverride(base: Team, patch: Partial<TeamInput>, workspaceId: string): Team {
  const merged = { ...base, ...patch };
  getDb().run(
    'INSERT INTO team_definitions (id, name, emoji, lead, members, template, triggers, blurb, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    base.id, merged.name, merged.emoji, merged.lead,
    JSON.stringify(merged.members), merged.template || null,
    JSON.stringify(merged.triggers || []), merged.blurb || '', workspaceId,
  );
  return getTeam(base.id)!;
}

export function deleteTeam(id: string): { reverted: boolean } {
  const custom = listCustom().find(t => t.id === id);
  if (!custom) throw new Error(`team "${id}" is not a custom team`);
  getDb().run('DELETE FROM team_definitions WHERE id = ?', id);
  // If a built-in with this id exists, deletion just reverts to the built-in.
  return { reverted: BUILTIN.some(t => t.id === id) };
}

/** Resolve a team's member roles to concrete agent ids that currently exist. */
export function resolveTeamAgents(team: Team): { role: string; agentId: string; name: string }[] {
  const agents = listAgents();
  const out: { role: string; agentId: string; name: string }[] = [];
  for (const role of team.members) {
    const agent = agents.find(a => a.role === role || a.id === role || a.role.includes(role));
    if (agent) out.push({ role, agentId: agent.id, name: agent.name });
  }
  return out;
}

/** Suggest a team for a free-text goal from trigger keywords. */
export function suggestTeam(goal: string): Team | undefined {
  const low = (goal || '').toLowerCase();
  let best: Team | undefined;
  let score = 0;
  for (const t of listTeams()) {
    const s = t.triggers.reduce((n, kw) => n + (low.includes(kw.toLowerCase()) ? 1 : 0), 0);
    if (s > score) { score = s; best = t; }
  }
  return score > 0 ? best : undefined;
}
