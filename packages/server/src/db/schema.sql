-- Agent Factory Database Schema v2
-- Key change: Agents are capability templates, runtime state lives in task_executions

-- Applied schema migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Agent Definitions (capability templates, no runtime status)
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  emoji TEXT DEFAULT '🤖',
  description TEXT,
  when_to_use TEXT DEFAULT '',
  skill_path TEXT,
  config JSON NOT NULL DEFAULT '{}',
  capabilities JSON NOT NULL DEFAULT '[]',
  triggers JSON NOT NULL DEFAULT '[]',
  allowed_tools JSON,
  disallowed_tools JSON,
  model TEXT,
  max_turns INTEGER,
  stats JSON NOT NULL DEFAULT '{"tasksCompleted":0,"tasksFailed":0,"avgDurationMs":0}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('master','direct','pipeline')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','assigned','running','review','done','failed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  assignee_id TEXT REFERENCES agents(id),
  created_by TEXT NOT NULL DEFAULT 'user',
  parent_task_id TEXT REFERENCES tasks(id),
  pipeline_id TEXT REFERENCES pipelines(id),
  stage_index INTEGER,
  input TEXT NOT NULL,
  output TEXT,
  workdir TEXT,
  error TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 2,
  depends_on JSON DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME
);

-- Skill registry and versioning
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  content TEXT NOT NULL,
  checksum TEXT NOT NULL,
  changelog TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'system',
  published_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME,
  archived_at DATETIME,
  UNIQUE(skill_id, version),
  UNIQUE(skill_id, checksum)
);

CREATE TABLE IF NOT EXISTS skill_assignments (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Task Executions (runtime instances - an agent working on a task)
CREATE TABLE IF NOT EXISTS task_executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_def_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','cancelled')),
  progress JSON NOT NULL DEFAULT '{"toolUseCount":0,"tokenCount":0,"recentActivities":[]}',
  cost_usd REAL DEFAULT 0,
  token_count INTEGER DEFAULT 0,
  parent_execution_id TEXT,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

-- Execution Messages (real-time activity stream)
CREATE TABLE IF NOT EXISTS execution_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('user_input','agent_text','tool_use','tool_result','progress','error')),
  content TEXT NOT NULL,
  tool_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tool Runtime catalog
CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK(risk_level IN ('low','medium','high')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  approval_required INTEGER NOT NULL DEFAULT 0 CHECK(approval_required IN (0,1)),
  input_schema JSON NOT NULL DEFAULT '{}',
  output_schema JSON NOT NULL DEFAULT '{}',
  metadata JSON NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tool_versions (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  input_schema JSON NOT NULL DEFAULT '{}',
  output_schema JSON NOT NULL DEFAULT '{}',
  implementation_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tool_id, version)
);

