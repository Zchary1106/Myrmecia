# Product Specification: Agent Factory

## 1. Overview

Agent Factory is an autonomous agent orchestration system that manages a pool of specialized AI agents (powered by Claude Code CLI) through a web-based dashboard. Users can dispatch tasks via three modes: master delegation, direct assignment, or automated pipelines.

## 2. User Stories

### 2.1 Task Management
- **US-01**: As a user, I can create a task with a description and assign it to the Master Agent for automatic delegation.
- **US-02**: As a user, I can create a task and directly assign it to a specific agent (e.g., Dev Agent).
- **US-03**: As a user, I can create a pipeline task that automatically flows through stages (PM → UI → Dev → QA → Ops).
- **US-04**: As a user, I can view all active tasks, their status, and assigned agents on the dashboard.
- **US-05**: As a user, I can cancel or pause a running task.
- **US-06**: As a user, I receive notifications when a task completes, fails, or needs my input.

### 2.2 Agent Management
- **US-07**: As a user, I can see all agents, their current status (idle/working/blocked), and workload.
- **US-08**: As a user, I can view real-time logs from any agent's current task.
- **US-09**: As a user, I can define custom agents with specific SKILL.md files.
- **US-10**: As a user, I can start/stop agents and adjust pool size.

### 2.3 Pipeline Management
- **US-11**: As a user, I can select from predefined pipeline templates (full-product, bugfix, feature).
- **US-12**: As a user, I can create custom pipeline templates with my own stages.
- **US-13**: As a user, I can see pipeline progress visually (which stage, who's working, what's done).
- **US-14**: As a user, I can intervene at any pipeline stage (approve, reject, modify, skip).

### 2.4 History & Analytics
- **US-15**: As a user, I can view completed task history with full logs.
- **US-16**: As a user, I can see agent performance metrics (tasks completed, avg time, success rate).

## 3. Operation Modes

### 3.1 Mode A — Master Dispatch
```
User → "Build a weather app with React"
  → Master Agent analyzes & decomposes:
    → Task 1: Write PRD (assign: PM Agent)
    → Task 2: Design UI mockup (assign: UI Agent, depends: Task 1)
    → Task 3: Implement frontend (assign: Dev Agent, depends: Task 2)
    → Task 4: Write tests (assign: QA Agent, depends: Task 3)
    → Task 5: Deploy (assign: Ops Agent, depends: Task 4)
  → Master monitors progress, reassigns on failure
  → Notifies user on completion
```

**Master Agent responsibilities:**
- Parse high-level requirement into atomic tasks
- Determine dependencies and execution order
- Assign tasks to appropriate agents
- Monitor progress, handle failures (retry, reassign)
- Consolidate outputs into final deliverable
- Report status to user

### 3.2 Mode B — Direct Assign
```
User → selects Dev Agent → "Fix the login bug in auth.ts"
  → Dev Agent executes directly
  → Reports result
```

### 3.3 Mode C — Pipeline Flow
```
User → selects "Full Product" pipeline → "Build a todo app"
  → Stage 1 (PM): Generate spec → output: spec.md
  → Stage 2 (UI): Design from spec → output: design.md + wireframes
  → Stage 3 (DEV): Implement → output: source code
  → Stage 4 (QA): Test → output: test results
  → Stage 5 (OPS): Deploy → output: deployment URL
  → Each stage auto-triggers next on completion
  → User can review/approve between stages (optional gate)
```

## 4. Data Models

### 4.1 Agent
```typescript
interface Agent {
  id: string                  // uuid
  name: string                // "PM Agent"
  role: AgentRole             // pm | ui | dev | qa | ops | review | master | custom
  status: AgentStatus         // idle | working | blocked | error | offline
  skillPath: string           // path to SKILL.md
  currentTaskId?: string
  config: {
    model?: string            // claude model override
    maxConcurrent: number     // max parallel tasks (default: 1)
    timeout: number           // task timeout in seconds
    workdir: string           // working directory
  }
  stats: {
    tasksCompleted: number
    tasksFailed: number
    avgDurationMs: number
    lastActiveAt: Date
  }
  createdAt: Date
}

type AgentRole = 'master' | 'pm' | 'ui' | 'dev' | 'qa' | 'ops' | 'review' | 'custom'
type AgentStatus = 'idle' | 'working' | 'blocked' | 'error' | 'offline'
```

