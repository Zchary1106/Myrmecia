# Technical Architecture: Agent Factory

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                     Web Dashboard (React)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ Overview  │ │  Tasks   │ │  Agents  │ │   Pipelines    │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────┘  │
└────────────────────────┬─────────────────────────────────────┘
                         │ HTTP + WebSocket
┌────────────────────────┴─────────────────────────────────────┐
│                    Orchestrator API (Express)                  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐  │
│  │  REST API  │ │  WS Server │ │  Pipeline  │ │  Event   │  │
│  │  Routes    │ │  Hub       │ │  Engine    │ │  Bus     │  │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └────┬─────┘  │
│        └───────────────┴──────────────┴──────────────┘        │
│                         │                                     │
│  ┌──────────────────────┴──────────────────────────────────┐  │
│  │                  Core Services                           │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │  │
│  │  │  Agent   │ │   Task   │ │ Pipeline │ │ Notifier  │  │  │
│  │  │ Manager  │ │  Queue   │ │ Manager  │ │ Service   │  │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────────┘  │  │
│  └───────┴─────────────┴────────────┴──────────────────────┘  │
│                         │                                     │
│  ┌──────────────────────┴──────────────────────────────────┐  │
│  │                  Agent Runtime Layer                      │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐      │  │
│  │  │ Claude  │ │ Claude  │ │ Claude  │ │ Claude  │ ...  │  │
│  │  │ Code #1 │ │ Code #2 │ │ Code #3 │ │ Code #4 │      │  │
│  │  │ (PM)    │ │ (Dev)   │ │ (QA)    │ │ (Ops)   │      │  │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘      │  │
│  └─────────────────────────────────────────────────────────┘  │
│                         │                                     │
│  ┌──────────────────────┴──────────────────────────────────┐  │
│  │                    Storage Layer                          │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐    │  │
│  │  │  SQLite  │ │  Redis   │ │    File System       │    │  │
│  │  │ metadata │ │  queue   │ │  artifacts/workdirs  │    │  │
│  │  └──────────┘ └──────────┘ └──────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## 2. Component Details

### 2.1 Agent Manager

Responsible for agent lifecycle: creation, configuration, health monitoring.

```typescript
class AgentManager {
  private agents: Map<string, AgentInstance>
  
  async createAgent(config: AgentConfig): Promise<Agent>
  async startAgent(id: string): Promise<void>
  async stopAgent(id: string): Promise<void>
  async getAgent(id: string): Promise<Agent>
  async listAgents(filter?: AgentFilter): Promise<Agent[]>
  async assignTask(agentId: string, task: Task): Promise<void>
  
  // Health check - periodic
  async checkHealth(): Promise<AgentHealth[]>
}
```

### 2.2 Task Queue

BullMQ-based task queue with priority and dependency support.

```typescript
class TaskQueue {
  private queue: Queue
  private workers: Worker[]
  
  async enqueue(task: Task): Promise<void>
  async dequeue(agentRole: AgentRole): Promise<Task | null>
  async complete(taskId: string, output: string): Promise<void>
  async fail(taskId: string, error: string): Promise<void>
  async cancel(taskId: string): Promise<void>
  
  // Dependency resolution
  async checkDependencies(taskId: string): Promise<boolean>
  async onDependencyMet(taskId: string): Promise<void>
}
```

### 2.3 Pipeline Engine

Manages stage-by-stage execution with gate controls.

```typescript
class PipelineEngine {
  async create(templateId: string, input: string): Promise<Pipeline>
  async advanceStage(pipelineId: string): Promise<void>
  async approveGate(pipelineId: string): Promise<void>
  async skipStage(pipelineId: string): Promise<void>
  async cancel(pipelineId: string): Promise<void>
  
  // Called when a stage's task completes
  async onStageComplete(pipelineId: string, stageIndex: number, output: string): Promise<void>
}
```

### 2.4 Master Agent Logic

The Master Agent uses Claude Code to decompose tasks:

```typescript
class MasterAgent {
  async decompose(task: Task): Promise<SubTask[]> {
    const prompt = `
You are a project manager. Break down this task into subtasks.
For each subtask, specify:
- title
- description (detailed prompt for the agent)
- role (pm|ui|dev|qa|ops|review)
- dependencies (which subtasks must complete first)

Task: ${task.description}