CREATE TABLE IF NOT EXISTS tool_permissions (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  approval_required INTEGER CHECK(approval_required IN (0,1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tool_id, agent_id)
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id),
  tool_version_id TEXT REFERENCES tool_versions(id),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  execution_id TEXT REFERENCES task_executions(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','blocked')),
  input_summary TEXT,
  input_hash TEXT,
  output_summary TEXT,
  error TEXT,
  duration_ms INTEGER,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS run_traces (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES task_executions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','cancelled')),
  summary TEXT,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  UNIQUE(execution_id)
);

CREATE TABLE IF NOT EXISTS trace_spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES run_traces(id) ON DELETE CASCADE,
  parent_span_id TEXT REFERENCES trace_spans(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','blocked')),
  metadata JSON NOT NULL DEFAULT '{}',
  error TEXT,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS model_registry (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'copilot-api',
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  capability_tags JSON NOT NULL DEFAULT '[]',
  cost_profile JSON NOT NULL DEFAULT '{}',
  max_tokens INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 0,
  fallback_group TEXT NOT NULL DEFAULT 'balanced',
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK(health_status IN ('unknown','healthy','degraded','disabled')),
  last_checked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS model_routes (
  route_key TEXT PRIMARY KEY,
  default_model_id TEXT REFERENCES model_registry(id) ON DELETE SET NULL,
  fallback_group TEXT NOT NULL DEFAULT 'balanced',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS model_health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES model_registry(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('healthy','degraded','disabled')),
  latency_ms INTEGER,
  error TEXT,
  checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS model_usage_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES model_registry(id),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  execution_id TEXT REFERENCES task_executions(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('success','failed')),
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  latency_ms INTEGER,
  route_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Agent Messages (inter-agent communication mailbox)
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_execution TEXT,
  to_execution TEXT,
  message_type TEXT NOT NULL CHECK(message_type IN ('task_handoff','progress_update','approval_request','approval_response','text')),
  content TEXT NOT NULL,
  consumed INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Task Logs
CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('info','warn','error','debug')),
  message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Pipelines
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template_id TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','paused','blocked','done','failed','awaiting_retry')),
  stages JSON NOT NULL DEFAULT '[]',
  current_stage_index INTEGER DEFAULT 0,
  gate_mode TEXT NOT NULL DEFAULT 'auto' CHECK(gate_mode IN ('auto','manual')),
  input TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

-- Pipeline Templates
CREATE TABLE IF NOT EXISTS pipeline_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  stages JSON NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  task_id TEXT,
  pipeline_id TEXT,
  read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Human-in-the-loop decision inbox
CREATE TABLE IF NOT EXISTS inbox_entries (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('approval','question','input','review')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','answered','cancelled')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  options JSON NOT NULL DEFAULT '[]',
  response TEXT,
  task_id TEXT REFERENCES tasks(id),
  pipeline_id TEXT REFERENCES pipelines(id),
  execution_id TEXT REFERENCES task_executions(id),
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME
);

-- Quality-loop review/fix attempt history
CREATE TABLE IF NOT EXISTS quality_loop_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reviewing','approved','needs_fix','fixing','fixed','skipped','failed')),
  review_task_id TEXT REFERENCES tasks(id),
  fix_task_id TEXT REFERENCES tasks(id),
  reviewer_agent_id TEXT REFERENCES agents(id),
  developer_agent_id TEXT REFERENCES agents(id),
  review_output TEXT,
  fix_output TEXT,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  UNIQUE(task_id, iteration)
);

-- Durable platform event stream for audit/debugging
CREATE TABLE IF NOT EXISTS platform_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warn','error')),
  task_id TEXT,
  pipeline_id TEXT,
  agent_id TEXT,
  execution_id TEXT,
  inbox_entry_id TEXT,
  quality_attempt_id TEXT,
  payload JSON NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Operator action audit log for control provenance
CREATE TABLE IF NOT EXISTS operator_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('admin','operator','viewer')),
  actor_source TEXT NOT NULL CHECK(actor_source IN ('local','token','proxy')),
  target_type TEXT NOT NULL CHECK(target_type IN ('task','pipeline','inbox','system','agent','tool','skill','model','template')),
  target_id TEXT,
  task_id TEXT,
  pipeline_id TEXT,
  inbox_entry_id TEXT,
  status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','failed')),
  metadata JSON NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS execution_audit_reports (
  execution_id TEXT PRIMARY KEY REFERENCES task_executions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  policy_snapshot JSON NOT NULL DEFAULT '{}',
  events JSON NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dynamic_workflows (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','dispatching','running','validating','done','failed','cancelled')),
  plan JSON NOT NULL DEFAULT '{}',
  task_ids JSON NOT NULL DEFAULT '[]',
  workspace_id TEXT NOT NULL DEFAULT 'default',
  result TEXT,
  validation_summary TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

-- Server-backed per-operator dashboard/preferences state
CREATE TABLE IF NOT EXISTS operator_preferences (
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('admin','operator','viewer')),
  actor_source TEXT NOT NULL CHECK(actor_source IN ('local','token','proxy')),
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSON NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_source, actor_role, actor_id, namespace, key)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_pipeline ON tasks(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_versions_status ON skill_versions(status);
CREATE INDEX IF NOT EXISTS idx_skill_assignments_skill ON skill_assignments(skill_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_executions_task ON task_executions(task_id);
CREATE INDEX IF NOT EXISTS idx_executions_agent ON task_executions(agent_def_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON task_executions(status);
CREATE INDEX IF NOT EXISTS idx_execution_messages_exec ON execution_messages(execution_id);
CREATE INDEX IF NOT EXISTS idx_tool_versions_tool ON tool_versions(tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_permissions_agent ON tool_permissions(agent_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_tool ON tool_executions(tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_task ON tool_executions(task_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_execution ON tool_executions(execution_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_agent ON tool_executions(agent_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_status ON tool_executions(status);
CREATE INDEX IF NOT EXISTS idx_run_traces_task ON run_traces(task_id);
CREATE INDEX IF NOT EXISTS idx_run_traces_execution ON run_traces(execution_id);
CREATE INDEX IF NOT EXISTS idx_trace_spans_trace ON trace_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_spans_type ON trace_spans(type);
CREATE INDEX IF NOT EXISTS idx_trace_spans_status ON trace_spans(status);
CREATE INDEX IF NOT EXISTS idx_model_registry_enabled ON model_registry(enabled);
CREATE INDEX IF NOT EXISTS idx_model_registry_group ON model_registry(fallback_group);
CREATE INDEX IF NOT EXISTS idx_model_health_model ON model_health_checks(model_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_model ON model_usage_stats(model_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_execution ON model_usage_stats(execution_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_agent ON model_usage_stats(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_execution, consumed);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_entries(status);
CREATE INDEX IF NOT EXISTS idx_inbox_task ON inbox_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_quality_loop_task ON quality_loop_attempts(task_id, iteration);
CREATE INDEX IF NOT EXISTS idx_platform_events_type ON platform_events(event_type);
CREATE INDEX IF NOT EXISTS idx_platform_events_task ON platform_events(task_id);
CREATE INDEX IF NOT EXISTS idx_platform_events_pipeline ON platform_events(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_platform_events_created ON platform_events(created_at);
CREATE INDEX IF NOT EXISTS idx_operator_actions_action ON operator_actions(action);
CREATE INDEX IF NOT EXISTS idx_operator_actions_actor ON operator_actions(actor_id);
CREATE INDEX IF NOT EXISTS idx_operator_actions_task ON operator_actions(task_id);
CREATE INDEX IF NOT EXISTS idx_operator_actions_pipeline ON operator_actions(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_operator_actions_created ON operator_actions(created_at);
CREATE INDEX IF NOT EXISTS idx_operator_preferences_actor ON operator_preferences(actor_source, actor_role, actor_id);
CREATE INDEX IF NOT EXISTS idx_operator_preferences_namespace ON operator_preferences(namespace);
CREATE INDEX IF NOT EXISTS idx_execution_audit_task ON execution_audit_reports(task_id);
CREATE INDEX IF NOT EXISTS idx_execution_audit_agent ON execution_audit_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_execution_audit_workspace ON execution_audit_reports(workspace_id);
CREATE INDEX IF NOT EXISTS idx_dynamic_workflows_status ON dynamic_workflows(status);
CREATE INDEX IF NOT EXISTS idx_dynamic_workflows_workspace ON dynamic_workflows(workspace_id);

-- Migrations (safe to re-run)
-- v3: Add workspace_path to tasks
-- Migration: 202604260001_add_workspace_path_to_tasks
ALTER TABLE tasks ADD COLUMN workspace_path TEXT;

-- Migration: 202604270001_add_operator_preferences
CREATE TABLE IF NOT EXISTS operator_preferences (
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('admin','operator','viewer')),
  actor_source TEXT NOT NULL CHECK(actor_source IN ('local','token','proxy')),
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSON NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_source, actor_role, actor_id, namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_operator_preferences_actor ON operator_preferences(actor_source, actor_role, actor_id);
CREATE INDEX IF NOT EXISTS idx_operator_preferences_namespace ON operator_preferences(namespace);

-- Migration: 202605100001_expand_operator_action_targets
CREATE TABLE IF NOT EXISTS operator_actions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('admin','operator','viewer')),
  actor_source TEXT NOT NULL CHECK(actor_source IN ('local','token','proxy')),
  target_type TEXT NOT NULL CHECK(target_type IN ('task','pipeline','inbox','system','agent','tool','skill','model','template')),
  target_id TEXT,
  task_id TEXT,
  pipeline_id TEXT,
  inbox_entry_id TEXT,
  status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','failed')),
  metadata JSON NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO operator_actions_new (
  id, action, actor_id, actor_role, actor_source, target_type, target_id,
  task_id, pipeline_id, inbox_entry_id, status, metadata, created_at
)
SELECT
  id, action, actor_id, actor_role, actor_source, target_type, target_id,
  task_id, pipeline_id, inbox_entry_id, status, metadata, created_at
FROM operator_actions;
DROP TABLE operator_actions;
ALTER TABLE operator_actions_new RENAME TO operator_actions;
CREATE INDEX IF NOT EXISTS idx_operator_actions_action ON operator_actions(action);
CREATE INDEX IF NOT EXISTS idx_operator_actions_actor ON operator_actions(actor_id);
CREATE INDEX IF NOT EXISTS idx_operator_actions_task ON operator_actions(task_id);
CREATE INDEX IF NOT EXISTS idx_operator_actions_pipeline ON operator_actions(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_operator_actions_created ON operator_actions(created_at);

-- Migration: 202605110001_add_skill_versioning
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  content TEXT NOT NULL,
  checksum TEXT NOT NULL,
  changelog TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'system',
  published_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME,
  archived_at DATETIME,
  UNIQUE(skill_id, version),
  UNIQUE(skill_id, checksum)
);
CREATE TABLE IF NOT EXISTS skill_assignments (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE task_executions ADD COLUMN skill_version_id TEXT REFERENCES skill_versions(id);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_versions_status ON skill_versions(status);
CREATE INDEX IF NOT EXISTS idx_skill_assignments_skill ON skill_assignments(skill_id);

-- Migration: 202605130001_add_workspace_id_to_core_tables
ALTER TABLE tasks ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE agents ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE pipelines ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE task_executions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE tools ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE skills ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE notifications ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE inbox_entries ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_pipelines_workspace ON pipelines(workspace_id);
CREATE INDEX IF NOT EXISTS idx_executions_workspace ON task_executions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tools_workspace ON tools(workspace_id);
CREATE INDEX IF NOT EXISTS idx_skills_workspace ON skills(workspace_id);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON notifications(workspace_id);
CREATE INDEX IF NOT EXISTS idx_inbox_workspace ON inbox_entries(workspace_id);

-- Migration: 202605210001_add_route_weight_to_agents
ALTER TABLE agents ADD COLUMN route_weight REAL DEFAULT 1.0;

-- Migration: 202605210002_add_stage_checkpoints_to_pipelines
ALTER TABLE pipelines ADD COLUMN stage_checkpoints TEXT DEFAULT '{}';

-- Migration: 202605290001_add_skill_registry_tables
CREATE TABLE IF NOT EXISTS skill_registry_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'github',
  url TEXT NOT NULL,
  branch TEXT DEFAULT 'main',
  path_prefix TEXT DEFAULT '',
  auth_token TEXT,
  last_synced_at TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skill_registry_catalog (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES skill_registry_sources(id),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  path TEXT NOT NULL,
  content_hash TEXT,
  tags TEXT DEFAULT '[]',
  is_structured INTEGER DEFAULT 0,
  last_synced_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_catalog_source ON skill_registry_catalog(source_id);

-- Migration: 202605300001_add_model_routing_tiers
ALTER TABLE model_registry ADD COLUMN model_tier TEXT NOT NULL DEFAULT 'balanced';
ALTER TABLE model_routes ADD COLUMN model_tier TEXT;
ALTER TABLE task_executions ADD COLUMN model_id TEXT;
ALTER TABLE task_executions ADD COLUMN model_tier TEXT;
ALTER TABLE task_executions ADD COLUMN model_route_source TEXT;
ALTER TABLE task_executions ADD COLUMN model_route_reason TEXT;
ALTER TABLE model_usage_stats ADD COLUMN model_tier TEXT;
ALTER TABLE model_usage_stats ADD COLUMN route_source TEXT;
ALTER TABLE model_usage_stats ADD COLUMN workspace_id TEXT DEFAULT 'default';
ALTER TABLE model_usage_stats ADD COLUMN pipeline_id TEXT;
ALTER TABLE model_usage_stats ADD COLUMN stage_index INTEGER;
CREATE INDEX IF NOT EXISTS idx_model_usage_workspace ON model_usage_stats(workspace_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_pipeline ON model_usage_stats(pipeline_id, stage_index);

-- Migration: 202606230001_add_domain_id_to_tasks
ALTER TABLE tasks ADD COLUMN domain_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_domain ON tasks(domain_id);

-- Migration: 202606240001_add_domain_id_to_pipelines
ALTER TABLE pipelines ADD COLUMN domain_id TEXT;

-- Migration: 202606280001_allow_pipeline_awaiting_retry_status
-- Runtime handles this migration by rebuilding the pipelines table because SQLite cannot ALTER CHECK constraints.
SELECT 1;

-- Migration: 202606280002_add_workspace_id_to_platform_events
ALTER TABLE platform_events ADD COLUMN workspace_id TEXT DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_platform_events_workspace ON platform_events(workspace_id);
