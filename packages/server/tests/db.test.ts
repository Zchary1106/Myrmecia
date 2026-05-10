import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use in-memory DB for tests
let db: Database.Database;

function initTestDb() {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf-8');
  db.exec(schema);
  return db;
}

describe('Database Schema', () => {
  beforeEach(() => { db = initTestDb(); });
  afterEach(() => { db.close(); });

  it('should create all tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[];
    const names = tables.map(t => t.name);
    expect(names).toContain('agents');
    expect(names).toContain('tasks');
    expect(names).toContain('skills');
    expect(names).toContain('skill_versions');
    expect(names).toContain('skill_assignments');
    expect(names).toContain('task_logs');
    expect(names).toContain('pipelines');
    expect(names).toContain('pipeline_templates');
    expect(names).toContain('notifications');
    expect(names).toContain('inbox_entries');
    expect(names).toContain('quality_loop_attempts');
    expect(names).toContain('platform_events');
    expect(names).toContain('operator_actions');
    expect(names).toContain('operator_preferences');
    expect(names).toContain('tools');
    expect(names).toContain('tool_versions');
    expect(names).toContain('tool_permissions');
    expect(names).toContain('tool_executions');
    expect(names).toContain('run_traces');
    expect(names).toContain('trace_spans');
    expect(names).toContain('model_registry');
    expect(names).toContain('model_routes');
    expect(names).toContain('model_health_checks');
    expect(names).toContain('model_usage_stats');
  });

  it('should insert and retrieve an agent', () => {
    db.prepare(`
      INSERT INTO agents (id, name, role, emoji, config, stats)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('test-agent', 'Test Agent', 'dev', '🧪', '{"model":"claude-sonnet-4-20250514"}', '{"tasksCompleted":0}');

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get('test-agent') as any;
    expect(agent).toBeDefined();
    expect(agent.name).toBe('Test Agent');
    expect(agent.role).toBe('dev');
    expect(JSON.parse(agent.config).model).toBe('claude-sonnet-4-20250514');
  });

  it('should insert and retrieve a task', () => {
    // Need agent first for foreign key
    db.prepare(`
      INSERT INTO agents (id, name, role, config, stats)
      VALUES (?, ?, ?, ?, ?)
    `).run('agent1', 'Agent 1', 'dev', '{}', '{}');

    db.prepare(`
      INSERT INTO tasks (id, title, description, mode, status, priority, assignee_id, input, depends_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('task1', 'Test Task', 'Do something', 'direct', 'pending', 'high', 'agent1', 'test input', '[]');

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task1') as any;
    expect(task).toBeDefined();
    expect(task.title).toBe('Test Task');
    expect(task.mode).toBe('direct');
    expect(task.priority).toBe('high');
    expect(task.assignee_id).toBe('agent1');
  });

  it('should enforce valid task status', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO tasks (id, title, description, mode, status, input) VALUES (?, ?, ?, ?, ?, ?)
      `).run('bad1', 'Bad', 'Bad', 'direct', 'invalid_status', 'test');
    }).toThrow();
  });

  it('should enforce valid task mode', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO tasks (id, title, description, mode, input) VALUES (?, ?, ?, ?, ?)
      `).run('bad2', 'Bad', 'Bad', 'invalid_mode', 'test');
    }).toThrow();
  });

  it('should insert and retrieve task logs', () => {
    db.prepare(`INSERT INTO tasks (id, title, description, mode, input) VALUES (?, ?, ?, ?, ?)`).run(
      'task2', 'Task 2', 'Desc', 'direct', 'input'
    );
    db.prepare(`INSERT INTO task_logs (task_id, level, message, source) VALUES (?, ?, ?, ?)`).run(
      'task2', 'info', 'Started', 'system'
    );
    db.prepare(`INSERT INTO task_logs (task_id, level, message, source) VALUES (?, ?, ?, ?)`).run(
      'task2', 'error', 'Failed', 'agent1'
    );

    const logs = db.prepare('SELECT * FROM task_logs WHERE task_id = ? ORDER BY id').all('task2') as any[];
    expect(logs).toHaveLength(2);
    expect(logs[0].level).toBe('info');
    expect(logs[1].level).toBe('error');
  });

  it('should insert and retrieve pipelines with JSON stages', () => {
    const stages = JSON.stringify([
      { index: 0, name: 'Spec', agentRole: 'pm', status: 'pending' },
      { index: 1, name: 'Code', agentRole: 'dev', status: 'pending' },
    ]);
    db.prepare(`
      INSERT INTO pipelines (id, name, stages, gate_mode, input) VALUES (?, ?, ?, ?, ?)
    `).run('pipe1', 'Test Pipeline', stages, 'auto', 'Build something');

    const pipeline = db.prepare('SELECT * FROM pipelines WHERE id = ?').get('pipe1') as any;
    expect(pipeline).toBeDefined();
    const parsed = JSON.parse(pipeline.stages);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe('Spec');
  });

  it('should cascade delete task logs when task is deleted', () => {
    db.prepare(`INSERT INTO tasks (id, title, description, mode, input) VALUES (?, ?, ?, ?, ?)`).run(
      'task3', 'Task 3', 'Desc', 'direct', 'input'
    );
    db.prepare(`INSERT INTO task_logs (task_id, level, message, source) VALUES (?, ?, ?, ?)`).run(
      'task3', 'info', 'Log entry', 'system'
    );

    db.prepare('DELETE FROM tasks WHERE id = ?').run('task3');
    const logs = db.prepare('SELECT * FROM task_logs WHERE task_id = ?').all('task3') as any[];
    expect(logs).toHaveLength(0);
  });

  it('should track notifications with read status', () => {
    db.prepare(`
      INSERT INTO notifications (id, type, title, message) VALUES (?, ?, ?, ?)
    `).run('n1', 'task_complete', 'Done', 'Task completed');

    const unread = db.prepare('SELECT * FROM notifications WHERE read = 0').all() as any[];
    expect(unread).toHaveLength(1);

    db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run('n1');
    const afterRead = db.prepare('SELECT * FROM notifications WHERE read = 0').all() as any[];
    expect(afterRead).toHaveLength(0);
  });

  it('should persist inbox entries for human decisions', () => {
    db.prepare(`
      INSERT INTO inbox_entries (id, type, title, message, options, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('inbox1', 'approval', 'Review deploy', 'Approve production deploy?', '["Approve","Reject"]', 'agent');

    const entry = db.prepare('SELECT * FROM inbox_entries WHERE id = ?').get('inbox1') as any;
    expect(entry).toBeDefined();
    expect(entry.status).toBe('pending');
    expect(JSON.parse(entry.options)).toEqual(['Approve', 'Reject']);

    db.prepare('UPDATE inbox_entries SET status = ?, response = ?, responded_at = ? WHERE id = ?')
      .run('approved', 'Ship it', new Date().toISOString(), 'inbox1');

    const resolved = db.prepare('SELECT * FROM inbox_entries WHERE status = ?').all('approved') as any[];
    expect(resolved).toHaveLength(1);
    expect(resolved[0].response).toBe('Ship it');
  });

  it('should enforce valid inbox status transitions at schema level', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO inbox_entries (id, type, status, title, message)
        VALUES (?, ?, ?, ?, ?)
      `).run('inbox-bad', 'approval', 'waiting', 'Bad', 'Bad');
    }).toThrow();
  });

  it('should persist quality-loop attempt history per task iteration', () => {
    db.prepare(`INSERT INTO agents (id, name, role, config, stats) VALUES (?, ?, ?, ?, ?)`)
      .run('dev1', 'Dev', 'developer', '{}', '{}');
    db.prepare(`INSERT INTO agents (id, name, role, config, stats) VALUES (?, ?, ?, ?, ?)`)
      .run('review1', 'Review', 'reviewer', '{}', '{}');
    db.prepare(`INSERT INTO tasks (id, title, description, mode, assignee_id, input) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('task-quality', 'Quality', 'Quality', 'pipeline', 'dev1', 'input');
    db.prepare(`INSERT INTO tasks (id, title, description, mode, assignee_id, parent_task_id, input) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('review-task', 'Review', 'Review', 'direct', 'review1', 'task-quality', 'review');

    db.prepare(`
      INSERT INTO quality_loop_attempts (
        id, task_id, iteration, status, review_task_id, reviewer_agent_id, developer_agent_id, review_output
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ql1', 'task-quality', 1, 'needs_fix', 'review-task', 'review1', 'dev1', 'NEEDS_FIX');

    const attempts = db.prepare('SELECT * FROM quality_loop_attempts WHERE task_id = ?').all('task-quality') as any[];
    expect(attempts).toHaveLength(1);
    expect(attempts[0].iteration).toBe(1);
    expect(attempts[0].review_output).toBe('NEEDS_FIX');
  });

  it('should enforce one quality-loop attempt per task iteration', () => {
    db.prepare(`INSERT INTO tasks (id, title, description, mode, input) VALUES (?, ?, ?, ?, ?)`)
      .run('task-quality-unique', 'Quality', 'Quality', 'pipeline', 'input');
    db.prepare(`
      INSERT INTO quality_loop_attempts (id, task_id, iteration, status)
      VALUES (?, ?, ?, ?)
    `).run('ql-unique-1', 'task-quality-unique', 1, 'reviewing');

    expect(() => {
      db.prepare(`
        INSERT INTO quality_loop_attempts (id, task_id, iteration, status)
        VALUES (?, ?, ?, ?)
      `).run('ql-unique-2', 'task-quality-unique', 1, 'reviewing');
    }).toThrow();
  });

  it('should persist platform events for audit history', () => {
    db.prepare(`
      INSERT INTO platform_events (event_type, severity, task_id, payload)
      VALUES (?, ?, ?, ?)
    `).run('task:failed', 'error', 'task-event', '{"error":"boom"}');

    const event = db.prepare('SELECT * FROM platform_events WHERE task_id = ?').get('task-event') as any;
    expect(event).toBeDefined();
    expect(event.event_type).toBe('task:failed');
    expect(event.severity).toBe('error');
    expect(JSON.parse(event.payload).error).toBe('boom');
  });

  it('should enforce valid platform event severity', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO platform_events (event_type, severity, payload)
        VALUES (?, ?, ?)
      `).run('task:failed', 'critical', '{}');
    }).toThrow();
  });

  it('should persist operator action audit records', () => {
    db.prepare(`
      INSERT INTO operator_actions (
        action, actor_id, actor_role, actor_source, target_type, target_id, task_id, status, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('task.cancel', 'local-admin', 'admin', 'local', 'task', 'task-audit', 'task-audit', 'success', '{"reason":"test"}');

    const action = db.prepare('SELECT * FROM operator_actions WHERE target_id = ?').get('task-audit') as any;
    expect(action).toBeDefined();
    expect(action.action).toBe('task.cancel');
    expect(action.actor_role).toBe('admin');
    expect(JSON.parse(action.metadata).reason).toBe('test');

    db.prepare(`
      INSERT INTO operator_actions (action, actor_id, actor_role, actor_source, target_type, target_id, status, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('agent.update', 'local-admin', 'admin', 'local', 'agent', 'agent-audit', 'success', '{}');

    const agentAction = db.prepare('SELECT * FROM operator_actions WHERE target_id = ?').get('agent-audit') as any;
    expect(agentAction.target_type).toBe('agent');
  });

  it('should enforce valid operator roles and target types', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO operator_actions (action, actor_id, actor_role, actor_source, target_type)
        VALUES (?, ?, ?, ?, ?)
      `).run('task.cancel', 'bad', 'superuser', 'local', 'task');
    }).toThrow();

    expect(() => {
      db.prepare(`
        INSERT INTO operator_actions (action, actor_id, actor_role, actor_source, target_type)
        VALUES (?, ?, ?, ?, ?)
      `).run('task.cancel', 'bad', 'admin', 'local', 'database');
    }).toThrow();
  });

  it('should persist operator preferences per actor scope', () => {
    db.prepare(`
      INSERT INTO operator_preferences (actor_id, actor_role, actor_source, namespace, key, value)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('alice', 'operator', 'proxy', 'savedViews', 'work-queue', '[{"name":"Mine"}]');

    const preference = db.prepare(`
      SELECT * FROM operator_preferences
      WHERE actor_source = ? AND actor_role = ? AND actor_id = ? AND namespace = ? AND key = ?
    `).get('proxy', 'operator', 'alice', 'savedViews', 'work-queue') as any;

    expect(preference).toBeDefined();
    expect(JSON.parse(preference.value)).toEqual([{ name: 'Mine' }]);
  });

  it('should persist tool runtime catalog, permissions, and executions', () => {
    db.prepare(`
      INSERT INTO agents (id, name, role, config, stats)
      VALUES (?, ?, ?, ?, ?)
    `).run('tool-agent', 'Tool Agent', 'researcher', '{}', '{}');
    db.prepare(`
      INSERT INTO tasks (id, title, description, mode, assignee_id, input)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('tool-task', 'Tool Task', 'Tool Task', 'direct', 'tool-agent', 'input');
    db.prepare(`
      INSERT INTO task_executions (id, task_id, agent_def_id)
      VALUES (?, ?, ?)
    `).run('tool-exec', 'tool-task', 'tool-agent');
    db.prepare(`
      INSERT INTO tools (id, name, description, category, risk_level, input_schema)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('web.search', 'Web Search', 'Search web', 'research', 'medium', '{"type":"object"}');
    db.prepare(`
      INSERT INTO tool_versions (id, tool_id, version, implementation_ref)
      VALUES (?, ?, ?, ?)
    `).run('web.search@1.0.0', 'web.search', '1.0.0', 'agent_tools.py:web_search');
    db.prepare(`
      INSERT INTO tool_permissions (tool_id, agent_id, enabled)
      VALUES (?, ?, ?)
    `).run('web.search', 'tool-agent', 1);
    db.prepare(`
      INSERT INTO tool_executions (
        id, tool_id, tool_version_id, task_id, execution_id, agent_id, status, input_summary, input_hash, output_summary
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('tool-run-1', 'web.search', 'web.search@1.0.0', 'tool-task', 'tool-exec', 'tool-agent', 'done', '{"query":"agent"}', 'hash', '[]');

    const execution = db.prepare('SELECT * FROM tool_executions WHERE id = ?').get('tool-run-1') as any;
    expect(execution).toBeDefined();
    expect(execution.tool_id).toBe('web.search');
    expect(execution.status).toBe('done');
  });

  it('should persist run traces and trace spans', () => {
    db.prepare(`
      INSERT INTO agents (id, name, role, config, stats)
      VALUES (?, ?, ?, ?, ?)
    `).run('trace-agent', 'Trace Agent', 'developer', '{}', '{}');
    db.prepare(`
      INSERT INTO tasks (id, title, description, mode, assignee_id, input)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('trace-task', 'Trace Task', 'Trace Task', 'direct', 'trace-agent', 'input');
    db.prepare(`
      INSERT INTO task_executions (id, task_id, agent_def_id)
      VALUES (?, ?, ?)
    `).run('trace-exec', 'trace-task', 'trace-agent');
    db.prepare(`
      INSERT INTO run_traces (id, task_id, execution_id, agent_id, status)
      VALUES (?, ?, ?, ?, ?)
    `).run('trace-1', 'trace-task', 'trace-exec', 'trace-agent', 'running');
    db.prepare(`
      INSERT INTO trace_spans (id, trace_id, type, name, status, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('span-1', 'trace-1', 'prompt.build', 'Build prompt', 'done', '{"chars":123}');

    const span = db.prepare('SELECT * FROM trace_spans WHERE id = ?').get('span-1') as any;
    expect(span).toBeDefined();
    expect(span.type).toBe('prompt.build');
    expect(JSON.parse(span.metadata).chars).toBe(123);
  });

  it('should persist model registry, routes, health checks, and usage', () => {
    db.prepare(`
      INSERT INTO agents (id, name, role, config, stats)
      VALUES (?, ?, ?, ?, ?)
    `).run('model-agent', 'Model Agent', 'developer', '{}', '{}');
    db.prepare(`
      INSERT INTO tasks (id, title, description, mode, assignee_id, input)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('model-task', 'Model Task', 'Model Task', 'direct', 'model-agent', 'input');
    db.prepare(`
      INSERT INTO task_executions (id, task_id, agent_def_id)
      VALUES (?, ?, ?)
    `).run('model-exec', 'model-task', 'model-agent');
    db.prepare(`
      INSERT INTO model_registry (
        id, provider, display_name, description, capability_tags, fallback_group, priority
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('openai/gpt-test', 'copilot-api', 'GPT Test', 'Test model', '["test"]', 'test', 1);
    db.prepare(`
      INSERT INTO model_routes (route_key, default_model_id, fallback_group)
      VALUES (?, ?, ?)
    `).run('role:developer', 'openai/gpt-test', 'test');
    db.prepare(`
      INSERT INTO model_health_checks (model_id, status, latency_ms)
      VALUES (?, ?, ?)
    `).run('openai/gpt-test', 'healthy', 12);
    db.prepare(`
      INSERT INTO model_usage_stats (
        model_id, task_id, execution_id, agent_id, status, input_tokens, output_tokens, route_reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('openai/gpt-test', 'model-task', 'model-exec', 'model-agent', 'success', 10, 20, 'test');

    const route = db.prepare('SELECT * FROM model_routes WHERE route_key = ?').get('role:developer') as any;
    const usage = db.prepare('SELECT * FROM model_usage_stats WHERE execution_id = ?').get('model-exec') as any;
    expect(route.default_model_id).toBe('openai/gpt-test');
    expect(usage.input_tokens).toBe(10);
  });

  it('should persist skill versions, assignments, and execution linkage', () => {
    db.prepare(`
      INSERT INTO agents (id, name, role, config, stats)
      VALUES (?, ?, ?, ?, ?)
    `).run('skill-agent', 'Skill Agent', 'writer', '{}', '{}');
    db.prepare(`
      INSERT INTO tasks (id, title, description, mode, assignee_id, input)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('skill-task', 'Skill Task', 'Skill Task', 'direct', 'skill-agent', 'input');
    db.prepare(`
      INSERT INTO skills (id, name, description, source_path)
      VALUES (?, ?, ?, ?)
    `).run('writer', 'Writer Skill', 'Writes', 'agents/writer.md');
    db.prepare(`
      INSERT INTO skill_versions (id, skill_id, version, status, content, checksum, changelog, created_by, published_by, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run('writer_v1', 'writer', 1, 'published', '# Writer', 'abc123', 'initial', 'system', 'system');
    db.prepare(`
      INSERT INTO skill_assignments (agent_id, skill_id, skill_version_id)
      VALUES (?, ?, ?)
    `).run('skill-agent', 'writer', 'writer_v1');
    db.prepare(`
      INSERT INTO task_executions (id, task_id, agent_def_id, skill_version_id)
      VALUES (?, ?, ?, ?)
    `).run('skill-exec', 'skill-task', 'skill-agent', 'writer_v1');

    const assignment = db.prepare('SELECT * FROM skill_assignments WHERE agent_id = ?').get('skill-agent') as any;
    const execution = db.prepare('SELECT * FROM task_executions WHERE id = ?').get('skill-exec') as any;
    expect(assignment.skill_version_id).toBe('writer_v1');
    expect(execution.skill_version_id).toBe('writer_v1');
  });
});