Output JSON array of subtasks.
    `;
    
    const result = await this.runtime.execute(prompt);
    return JSON.parse(result);
  }
  
  async monitor(parentTaskId: string): Promise<void> {
    // Watch subtask progress
    // Handle failures (retry, reassign)
    // Consolidate when all done
  }
}
```

### 2.5 Event Bus

Internal pub/sub for cross-component communication:

```typescript
type EventType = 
  | 'task:created' | 'task:assigned' | 'task:started' 
  | 'task:log' | 'task:done' | 'task:failed'
  | 'agent:status' | 'agent:log'
  | 'pipeline:stage:started' | 'pipeline:stage:done' | 'pipeline:done'

class EventBus {
  private emitter: EventEmitter
  
  emit(type: EventType, payload: any): void
  on(type: EventType, handler: (payload: any) => void): void
  
  // Bridge to WebSocket
  bridgeToWS(wsHub: WSHub): void
}
```

## 3. Database Schema

```sql
-- Agents
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  skill_path TEXT,
  config JSON NOT NULL DEFAULT '{}',
  stats JSON NOT NULL DEFAULT '{}',
  current_task_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tasks
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  mode TEXT NOT NULL, -- master | direct | pipeline
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'normal',
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

-- Task Logs
CREATE TABLE task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Pipelines
CREATE TABLE pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  stages JSON NOT NULL,
  current_stage_index INTEGER DEFAULT 0,
  gate_mode TEXT NOT NULL DEFAULT 'auto',
  input TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

-- Pipeline Templates
CREATE TABLE pipeline_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  stages JSON NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Notifications
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  task_id TEXT,
  pipeline_id TEXT,
  read BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_pipeline ON tasks(pipeline_id);
CREATE INDEX idx_task_logs_task ON task_logs(task_id);
CREATE INDEX idx_notifications_read ON notifications(read);
```

## 4. Agent Communication Protocol

Agents communicate through the file system and event bus:

```
workspace/
├── .agent-factory/
│   ├── tasks/
│   │   ├── {task-id}/
│   │   │   ├── input.md       # Task prompt
│   │   │   ├── output.md      # Agent's output
│   │   │   ├── artifacts/     # Generated files
│   │   │   └── logs/          # Execution logs
│   │   └── ...
│   ├── pipelines/
│   │   ├── {pipeline-id}/
│   │   │   ├── stage-0-spec/  # PM output
│   │   │   ├── stage-1-design/# UI output
│   │   │   ├── stage-2-code/  # Dev output
│   │   │   ├── stage-3-test/  # QA output
│   │   │   └── stage-4-deploy/# Ops output
│   │   └── ...
│   └── shared/                # Shared context between agents
│       ├── project-context.md
│       └── conventions.md
```

**Inter-stage data flow:**
1. Stage N completes → output written to `stage-N-{name}/output.md`
2. Pipeline engine reads output
3. Output injected as input into Stage N+1's prompt
4. Stage N+1 also gets read access to all previous stage outputs

## 5. Security Model

- **Local-first**: Dashboard binds to `localhost:3000` by default
- **Agent isolation**: Each Claude Code process runs in its own workdir
- **No credential sharing**: Agents don't have access to user credentials
- **Rate limiting**: Max concurrent agents configurable (prevent runaway costs)
- **Cost tracking**: Log token usage per task/agent for cost awareness
- **Kill switch**: One-click stop-all-agents from dashboard

## 6. Error Handling & Recovery

```
Task Failure Flow:
  1. Agent process exits with error
  2. TaskQueue marks task as failed
  3. If retryCount < maxRetries:
     → Re-enqueue with incremented retryCount
     → Notify: "Task retrying (attempt N/M)"
  4. If retryCount >= maxRetries:
     → Mark task as permanently failed
     → If in pipeline: pause pipeline, notify user
     → If master-dispatched: notify master agent
     → Notify user: "Task failed, needs attention"

Server Restart Recovery:
  1. Load all tasks with status 'running' from DB
  2. Mark as 'pending' (re-enqueue)
  3. Restart agent processes
  4. Resume pipelines from last completed stage
```

## 7. Performance Considerations

- **SQLite WAL mode** for concurrent reads during writes
- **WebSocket channels** to avoid broadcasting all events to all clients
- **Log rotation**: Keep last 1000 log entries per task in memory, persist to DB
- **Artifact cleanup**: Auto-clean task artifacts older than 30 days
- **Process pooling**: Reuse Claude Code processes for same-agent sequential tasks (optional)
