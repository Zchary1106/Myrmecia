# API Reference: Agent Factory

## Base URL

```
http://localhost:3000/api
```

## Authentication

None by default in local mode. Set `API_AUTH_TOKEN` on the server to require `Authorization: Bearer <token>` for all `/api/*` routes except `/api/health`.

Dashboard requests send a token automatically when either of these is configured:

- `VITE_API_AUTH_TOKEN` at dashboard build/dev-server time;
- `localStorage["agentFactory.apiToken"]` at runtime.

The dashboard Settings page can write the runtime localStorage token and run connection diagnostics without rebuilding the dashboard.

WebSocket connections use the same token as `ws://host/ws?token=<token>` when configured. Use HTTPS/WSS or a trusted reverse proxy for remote deployments.

## Operator Identity

Operator controls are recorded in `/api/operator-actions`. Local unauthenticated requests are attributed to `local-admin`; token-authenticated requests are attributed to `token-admin`. A trusted reverse proxy can pass explicit operator provenance with:

```http
X-Operator-Id: alice
X-Operator-Role: operator
```

`X-Operator-Role` accepts `admin`, `operator`, or `viewer`. Invalid or missing roles default to `admin`; proxy identity is only used when `X-Operator-Id` is present.

Role enforcement applies to operator controls:

| Role | Allowed controls |
|------|------------------|
| `admin` | All launch/runtime/config controls, including task delete. |
| `operator` | Launch and runtime/config controls: Agent create/update/execute, Tool/Model policy updates, task create/cancel/retry, pipeline create/approve/skip/cancel, and inbox responses. |
| `viewer` | Read-only API access; launch/control/config requests return `403 OPERATOR_FORBIDDEN`. |

Local mode and token-authenticated requests without proxy identity headers default to `admin` for backward-compatible single-operator deployments.

Audit records use `targetType` values: `task`, `pipeline`, `inbox`, `system`, `agent`, `tool`, `skill`, `model`, and `template`.

## Error Contract

All API errors use the same envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request body validation failed",
    "details": []
  }
}
```

Common status codes:

| Status | Code | Meaning |
|--------|------|---------|
| 401 | `AUTH_REQUIRED` | API auth is enabled and no Bearer token was supplied. |
| 401 | `AUTH_INVALID` | API auth is enabled and the supplied token did not match. |
| 400 | `VALIDATION_FAILED` | Body or query parameters failed schema validation. |
| 403 | `OPERATOR_FORBIDDEN` | The operator role is not allowed to perform the requested control action. |
| 404 | `*_NOT_FOUND` | The requested task, pipeline, inbox item, or resource does not exist. |
| 409 | `CONFIRMATION_REQUIRED` | The operation is destructive and must include explicit confirmation. |
| 500 | `INTERNAL` | Unexpected server-side failure. |

Destructive operator controls require either `"confirm": true` or `"confirmation": "<operation>"` in the JSON body. Current operation names are `task.cancel`, `task.delete`, and `pipeline.cancel`. Permission checks run before confirmation checks, so a read-only viewer receives `403 OPERATOR_FORBIDDEN` instead of a confirmation challenge.

---

## Tasks

### Create Task

```http
POST /api/tasks
Content-Type: application/json

{
  "title": "Build a weather widget",
  "description": "Create a React weather widget that shows current temp and 5-day forecast",
  "mode": "master",          // "master" | "direct" | "pipeline"
  "priority": "normal",      // "low" | "normal" | "high" | "urgent"
  "assigneeId": null,        // required for mode=direct
  "pipelineTemplateId": null // required for mode=pipeline
}
```

**Response: 201**
```json
{
  "id": "task_abc123",
  "title": "Build a weather widget",
  "status": "pending",
  "mode": "master",
  "createdAt": "2025-01-15T10:00:00Z"
}
```

### List Tasks

```http
GET /api/tasks?status=running&mode=direct&assignee=agent_pm&limit=20&offset=0
```

### Get Task Detail

```http
GET /api/tasks/:id
```

**Response includes:**
- Full task data
- Recent log entries (last 100)
- Subtasks (if master mode)
- Pipeline info (if pipeline mode)

### Update Task

```http
PATCH /api/tasks/:id
Content-Type: application/json