### 4.2 Task
```typescript
interface Task {
  id: string                  // uuid
  title: string
  description: string         // full task description / prompt
  mode: TaskMode              // master | direct | pipeline
  status: TaskStatus
  priority: 'low' | 'normal' | 'high' | 'urgent'
  
  // Assignment
  assigneeId?: string         // agent id
  createdBy: 'user' | 'master'
  parentTaskId?: string       // if decomposed from a master task
  
  // Pipeline
  pipelineId?: string
  stageIndex?: number
  
  // Execution
  input: string               // task prompt or upstream output
  output?: string             // result / artifact paths
  workdir?: string            // task-specific working directory
  
  // Lifecycle
  logs: LogEntry[]
  error?: string
  retryCount: number
  maxRetries: number
  
  // Timestamps
  createdAt: Date
  startedAt?: Date
  completedAt?: Date
  
  // Dependencies
  dependsOn: string[]         // task ids that must complete first
}

type TaskMode = 'master' | 'direct' | 'pipeline'
type TaskStatus = 'pending' | 'queued' | 'assigned' | 'running' | 'review' | 'done' | 'failed' | 'cancelled'

interface LogEntry {
  timestamp: Date
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  source: string              // agent id or 'system'
}
```

### 4.3 Pipeline
```typescript
interface Pipeline {
  id: string
  name: string                // "Build Todo App"
  templateId?: string         // which template was used
  status: PipelineStatus
  
  stages: PipelineStage[]
  currentStageIndex: number
  
  // Configuration
  gateMode: 'auto' | 'manual' // auto-proceed or wait for approval
  input: string               // original user request
  
  createdAt: Date
  completedAt?: Date
}

interface PipelineStage {
  index: number
  name: string                // "Spec", "Design", "Code", etc.
  agentRole: AgentRole        // which type of agent handles this
  taskId?: string             // created when stage starts
  status: 'pending' | 'running' | 'review' | 'done' | 'failed' | 'skipped'
  input?: string              // from previous stage output
  output?: string
  gateApproved?: boolean      // for manual gate mode
}

type PipelineStatus = 'running' | 'paused' | 'blocked' | 'done' | 'failed'
```

### 4.4 Pipeline Template
```yaml
# templates/full-product.yaml
name: Full Product
description: End-to-end product development pipeline
stages:
  - name: Spec
    role: pm
    prompt_template: |
      Based on the following requirement, write a detailed product spec:
      {input}
      Output a comprehensive PRD with user stories, data models, and API design.
      
  - name: Design
    role: ui
    prompt_template: |
      Based on the following product spec, create UI/UX design:
      {input}
      Output wireframes description, component hierarchy, and design tokens.
      
  - name: Code
    role: dev
    prompt_template: |
      Implement the following design and spec:
      {input}
      Write clean, tested, production-ready code.
      
  - name: Test
    role: qa
    prompt_template: |
      Review and test the following implementation:
      {input}
      Write and run comprehensive test suites.
      
  - name: Deploy
    role: ops
    prompt_template: |
      Deploy the following tested application:
      {input}
      Set up CI/CD, configure production environment, deploy.
```

## 5. API Design

### 5.1 REST Endpoints

```
# Tasks
POST   /api/tasks              # Create task (any mode)
GET    /api/tasks              # List tasks (filter by status, mode, agent)
GET    /api/tasks/:id          # Get task detail + logs
PATCH  /api/tasks/:id          # Update task (cancel, reassign)
DELETE /api/tasks/:id          # Delete task

# Agents
GET    /api/agents             # List all agents
GET    /api/agents/:id         # Agent detail + stats
POST   /api/agents             # Create custom agent
PATCH  /api/agents/:id         # Update agent config
POST   /api/agents/:id/start   # Start agent
POST   /api/agents/:id/stop    # Stop agent

# Pipelines
POST   /api/pipelines          # Create pipeline from template
GET    /api/pipelines          # List pipelines
GET    /api/pipelines/:id      # Pipeline detail + stage status
POST   /api/pipelines/:id/approve  # Approve current stage gate
POST   /api/pipelines/:id/skip     # Skip current stage
POST   /api/pipelines/:id/cancel   # Cancel pipeline

# Templates
GET    /api/templates          # List pipeline templates
POST   /api/templates          # Create custom template

# System
GET    /api/health             # Health check
GET    /api/stats              # System-wide stats
```

