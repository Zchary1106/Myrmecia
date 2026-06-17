import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { listAgents } from '../db/models/agent.js';
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
}

let TEAMS: Team[] = [];

function candidatePaths(): string[] {
  return [
    join(__dirname, '../../../../agents/teams.yaml'),
    join(__dirname, '../../../agents/teams.yaml'),
    join(process.cwd(), 'agents/teams.yaml'),
    join(process.cwd(), '../agents/teams.yaml'),
  ];
}

/** Load teams from agents/teams.yaml. Safe to call multiple times. */
export function loadTeams(explicitPath?: string): Team[] {
  const path = explicitPath || candidatePaths().find(p => existsSync(p));
  if (!path || !existsSync(path)) {
    logger.warn('teams.yaml not found — agent teams disabled');
    TEAMS = [];
    return TEAMS;
  }
  try {
    const parsed = parseYaml(readFileSync(path, 'utf-8')) as { teams?: Team[] };
    TEAMS = (parsed.teams || []).map(t => ({
      id: String(t.id),
      name: t.name || t.id,
      emoji: t.emoji || '•',
      lead: t.lead || 'master',
      members: Array.isArray(t.members) ? t.members.map(String) : [],
      template: t.template,
      triggers: Array.isArray(t.triggers) ? t.triggers.map(String) : [],
      blurb: t.blurb || '',
    }));
    logger.info({ count: TEAMS.length, path }, 'Loaded agent teams');
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to parse teams.yaml');
    TEAMS = [];
  }
  return TEAMS;
}

export function listTeams(): Team[] {
  return TEAMS;
}

export function getTeam(id: string): Team | undefined {
  const key = (id || '').toLowerCase().replace(/^@/, '');
  return TEAMS.find(t => t.id.toLowerCase() === key);
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
  for (const t of TEAMS) {
    const s = t.triggers.reduce((n, kw) => n + (low.includes(kw.toLowerCase()) ? 1 : 0), 0);
    if (s > score) { score = s; best = t; }
  }
  return score > 0 ? best : undefined;
}