{
  "status": "cancelled",     // cancel a task
  "assigneeId": "agent_dev"  // reassign
}
```

### Task Controls

```http
POST /api/tasks/:id/cancel
Content-Type: application/json

{ "confirm": true }
```

Cancels pending, queued, assigned, or running work. Without confirmation the response is `409 CONFIRMATION_REQUIRED`.

```http
POST /api/tasks/:id/retry
```

Retries a failed or cancelled task with the same assignment and input.

```http
DELETE /api/tasks/:id
Content-Type: application/json

{ "confirm": true }
```

### Get Task Logs

```http
GET /api/tasks/:id/logs?limit=100&since=2025-01-15T10:00:00Z
```

### Quality-loop Attempt History

```http
GET /api/tasks/:id/quality-attempts
```

Returns persisted review/fix rounds for a pipeline task. Each attempt includes `iteration`, `status`, optional review/fix task IDs, outputs, errors, and timestamps.

---

## Agents

### List Agents

```http
GET /api/agents
```

**Response:**
```json
[
  {
    "id": "agent_pm",
    "name": "PM Agent",
    "role": "pm",
    "status": "idle",
    "currentTaskId": null,
    "stats": {
      "tasksCompleted": 12,
      "tasksFailed": 1,
      "avgDurationMs": 45000
    }
  }
]
```

### Create Custom Agent

```http
POST /api/agents
Content-Type: application/json

{
  "name": "Security Auditor",
  "role": "custom",
  "description": "Review code for security vulnerabilities and risky defaults.",
  "allowedTools": ["web.search", "web.fetch"],
  "model": "openai/claude-sonnet-4.6",
  "config": {
    "model": "openai/claude-sonnet-4.6",
    "maxConcurrent": 1,
    "timeout": 300
  }
}
```

Requires `admin` or `operator`; records `agent.create`.

### Update Agent

```http
PATCH /api/agents/:id
Content-Type: application/json

{
  "description": "Updated runtime profile",
  "allowedTools": ["web.search", "web.fetch"],
  "model": "openai/claude-sonnet-4.6"
}
```

Requires `admin` or `operator`; records `agent.update` with before/after metadata.

### Execute Agent

```http
POST /api/agents/:id/execute
Content-Type: application/json

{
  "prompt": "Research the market",
  "priority": "high"
}
```

Requires `admin` or `operator`; records `agent.execute` with the created task ID.

### Start/Stop Agent

```http
POST /api/agents/:id/start
POST /api/agents/:id/stop
```

---

## Executions and Run Trace

### List Executions

```http
GET /api/executions?taskId=task_123&agentDefId=dev&status=done&limit=50
```

### Execution Messages

```http
GET /api/executions/:id/messages?afterId=100&limit=200
```

Returns the legacy message stream: user input, agent text, tool use/results, progress, and errors.

### Structured Run Trace

```http
GET /api/executions/:id/trace
```

Returns a `RunTrace` with ordered spans. New executions include spans for:

| Span type | Meaning |
| --- | --- |
| `agent.start` | Root Agent execution span |
| `prompt.build` | Runtime prompt composition and tool policy summary |
| `model.route` | Selected model and selection source |
| `llm.call` | Agent runtime / LLM call duration and result metadata |
| `permission.check` | Tool policy decisions, including blocked tools |
| `tool.call` | Actual tool invocation emitted by Python tool runtime |

Older executions created before Run Trace support may return `null`.

---

## Tool Runtime

### List Tools

```http
GET /api/tools
GET /api/tools?enabled=true&category=research
```

Returns the governed tool catalog, including `riskLevel`, `enabled`, `approvalRequired`, JSON input/output schemas, and metadata.

### Update Tool Policy

```http
PATCH /api/tools/:id
Content-Type: application/json