### 5.2 WebSocket Events

```typescript
// Server → Client
interface WSEvent {
  type: 'task:created' | 'task:assigned' | 'task:started' | 'task:log' 
      | 'task:done' | 'task:failed'
      | 'agent:status' | 'agent:log'
      | 'pipeline:stage:started' | 'pipeline:stage:done' | 'pipeline:done'
      | 'notification'
  payload: any
  timestamp: Date
}

// Client → Server
interface WSCommand {
  type: 'subscribe' | 'unsubscribe'
  channel: string  // 'tasks', 'agents', 'pipelines', 'agent:{id}', 'task:{id}'
}
```

## 6. Agent Runtime

Each agent runs as an isolated Claude Code CLI subprocess:

```typescript
class AgentRuntime {
  // Spawn a Claude Code process for a task
  async execute(agent: Agent, task: Task): Promise<TaskResult> {
    const proc = spawn('claude', [
      '--print',           // non-interactive mode
      '--model', agent.config.model || 'claude-sonnet-4-20250514',
      '--max-turns', '50',
      task.input           // the prompt
    ], {
      cwd: task.workdir || agent.config.workdir,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'agent-factory' }
    });
    
    // Stream stdout/stderr to task logs
    // Handle timeout
    // Parse output
    // Return result
  }
}
```

**Key design decisions:**
- Each task gets its own Claude Code process (isolation)
- Agent workdir is shared across tasks (for context continuity)  
- Task workdir can override for project-specific work
- Logs are streamed in real-time via WebSocket
- Timeout kills the process and marks task as failed

## 7. Dashboard Pages

### 7.1 Overview (/)
- System health status
- Active agents count & status breakdown
- Running tasks count
- Active pipelines
- Recent activity feed

### 7.2 Tasks (/tasks)
- Kanban board: Pending → Running → Review → Done
- Filter by mode, agent, status, priority
- Create new task (modal with mode selector)
- Click task → detail panel with live logs

### 7.3 Agents (/agents)
- Agent cards grid: avatar, name, role, status, current task
- Click agent → detail view with stats, config, log stream
- Create/configure custom agent

### 7.4 Pipelines (/pipelines)
- Active pipelines with visual stage progress
- Stage-by-stage view with inputs/outputs
- Approve/skip/cancel controls at gate stages
- Pipeline history

### 7.5 Templates (/templates)
- Browse pipeline templates
- Visual template editor (drag stages)
- Create from existing pipeline run

## 8. Notification System

```typescript
interface Notification {
  id: string
  type: 'task_complete' | 'task_failed' | 'pipeline_stage' | 'needs_input' | 'agent_error'
  title: string
  message: string
  taskId?: string
  pipelineId?: string
  read: boolean
  createdAt: Date
}
```

**Notification channels:**
1. **Dashboard**: WebSocket push → toast + notification bell
2. **WeCom** (optional): Send message via WeCom App API
3. **Sound**: Browser notification sound for important events

## 9. Phase Plan

### Phase 1 — MVP (2-3 days)
- [ ] Project setup (monorepo, TypeScript, build)
- [ ] SQLite schema + models
- [ ] Agent runtime (Claude Code CLI wrapper)
- [ ] REST API (tasks CRUD, agents CRUD)
- [ ] Direct assign mode (Mode B)
- [ ] Basic dashboard (task list, agent status, log viewer)
- [ ] WebSocket for real-time updates

### Phase 2 — Core (3-4 days)
- [ ] Master Agent + task decomposition (Mode A)
- [ ] Pipeline engine + templates (Mode C)
- [ ] Pipeline visual progress UI
- [ ] Stage gates (approve/skip)
- [ ] Task dependency resolution
- [ ] Notification system (dashboard + sound)

### Phase 3 — Polish (2-3 days)
- [ ] Kanban board UI
- [ ] Agent stats & analytics
- [ ] Custom agent creation UI
- [ ] Custom pipeline template editor
- [ ] WeCom notification integration
- [ ] Task history & replay
- [ ] Dark/light theme

## 10. Non-Functional Requirements

- **Concurrency**: Support 6+ agents running simultaneously
- **Latency**: Dashboard updates within 500ms of state change
- **Storage**: SQLite for metadata, filesystem for artifacts
- **Recovery**: Persist task state; resume on server restart
- **Security**: Local-only by default; auth optional for remote access
