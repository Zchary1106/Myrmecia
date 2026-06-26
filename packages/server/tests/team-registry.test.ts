/**
 * Team Registry — YAML built-in teams overlaid by DB custom teams, with CRUD,
 * built-in override/revert, role resolution, and keyword-based suggestion.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import {
  loadTeams, listTeams, getTeam, createTeam, updateTeam, deleteTeam,
  resolveTeamAgents, suggestTeam,
} from '../src/agents/team-registry.js';

function writeTeamsYaml(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-factory-teams-'));
  const p = join(dir, 'teams.yaml');
  writeFileSync(p, [
    'teams:',
    '  - id: feature',
    '    name: Feature Squad',
    '    emoji: 🚀',
    '    lead: master',
    '    members: [product-manager, developer, tester]',
    '    triggers: [feature, build a]',
    '    blurb: Ships features end to end',
  ].join('\n'), 'utf-8');
  return p;
}

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-teams-db-')), 'test.db');
  getDb();
  loadTeams(writeTeamsYaml());
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
});

describe('Team Registry', () => {
  it('loads the built-in team from YAML', () => {
    const teams = listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0].id).toBe('feature');
    expect(teams[0].builtin).toBe(true);
    expect(teams[0].members).toEqual(['product-manager', 'developer', 'tester']);
  });

  it('resolves a team id case-insensitively and strips a leading @', () => {
    expect(getTeam('@FEATURE')?.id).toBe('feature');
  });

  it('creates a custom team (slugged id) listed alongside built-ins', () => {
    const created = createTeam({ name: 'Bug Fixers', members: ['developer', 'tester'] });
    expect(created.id).toBe('bug-fixers');
    expect(created.builtin).toBe(false);
    expect(listTeams().map(t => t.id).sort()).toEqual(['bug-fixers', 'feature']);
  });

  it('rejects a team without members', () => {
    expect(() => createTeam({ name: 'Empty', members: [] })).toThrow(/member/);
  });

  it('rejects a duplicate team id', () => {
    expect(() => createTeam({ id: 'feature', name: 'Dup', members: ['developer'] })).toThrow(/exists/);
  });

  it('materializes a built-in as a custom override when edited', () => {
    const updated = updateTeam('feature', { blurb: 'Custom blurb' });
    expect(updated.blurb).toBe('Custom blurb');
    expect(updated.builtin).toBe(false);
    expect(getTeam('feature')?.blurb).toBe('Custom blurb');
  });

  it('deleting an overridden built-in reverts to the built-in', () => {
    updateTeam('feature', { blurb: 'Custom blurb' });
    const result = deleteTeam('feature');
    expect(result.reverted).toBe(true);
    expect(getTeam('feature')?.builtin).toBe(true);
    expect(getTeam('feature')?.blurb).toBe('Ships features end to end');
  });

  it('refuses to delete a pure built-in (not a custom team)', () => {
    // No custom override exists yet for "feature".
    expect(() => deleteTeam('feature')).toThrow(/not a custom team/);
  });

  it('resolves member roles to concrete agents', () => {
    createAgent({ id: 'pm', name: 'PM', role: 'product-manager' });
    createAgent({ id: 'dev', name: 'Dev', role: 'developer' });
    createAgent({ id: 'qa', name: 'QA', role: 'tester' });
    const roster = resolveTeamAgents(getTeam('feature')!);
    expect(roster.map(r => r.agentId).sort()).toEqual(['dev', 'pm', 'qa']);
  });

  it('suggests a team by trigger keyword and returns undefined when nothing matches', () => {
    expect(suggestTeam('please build a feature for me')?.id).toBe('feature');
    expect(suggestTeam('unrelated request about weather')).toBeUndefined();
  });
});