{
  "enabled": true,
  "approvalRequired": false
}
```

Requires `admin` or `operator`. The change is recorded in `/api/operator-actions` and broadcasts `tool:updated`.

### Per-Agent Permission

```http
PUT /api/tools/:id/permissions/:agentId
Content-Type: application/json

{
  "enabled": true,
  "approvalRequired": false
}
```

Agent runtime resolves tools in this order: Agent `allowedTools` → registry exists → tool enabled → per-Agent permission → approval requirement. Blocked tools are not passed to agent execution.

### Tool Executions

```http
GET /api/tools/executions?toolId=web.search&agentId=pm&status=done&limit=50
GET /api/tools/:id/executions
```

Python tools emit `tool_use` and `tool_result` events. The server persists each call in `tool_executions` with input summary/hash, output summary, status, duration, task, execution, and agent references.

---

## Skill Versioning

### List and Inspect Skills

```http
GET /api/skills
GET /api/skills/:id
GET /api/skills/assignments
```

Startup imports `agents/*.md` as published skill versions and assigns matching preset Agents by `skillPath`. Skill detail includes every version and current Agent assignments.

### Create Skill and Version

```http
POST /api/skills
Content-Type: application/json

{
  "id": "security-reviewer",
  "name": "Security Reviewer",
  "description": "Reviews code for vulnerabilities"
}
```

```http
POST /api/skills/security-reviewer/versions
Content-Type: application/json

{
  "content": "# Security Reviewer\n\nReview code for risky defaults.",
  "changelog": "Initial draft",
  "status": "draft"
}
```

Requires `admin` or `operator`; records `skill.create` and `skill.version.create`.

### Edit, Publish, Archive

```http
PATCH /api/skills/versions/security-reviewer_v1
POST /api/skills/versions/security-reviewer_v1/publish
POST /api/skills/versions/security-reviewer_v1/archive
```

Only draft versions are editable. Published versions are immutable and can be assigned to Agents; archived versions cannot be published or assigned.

### Assign or Roll Back an Agent

```http
PUT /api/skills/assignments/agent_review
Content-Type: application/json

{
  "skillVersionId": "security-reviewer_v2"
}
```

Only published versions can be assigned. New executions persist the assigned `skillVersionId`, and `prompt.build` trace spans include `skillId`, version number, checksum, and whether the skill came from an explicit assignment or the Agent `skillPath` fallback.

---

## Model Registry and Routing

### List Models

```http
GET /api/models
GET /api/models?enabled=true
```

Returns the server-side model catalog used by the Agent Builder dropdown. Model IDs include `/`, so callers must URL-encode IDs when using item routes, for example `openai%2Fclaude-sonnet-4.6`.

### Update Model Policy

```http
PATCH /api/models/openai%2Fclaude-sonnet-4.6
Content-Type: application/json

{
  "enabled": true,
  "priority": 90,
  "fallbackGroup": "balanced"
}
```

Requires `admin` or `operator`; records `model.update`. Disabled models are skipped by new runtime route selection even if an Agent explicitly requested them.

### Model Health Check

```http
POST /api/models/openai%2Fclaude-sonnet-4.6/health-check
```

Records a lightweight local health status row and returns the updated model. The current v1 check marks enabled models healthy and disabled models disabled.

### Model Routes

```http
GET /api/models/routes
PATCH /api/models/routes
Content-Type: application/json

{
  "routeKey": "role:developer",
  "defaultModelId": "openai/gpt-5.3-codex",
  "fallbackGroup": "coding"
}
```

Routes support `global` and `role:<agent.role>` keys. Runtime selection order is explicit Agent model, Agent config model, role route, global route, fallback group, then final environment/default fallback. Each execution records the selected model and route reason in the `model.route` trace span and `model_usage_stats`.

---

## Pipelines

### Create Pipeline

```http
POST /api/pipelines
Content-Type: application/json

{
  "name": "Build Todo App",
  "templateId": "full-product",
  "input": "Build a todo app with React, categories, due dates, and drag-to-reorder",
  "gateMode": "auto"         // "auto" | "manual"
}
```

### Get Pipeline Status

```http
GET /api/pipelines/:id
```

**Response:**
```json
{
  "id": "pipe_xyz789",
  "name": "Build Todo App",
  "status": "running",
  "currentStageIndex": 2,
  "stages": [
    { "index": 0, "name": "Spec", "status": "done", "output": "..." },
    { "index": 1, "name": "Design", "status": "done", "output": "..." },
    { "index": 2, "name": "Code", "status": "running", "taskId": "task_abc" },
    { "index": 3, "name": "Test", "status": "pending" },
    { "index": 4, "name": "Deploy", "status": "pending" }
  ]
}
```

### Pipeline Controls

```http
POST /api/pipelines/:id/approve   # Approve gate → advance to next stage
POST /api/pipelines/:id/skip      # Skip current stage
POST /api/pipelines/:id/cancel    # Cancel entire pipeline, requires { "confirm": true }
```

---

## Templates

### List Templates

```http
GET /api/templates
GET /api/templates/:id
```

### Create Template

```http
POST /api/templates
Content-Type: application/json

{
  "name": "Bugfix Pipeline",
  "description": "Quick bug triage and fix",
  "stages": [
    { "name": "Triage", "role": "pm", "promptTemplate": "Analyze this bug: {input}" },
    { "name": "Fix", "role": "dev", "promptTemplate": "Fix the bug: {input}" },
    { "name": "Test", "role": "qa", "promptTemplate": "Verify the fix: {input}" }
  ]
}
```

Requires `admin` or `operator`; records `template.create`.

### Update Template

```http
PATCH /api/templates/:id
Content-Type: application/json

{
  "description": "Updated in the visual builder",
  "stages": [
    { "name": "Spec", "role": "product-manager", "promptTemplate": "Analyze: {input}" },
    { "name": "Code", "role": "developer", "promptTemplate": "Implement from: {input}" }
  ]
}
```

Requires `admin` or `operator`; records `template.update`.

### Validate Template

```http
POST /api/templates/validate
POST /api/templates/:id/validate
```

Validation catches empty stage names, missing roles, empty prompts, and roles with no available Agent. It also warns when a prompt does not include `{input}`.

---

## WebSocket

### Connect

```javascript
const ws = new WebSocket('ws://localhost:3000/ws')
```

### Subscribe to Channels

```json
{ "type": "subscribe", "channel": "tasks" }
{ "type": "subscribe", "channel": "agents" }
{ "type": "subscribe", "channel": "task:task_abc123" }
{ "type": "subscribe", "channel": "agent:agent_dev" }
{ "type": "subscribe", "channel": "pipeline:pipe_xyz789" }
```

### Event Types

| Event | Channel | Payload |
|-------|---------|---------|
| `task:created` | tasks | `{ task }` |
| `task:assigned` | tasks, task:{id} | `{ taskId, agentId }` |
| `task:started` | tasks, task:{id} | `{ taskId }` |
| `task:log` | task:{id}, agent:{id} | `{ taskId, log: LogEntry }` |
| `task:done` | tasks, task:{id} | `{ taskId, output }` |
| `task:failed` | tasks, task:{id} | `{ taskId, error }` |
| `agent:status` | agents, agent:{id} | `{ agentId, status }` |
| `pipeline:stage:started` | pipeline:{id} | `{ pipelineId, stageIndex }` |
| `pipeline:stage:done` | pipeline:{id} | `{ pipelineId, stageIndex, output }` |
| `pipeline:done` | pipelines | `{ pipelineId }` |
| `pipeline:failed` | pipelines | `{ pipelineId, stageIndex, error }` |
| `inbox:created` | inbox | `{ inboxEntryId, entry }` |
| `inbox:updated` | inbox | `{ inboxEntryId, entry }` |
| `quality:updated` | quality, task:{id} | `{ taskId, attempt }` |
| `tool:started` | tools, tool:{id}, execution:{id} | `{ toolExecutionId, toolId, taskId, executionId, agentId }` |
| `tool:done` | tools, tool:{id}, execution:{id} | `{ toolExecutionId, toolId, status, durationMs }` |
| `tool:failed` | tools, tool:{id}, execution:{id} | `{ toolExecutionId, toolId, error }` |
| `tool:blocked` | tools, tool:{id}, execution:{id} | `{ toolId, reason }` |
| `tool:updated` | tools, tool:{id} | `{ toolId, policy }` |
| `skill:updated` | skills, skill:{id} | `{ skillId, skillVersionId }` |
| `skill:published` | skills, skill:{id} | `{ skillId, skillVersionId }` |
| `skill:assigned` | skills, skill:{id}, agent:{id} | `{ skillId, skillVersionId, agentId }` |
| `notification` | notifications | `{ notification }` |

---

## System

### Health Check

```http
GET /api/health
```

```json
{
  "status": "ok",
  "uptime": 3600,
  "agents": { "total": 6, "active": 3, "idle": 3 },
  "tasks": { "running": 2, "queued": 5 },
  "pipelines": { "active": 1 }
}
```

### System Stats

```http
GET /api/stats
```

```json
{
  "totalTasks": 156,
  "completedTasks": 140,
  "failedTasks": 8,
  "avgTaskDuration": 52000,
  "agentStats": [...],
  "pipelineStats": [...]
}
```

### Durable Event History

```http
GET /api/events?severity=error&taskId=task_abc&limit=100
```

Returns persisted platform events recorded from the EventBus. Filters include `eventType`, `severity`, `taskId`, `pipelineId`, and `limit`.

### Operator Action Audit

```http
GET /api/operator-actions?actorId=alice&targetType=task&taskId=task_abc&limit=100
```

Returns durable control-plane actions such as task cancel/retry/delete, pipeline approve/skip/cancel, and inbox responses. Filters include `action`, `actorId`, `targetType`, `taskId`, `pipelineId`, `inboxEntryId`, and `limit`.

Each record includes the actor (`id`, `role`, `source`), target identifiers, action metadata, and `createdAt`.

### Operator Preferences

```http
GET /api/operator-preferences?namespace=savedViews
GET /api/operator-preferences/:namespace/:key
PUT /api/operator-preferences/:namespace/:key
DELETE /api/operator-preferences/:namespace/:key
```

Preferences are scoped to the current operator actor from local/token/proxy identity. They are intended for UI state such as dashboard saved views and handoff checkpoints; all roles, including `viewer`, may save their own preferences.

`namespace` and `key` accept letters, numbers, `.`, `_`, `:`, and `-`.

**PUT body**

```json
{
  "value": [
    {
      "id": "view_1",
      "name": "Failed work",
      "filters": { "status": "failed" },
      "createdAt": "2026-04-27T15:00:00.000Z"
    }
  ]
}
```

**Response**

```json
{
  "actor": { "id": "alice", "role": "operator", "source": "proxy" },
  "namespace": "savedViews",
  "key": "work-queue",
  "value": [],
  "createdAt": "2026-04-27T15:00:00.000Z",
  "updatedAt": "2026-04-27T15:00:00.000Z"
}
```

### Observability Summary

```http
GET /api/observability
```

Returns event totals, failed/cancelled/retried task counts, failed pipeline counts, failure hotspots, retry hotspots, pipeline health, and recent errors.

### Workspace Snapshot

```http
GET /api/workspace-snapshot
POST /api/workspace-snapshot/preview
POST /api/workspace-snapshot/restore-plan
POST /api/workspace-snapshot/restore-preferences
```

`GET /api/workspace-snapshot` exports a sanitized, current-operator-scoped workspace snapshot for handoff, demos, or recovery drills. It includes tasks, pipelines, inbox entries, notifications, platform events, observability summary, and the current operator's preferences.

The export intentionally excludes auth tokens, Redis URLs, full database paths, and raw runtime diagnostics. Preference values are recursively redacted for sensitive keys such as `token`, `secret`, `password`, `authorization`, and `apiKey`.

```json
{
  "version": 1,
  "generatedAt": "2026-04-27T15:00:00.000Z",
  "generatedBy": { "id": "alice", "role": "operator", "source": "proxy" },
  "redaction": { "secrets": "excluded", "diagnostics": "sanitized" },
  "data": {
    "tasks": [],
    "pipelines": [],
    "inboxEntries": [],
    "notifications": [],
    "platformEvents": [],
    "observability": {},
    "preferences": []
  }
}
```

`POST /api/workspace-snapshot/preview` validates a snapshot payload and returns counts and compatibility warnings. It does not import or mutate server state.

```json
{
  "version": 1,
  "data": {
    "tasks": [],
    "pipelines": [],
    "inboxEntries": [],
    "notifications": [],
    "platformEvents": [],
    "preferences": []
  }
}
```

`POST /api/workspace-snapshot/restore-plan` performs preview-only restore planning. It compares snapshot resources with the current workspace and returns proposed `create`, `skip`, and `conflict` actions plus missing-reference details. It does not mutate server state.

```json
{
  "valid": false,
  "summary": {
    "create": 1,
    "skip": 1,
    "conflict": 1,
    "warnings": 0
  },
  "actions": [
    {
      "type": "skip",
      "resourceType": "task",
      "resourceId": "task_existing",
      "reason": "A resource with this id already exists in the current workspace."
    },
    {
      "type": "conflict",
      "resourceType": "task",
      "resourceId": "task_imported",
      "reason": "Imported resource references missing dependencies.",
      "dependencies": ["pipeline:pipe_missing"]
    }
  ]
}
```

`POST /api/workspace-snapshot/restore-preferences` is the only write path for snapshots. It restores snapshot preferences for the current operator actor only; tasks, pipelines, inbox entries, notifications, and events remain preview-only. The request must include explicit confirmation:

```json
{
  "confirm": true,
  "snapshot": {
    "version": 1,
    "data": {
      "preferences": [
        {
          "namespace": "savedViews",
          "key": "work-queue",
          "value": []
        }
      ]
    }
  }
}
```

Sensitive redacted placeholders are not restored; preference items containing `[REDACTED]` are skipped so placeholder values do not overwrite live preferences. The route records an operator audit action named `workspace.restore.preferences`.

```json
{
  "actor": { "id": "alice", "role": "operator", "source": "proxy" },
  "restored": 1,
  "skipped": 0,
  "failed": 0,
  "items": [
    {
      "namespace": "savedViews",
      "key": "work-queue",
      "status": "restored",
      "reason": "Preference restored for the current operator."
    }
  ],
  "auditActionId": 42
}
```

### Runtime Diagnostics

```http
GET /api/diagnostics
```

Returns sanitized deployment diagnostics: auth mode, current operator actor/permissions, queue backend, database path source/file hint, applied migrations, and runtime metadata. It does not return secrets, full tokens, Redis URLs, or full database paths.

The `operator` field lets the dashboard render role-aware controls:

```json
{
  "operator": {
    "actor": { "id": "alice", "role": "operator", "source": "proxy" },
    "permissions": {
      "canControlRuntime": true,
      "canDeleteTasks": false
    }
  }
}
```

### Recovery Semantics

On server startup:

- interrupted `running` or `assigned` tasks are re-queued by the task queue;
- `blocked` pipelines recreate their retry timer;
- `running` pipelines inspect their current stage task and either continue, advance, or mark the pipeline failed if the stage task is unrecoverable;
- unfinished quality-loop attempts are marked `failed` or `skipped`, while completed fix attempts can trigger the next review round.

### SQLite Migration Tracking

The server creates `schema_migrations` and records each structured migration after it runs. New database files are initialized from `schema.sql`; existing database files run only migrations that are not already recorded. Legacy databases that already contain a migrated column are recorded without rerunning the duplicate column operation.

---

## Error Response Format

Deprecated: use the Error Contract section above.

```json
{
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "Task not found"
  }
}
```
