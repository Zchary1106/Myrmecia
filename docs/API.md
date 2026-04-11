# API Reference: Agent Factory

## Base URL

```
http://localhost:3000/api
```

## Authentication

None by default (local-only). Optional Bearer token for remote access.

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

### Get Task Logs

```http
GET /api/tasks/:id/logs?limit=100&since=2025-01-15T10:00:00Z
```

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
  "skillContent": "# Security Audit Agent\n\nYou review code for security vulnerabilities...",
  "config": {
    "model": "claude-sonnet-4-20250514",
    "maxConcurrent": 1,
    "timeout": 300
  }
}
```

### Start/Stop Agent

```http
POST /api/agents/:id/start
POST /api/agents/:id/stop
```

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
POST /api/pipelines/:id/cancel    # Cancel entire pipeline
POST /api/pipelines/:id/pause     # Pause pipeline
POST /api/pipelines/:id/resume    # Resume paused pipeline
```

---

## Templates

### List Templates

```http
GET /api/templates
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

---

## Error Response Format

```json
{
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "Task task_abc123 not found",
    "status": 404
  }
}
```
