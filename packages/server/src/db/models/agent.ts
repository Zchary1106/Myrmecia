import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { AgentDefinition, AgentConfig, AgentStats } from '../../types.js';

function rowToAgent(row: any): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    emoji: row.emoji,
    description: row.description || undefined,
    whenToUse: row.when_to_use || '',
    skillPath: row.skill_path || undefined,
    config: JSON.parse(row.config),
    capabilities: JSON.parse(row.capabilities || '[]'),
    triggers: JSON.parse(row.triggers || '[]'),
    allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) : undefined,
    disallowedTools: row.disallowed_tools ? JSON.parse(row.disallowed_tools) : undefined,
    model: row.model || undefined,
    maxTurns: row.max_turns || undefined,
    stats: JSON.parse(row.stats),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAgent(data: {
  id?: string;
  name: string;
  role: string;
  emoji?: string;
  description?: string;
  whenToUse?: string;
  skillPath?: string;
  config?: AgentConfig;
  capabilities?: string[];
  triggers?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
}): AgentDefinition {
  const db = getDb();
  const id = data.id || uuid();
  const config = JSON.stringify(data.config || { maxConcurrent: 1, timeout: 300 });
  const stats = JSON.stringify({ tasksCompleted: 0, tasksFailed: 0, avgDurationMs: 0 });

  db.run(`
    INSERT INTO agents (id, name, role, emoji, description, when_to_use, skill_path, config, capabilities, triggers, allowed_tools, disallowed_tools, model, max_turns, stats)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    id, data.name, data.role, data.emoji || '🤖',
    data.description || '', data.whenToUse || '', data.skillPath || '',
    config,
    JSON.stringify(data.capabilities || []),
    JSON.stringify(data.triggers || []),
    data.allowedTools ? JSON.stringify(data.allowedTools) : null,
    data.disallowedTools ? JSON.stringify(data.disallowedTools) : null,
    data.model || null,
    data.maxTurns || null,
    stats
  );

  return getAgent(id)!;
}

export function getAgent(id: string): AgentDefinition | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM agents WHERE id = ?', id);
  return row ? rowToAgent(row) : undefined;
}

export function listAgents(filter?: { role?: string; workspaceId?: string }): AgentDefinition[] {
  const db = getDb();
  let sql = 'SELECT * FROM agents';
  const params: any[] = [];
  const conditions: string[] = [];

  if (filter?.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (filter?.role) { conditions.push('role = ?'); params.push(filter.role); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');

  return db.all(sql, ...params).map(rowToAgent);
}

export function updateAgent(id: string, updates: Partial<{
  name: string;
  role: string;
  emoji: string;
  description: string;
  whenToUse: string;
  skillPath: string;
  config: AgentConfig;
  capabilities: string[];
  triggers: string[];
  allowedTools: string[];
  disallowedTools: string[];
  model: string;
  maxTurns: number;
  stats: AgentStats;
}>): AgentDefinition | undefined {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
  if (updates.role !== undefined) { sets.push('role = ?'); params.push(updates.role); }
  if (updates.emoji !== undefined) { sets.push('emoji = ?'); params.push(updates.emoji); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.whenToUse !== undefined) { sets.push('when_to_use = ?'); params.push(updates.whenToUse); }
  if (updates.skillPath !== undefined) { sets.push('skill_path = ?'); params.push(updates.skillPath); }
  if (updates.config !== undefined) { sets.push('config = ?'); params.push(JSON.stringify(updates.config)); }
  if (updates.capabilities !== undefined) { sets.push('capabilities = ?'); params.push(JSON.stringify(updates.capabilities)); }
  if (updates.triggers !== undefined) { sets.push('triggers = ?'); params.push(JSON.stringify(updates.triggers)); }
  if (updates.allowedTools !== undefined) { sets.push('allowed_tools = ?'); params.push(JSON.stringify(updates.allowedTools)); }
  if (updates.disallowedTools !== undefined) { sets.push('disallowed_tools = ?'); params.push(JSON.stringify(updates.disallowedTools)); }
  if (updates.model !== undefined) { sets.push('model = ?'); params.push(updates.model); }
  if (updates.maxTurns !== undefined) { sets.push('max_turns = ?'); params.push(updates.maxTurns); }
  if (updates.stats !== undefined) { sets.push('stats = ?'); params.push(JSON.stringify(updates.stats)); }

  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);

  if (sets.length > 1) {
    db.run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`, ...params);
  }
  return getAgent(id);
}

export function deleteAgent(id: string): boolean {
  const db = getDb();
  const result = db.run('DELETE FROM agents WHERE id = ?', id);
  return result.changes > 0;
}
