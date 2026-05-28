/**
 * Test Utilities for New Modules (#32)
 *
 * Provides helpers for setting up test databases, mock contexts, and seed data.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Test Database ----------

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Apply main schema
  const schemaPath = join(__dirname, '../db/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  return db;
}

// ---------- Mock Tenant Context ----------

export interface MockTenantContext {
  tenantContext: {
    tenantId: string;
    workspaceId: string;
    userId: string;
    role: string;
  };
}

export function createMockTenantContext(role: string = 'admin'): MockTenantContext {
  return {
    tenantContext: {
      tenantId: `tenant_${uuid().slice(0, 8)}`,
      workspaceId: `ws_${uuid().slice(0, 8)}`,
      userId: `user_${uuid().slice(0, 8)}`,
      role,
    },
  };
}

// ---------- Seed Data ----------

export function seedTestData(db: Database.Database): {
  agents: string[];
  tasks: string[];
  executions: string[];
} {
  const agents: string[] = [];
  const tasks: string[] = [];
  const executions: string[] = [];

  // Seed agents
  const agentStmt = db.prepare(
    `INSERT INTO agents (id, name, role, config, capabilities, triggers, created_at, updated_at)
     VALUES (?, ?, ?, '{}', '[]', '[]', datetime('now'), datetime('now'))`
  );
  for (let i = 0; i < 3; i++) {
    const id = `agent_test_${i}`;
    agentStmt.run(id, `Test Agent ${i}`, ['planner', 'coder', 'reviewer'][i]);
    agents.push(id);
  }

  // Seed tasks
  const taskStmt = db.prepare(
    `INSERT INTO tasks (id, title, description, mode, status, priority, input, assignee_id, created_at)
     VALUES (?, ?, ?, 'direct', ?, 'normal', '', ?, datetime('now'))`
  );
  const statuses = ['pending', 'running', 'done'];
  for (let i = 0; i < 5; i++) {
    const id = `task_test_${i}`;
    taskStmt.run(id, `Test Task ${i}`, `Description ${i}`, statuses[i % 3], agents[i % 3]);
    tasks.push(id);
  }

  // Seed task executions
  const execStmt = db.prepare(
    `INSERT INTO task_executions (id, task_id, agent_def_id, status, started_at)
     VALUES (?, ?, ?, 'done', datetime('now'))`
  );
  for (let i = 0; i < 3; i++) {
    const id = `exec_test_${i}`;
    execStmt.run(id, tasks[i], agents[i]);
    executions.push(id);
  }

  return { agents, tasks, executions };
}
