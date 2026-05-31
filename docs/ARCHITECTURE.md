# Agent Factory Architecture

Agent Factory 是一个面向“多 Agent 协作生产”的本地优先编排平台。它把 Agent 定义、任务队列、Pipeline、实时事件、Human-in-the-loop、工具能力和 Dashboard 管理放在同一个系统里，支持从产品需求、设计、开发、测试、部署到内容创作的端到端工作流。

## 1. System Context

```mermaid
flowchart LR
  Operator[Operator / User] --> Dashboard[React Dashboard]
  Dashboard -->|HTTP /api| Server[Express Orchestrator API]
  Dashboard <-->|WebSocket /ws| WSHub[WebSocket Hub]
  Server --> SQLite[(SQLite)]
  Server --> Queue[TaskQueue<br/>In-memory or BullMQ]
  Queue --> Runtime[Agent Runtime]
  Runtime --> PythonRuntime[Agent Factory Python Runtime]
  PythonRuntime --> Proxy[Model Endpoint<br/>OpenAI-compatible]
  PythonRuntime --> Tools[Built-in Tools]
  Runtime --> Workspaces[(Task Workspaces)]
  Server --> Notifications[Notifications / Inbox]
```

### Responsibilities

| Layer | Responsibility |
| --- | --- |
| Dashboard | Agent 管理、任务发起、Pipeline 控制、实时状态、Inbox、观测和设置 |
| Express API | REST API、鉴权、任务/Agent/Pipeline/模板/系统路由 |
| TaskQueue | 任务入队、优先级、Redis/BullMQ 或本地内存执行路径 |
| Agent Runtime | 创建 execution、组装 skill prompt、运行 TS loop 或 Python Runtime、记录消息/成本/状态 |
| Model Router | 选择实际模型、应用 role/global fallback、记录健康状态和使用量 |
| Python Runtime | 根据 Agent 配置构建运行时 Agent，调用模型与工具 |
| SQLite | Agent 定义、任务、执行记录、消息、Pipeline、通知、审计事件 |
| WebSocket Hub | 把内部事件广播到 Dashboard 对应 channel |

## 2. High-level Runtime Architecture

```mermaid
flowchart TB
  subgraph Dashboard["packages/dashboard"]
    Command[Command Center]
    Agents[Agent Control Center<br/>Create/Edit Agents]
    SkillPage[Skill Registry<br/>Draft / Publish / Rollback]
    Tasks[Task Board]
    Pipelines[Pipelines<br/>Visual Builder]
    Timeline[Execution Timeline]
    Inbox[Human Inbox]
    Settings[Settings]
  end

  subgraph Server["packages/server"]
    Auth[Token Auth Middleware]
    Routes[REST Routes]
    EventBus[Event Bus]
    WSHub[WebSocket Hub]
    AgentManager[Agent Manager]
    SkillRegistry[Skill Registry]
    TaskQueue[Task Queue]
    PipelineEngine[Pipeline Engine]
    QualityLoop[Quality Loop]
    SelfHealing[Self-healing]
    Runtime[Agent Runtime]
    ModelRouter[Model Router]
    DBModels[DB Model Helpers]
  end

  subgraph Data["Persistence"]
    SQLite[(SQLite DB)]
    Registry[agents/registry.yaml]
    Skills[agents/*.md]
    Templates[templates/*.yaml]
    Workspace[.agent-factory/workspaces]
  end

  subgraph Python["packages/python-runtime"]
    Runner[runtime_runner.py]
    Builder[agents.py]
    ToolRegistry[agent_tools.py]
  end

  Dashboard -->|HTTP /api| Auth --> Routes
  Dashboard <-->|/ws| WSHub
  Routes --> AgentManager
  Routes --> ToolRuntime
  Routes --> SkillRegistry
  Routes --> TaskQueue
  Routes --> PipelineEngine
  Routes --> DBModels
  AgentManager --> Registry
  AgentManager --> SQLite
  TaskQueue --> Runtime
  PipelineEngine --> TaskQueue
  Runtime --> Skills
  SkillRegistry --> SQLite
  Runtime --> ModelRouter
  Runtime --> Workspace
  Runtime --> Runner
  Runner --> Builder
  Builder --> ToolRegistry
  Builder --> Copilot[Copilot API Reverse Proxy]
  DBModels --> SQLite
  EventBus --> WSHub
  Runtime --> EventBus
  PipelineEngine --> EventBus
```

## 3. Agent Model

Agent 在系统里是 **capability template**，不是常驻 worker。它描述“这个角色如何工作、能用什么工具、适合哪些任务、默认模型是什么”。实际执行状态放在 `task_executions`、`execution_messages` 和 `run_traces` 中。

```mermaid
classDiagram
  class AgentDefinition {
    string id
    string name
    string role
    string emoji
    string description
    string whenToUse
    string skillPath
    AgentConfig config
    string[] capabilities
    string[] triggers
    string[] allowedTools
    string[] disallowedTools
    string model
    number maxTurns
    AgentStats stats
  }

  class AgentConfig {
    string model
    number maxConcurrent
    number timeout
    string workdir
    number maxTurns
    string[] allowedTools
  }

  class AgentStats {
    number tasksCompleted
    number tasksFailed
    number avgDurationMs
    string lastActiveAt
  }

  AgentDefinition --> AgentConfig
  AgentDefinition --> AgentStats
```

### Agent Sources

| Source | Purpose |
| --- | --- |
| `agents/registry.yaml` | 预置 Agent 列表、默认 role/model/tools/capabilities |
| `agents/*.md` | 预置 Agent 的主 skill prompt |
| Dashboard Create/Edit | 动态 Agent 或运行时 skill overlay、工具白名单、模型配置 |
| SQLite `agents` | 最终运行时读取的 Agent 定义源 |

启动时 `AgentManager.initializeFromRegistry()` 会读取 `agents/registry.yaml`。如果 Agent 不存在，会插入 DB；如果已存在，会刷新 registry 中的描述、skill path、capabilities、triggers、allowed tools 和默认模型配置。

## 4. Agent Execution Flow

```mermaid
sequenceDiagram
  participant UI as Dashboard
  participant API as Express API
  participant Queue as TaskQueue
  participant RT as AgentRuntime
  participant DB as SQLite
  participant Py as runtime_runner.py
  participant LLM as Copilot API Proxy
  participant Tool as Built-in Tools
  participant WS as WebSocket Hub

  UI->>API: POST /api/tasks or /api/agents/:id/execute
  API->>DB: create task
  API->>Queue: enqueue task
  Queue->>RT: execute(agent, task)
  RT->>DB: create task_execution
  RT->>WS: task:started / execution:started
  RT->>RT: build system prompt<br/>skill file + runtime profile overlay
  RT->>Py: spawn python3 runtime_runner.py config
  Py->>Py: build runtime Agent
  Py->>Tool: optional tool calls
  Py->>LLM: chat via OpenAI-compatible proxy
  Py-->>RT: JSONL assistant/result events
  RT->>DB: execution_messages / run_traces / task logs / stats
  RT->>WS: execution:message / task:done
  UI-->>WS: receives live updates
```

### Prompt Composition

Runtime prompt is composed as:

```text
agents/<agent>.md

## Runtime Profile Override
You are <name>, a <role> agent.
Mission: <dashboard description>
When to use: <whenToUse>
Capabilities: ...
Allowed tools: ...
```

This keeps file-based skills versionable while allowing Dashboard edits to take effect immediately.

## 5. Tools and Skills Architecture

Tools are governed by a server-side Tool Runtime and implemented in `packages/python-runtime/agent_tools.py`. An Agent can request tools through `allowedTools`, but the server filters that list through the tool catalog, enabled flags, per-Agent permissions, disallowed tools, and approval requirements before passing tools to execution.

```mermaid
flowchart LR
  Agent[Agent Definition] --> Allowed[allowedTools]
  Allowed --> Policy[Tool Policy Filter]
  Catalog[(tools / tool_permissions)] --> Policy
  Policy --> RuntimeConfig[Runtime Config JSON]
  RuntimeConfig --> PythonRuntime[runtime_runner.py]
  PythonRuntime --> Builder[build_agent]
  Builder --> ToolRegistry[TOOL_REGISTRY]
  ToolRegistry --> WebSearch[web.search]
  ToolRegistry --> WebFetch[web.fetch]
  ToolRegistry --> Crawler[crawler.extract_links]
  ToolRegistry --> Layout[content.wechat_layout]
  ToolRegistry --> Hashtag[content.hashtag_plan]
  ToolRegistry --> Image[image.generate_svg]
  ToolRegistry --> Events[tool_use / tool_result events]
  Events --> Executions[(tool_executions)]
```

  ## 5.1 Dynamic Workflow Runtime

  Dynamic workflows are generated at runtime instead of loaded from a fixed YAML template. The runtime creates an executable plan, fans steps out through the normal `TaskQueue`, and listens for task terminal events to validate and summarize the run.

  ```mermaid
  flowchart LR
    UserGoal[Goal] --> Planner[Workflow Planner]
    Planner --> Plan[(dynamic_workflows.plan)]
    Plan --> FanOut[Fan-out Dispatcher]
    FanOut --> TaskQueue
    TaskQueue --> Agents[Specialized Agents]
    Agents --> Results[Task Outputs]
    Results --> Validator[Validation Summary]
    Validator --> WorkflowResult[(dynamic_workflows.result)]
  ```

  Each plan contains `steps[]` with `id`, `agentRole`, `input`, and `dependsOn`. The dispatcher converts step dependencies into task dependencies, so independent steps can run in parallel while QA/security/release gates wait for upstream outputs.

`/api/tools` exposes the catalog, policy updates, per-Agent permissions, and execution history. The Dashboard **Tools** page shows enabled status, approval requirement, risk level, and recent tool calls.

Skills are governed through a server-side Skill Registry. Startup imports `agents/*.md` as published versions, and Agent execution resolves the prompt from an explicit `skill_assignments` row before falling back to the Agent `skillPath`.

```mermaid
flowchart LR
  Markdown[agents/*.md] --> Import[Skill Registry Sync]
  Import --> SkillsDB[(skills)]
  Import --> Versions[(skill_versions)]
  Agent[Agent Definition] --> Assignment[(skill_assignments)]
  Assignment --> RuntimeSkill[Published Skill Version]
  Versions --> RuntimeSkill
  RuntimeSkill --> Prompt[Prompt Build]
  Prompt --> Trace[prompt.build span<br/>skill checksum]
  Prompt --> Execution[(task_executions.skill_version_id)]
```

The Dashboard **Skills** page supports draft creation, published-version immutability, markdown preview, line diff against the current published version, and per-Agent assignment/rollback to any published version.

### Built-in Tools

| Tool | Capability |
| --- | --- |
| `web.search` | DuckDuckGo HTML 搜索，返回标题和链接 |
| `web.fetch` | 抓取 http/https 页面文本，做事实查证和资料整理 |
| `crawler.extract_links` | 从页面提取可见链接，适合资料索引/轻量爬虫 |
| `content.wechat_layout` | 把公众号 Markdown 草稿转成移动端友好的 HTML blocks |
| `content.hashtag_plan` | 生成中文关键词、标签和搜索意图 |
| `image.generate_svg` | 本地生成 SVG 封面草稿到 `generated-assets/cover.svg` |

### Recommended Tool Mapping

| Agent | Recommended tools |
| --- | --- |
| PM / Master / Review | `web.search`, `web.fetch` |
| Dev / API / DB / Ops | `web.search`, `web.fetch` |
| Doc Writer | `web.search`, `web.fetch`, `crawler.extract_links` |
| WeChat Writer | `web.search`, `web.fetch`, `crawler.extract_links`, `content.wechat_layout`, `content.hashtag_plan`, `image.generate_svg` |
| Xiaohongshu Writer | `web.search`, `web.fetch`, `content.hashtag_plan`, `image.generate_svg` |
| UI Agent | `image.generate_svg` |
| i18n / QA | lightweight fetch/search as needed |

## 6. Model Registry and Routing

The model selector is backed by the server-side Model Registry and constrained to models exposed through the configured OpenAI-compatible endpoint. Agent Factory uses the endpoint's native model IDs, such as `gpt-5.4-mini` and `claude-haiku-4.5`.

```mermaid
flowchart LR
  Dashboard[Model dropdown<br/>GET /api/models] --> AgentDB[(agents.model / config.model)]
  Catalog[(model_registry)] --> Router[Model Router]
  Routes[(model_routes)] --> Router
  AgentDB --> Router
  Router --> Trace[model.route span]
  Router --> Runtime[AgentRuntime config]
  Runtime --> Usage[(model_usage_stats)]
  Runtime --> Runner[runtime_runner.py]
  Runner --> LiteLLM[LiteLLM OpenAI-compatible client]
  LiteLLM --> Proxy[AGENT_FACTORY_BASE_URL<br/>OpenAI-compatible endpoint]
  Proxy --> Model[GPT / Claude / Codex]
```

Routing order:

1. Explicit enabled `agent.model`.
2. Explicit enabled `agent.config.model`.
3. Enabled `role:<agent.role>` route.
4. Enabled `global` route.
5. Highest-priority enabled model in the requested fallback group.
6. Highest-priority enabled model, then `AGENT_FACTORY_MODEL` as the final runtime fallback.

Each execution writes a `model.route` trace span and a `model_usage_stats` row with selected model, tokens/cost when available, latency, and route reason. `/api/models` exposes the catalog, enabled flags, health checks, and route updates; model config changes are audited as `model.update` / `model.route.update`.

### Supported Model Options

| Model ID | Best for |
| --- | --- |
| `gpt-5.5` | Strong reasoning, orchestration, security, architecture |
| `gpt-5.4` | Long-context fallback and large analysis |
| `gpt-5.3-codex` | Coding and refactoring |
| `gpt-5.4-mini` | Default low-cost model for simple tasks |
| `claude-opus-4.8` | Strong fallback for review/planning |
| `claude-opus-4.7` | Strong Claude fallback |
| `claude-haiku-4.5` | Fast/low-cost summaries, docs, i18n |
| `gemini-3.1-pro-preview` | Multimodal or web-heavy analysis |
| `gemini-3-flash-preview` | Lightweight multimodal fallback |

Environment variables:

```bash
AGENT_FACTORY_BASE_URL=https://your-model-endpoint.example.com/v1
AGENT_FACTORY_API_KEY=...
AGENT_FACTORY_MODEL=gpt-5.4-mini
```

Per-agent model config takes precedence when the selected model is enabled in the registry; disabled models are skipped and routed through the configured role/global fallback.

## 7. Task and Pipeline Flow

### Direct Task

```mermaid
flowchart TD
  Create[Create direct task] --> AgentLookup[Find assignee agent]
  AgentLookup --> Capacity{Agent has capacity?}
  Capacity -- no --> RequeueOrFail[Queue / 429 / retry later]
  Capacity -- yes --> Execute[AgentRuntime.execute]
  Execute --> Done{Result}
  Done -- success --> PersistOutput[Persist output, logs, stats]
  Done -- failure --> PersistError[Persist error, increment failure stats]
```

### Pipeline Task

```mermaid
flowchart LR
  Template[Pipeline Template YAML] --> Pipeline[Pipeline Instance]
  Pipeline --> Stage1[Stage 1 Agent]
  Stage1 --> Context[Context Manager]
  Context --> Stage2[Stage 2 Agent]
  Stage2 --> Quality[Quality Loop]
  Quality --> Stage3[Next Stage]
  Stage3 --> Complete[Pipeline Done]
```

Pipeline templates live in `templates/*.yaml`, for example:

| Template | Stages |
| --- | --- |
| `full-product` | PM → UI → Dev → QA → Ops |
| `feature` | Spec → Code → Test → Review |
| `bugfix` | Triage → Fix → Test |
| `wechat-article` | 选题 → 写作 → 审核 → 排版 |
| `xiaohongshu-note` | 选题 → 创作 → SEO |

## 8. Dashboard Architecture

```mermaid
flowchart TB
  Layout[Layout Shell] --> Sidebar[Agent Sidebar]
  Layout --> Main[Main View Router]
  Layout --> RightPanel[Agent Chat / History Panel]

  Main --> Command[CommandCenter]
  Main --> Agents[AgentsPage<br/>Create/Edit Agent]
  Main --> Skills[SkillsPage<br/>Skill Versioning]
  Main --> Orchestrator[OrchestratorView<br/>Pipeline Builder]
  Main --> Tasks[TasksPage]
  Main --> Timeline[ExecutionTimeline]
  Main --> Inbox[InboxView]
  Main --> Observability[ObservabilityView]
  Main --> Audit[AuditView]
  Main --> Settings[SettingsView]

  Store[Zustand Store] --> Main
  API[lib/api.ts] --> Store
  WS[useWebSocket] --> Store
```

### Agent Control Center

The Agents page supports:

- Search by name, role, capability, or tool.
- Filter by role.
- View capabilities and enabled tools on each Agent card.
- Create custom Agents from templates.
- Edit existing Agents.
- Update skill overlay, capabilities, triggers, model, max turns, timeout, and allowed tools.
- Open Skill Registry to draft/publish prompt versions and assign or roll back a specific Agent.

### Visual Pipeline Builder

The Pipelines view includes a lightweight visual builder:

- Stage list with add/remove/reorder controls.
- Per-stage config panel for name, Agent role, and prompt template.
- Flow preview for the full stage sequence.
- Auto/manual gate mode selection.
- Template validation through `/api/templates/validate`.
- Save/update template and immediate `POST /api/pipelines` run.

Template mutations are audited as `template.create` and `template.update`.

## 9. Permission and Audit

Operator identity is resolved from proxy headers, API token, or local mode:

```text
X-Operator-Id / X-Operator-Role -> proxy actor
Authorization: Bearer ...       -> token-admin
local dev without auth          -> local-admin
```

Roles:

| Role | Behavior |
| --- | --- |
| `admin` | Full launch, runtime, config, and destructive controls |
| `operator` | Runtime launch/control and Agent/Tool configuration |
| `viewer` | Read-only access; write/control routes return `403 OPERATOR_FORBIDDEN` |

Audit records are persisted in `operator_actions`. Current audited controls include task create/cancel/retry/delete, pipeline create/approve/skip/cancel, inbox response, workspace preference restore, Agent create/update/execute, Tool policy/permission updates, Model route/policy updates, Skill create/version/publish/assignment updates, and Template create/update.

## 10. Database Design

```mermaid
erDiagram
  agents ||--o{ tasks : assignee
  agents ||--o{ skill_assignments : uses
  tasks ||--o{ task_executions : has
  task_executions ||--o{ execution_messages : emits
  task_executions }o--|| skill_versions : used_skill
  task_executions ||--|| run_traces : traces
  run_traces ||--o{ trace_spans : contains
  task_executions ||--o{ tool_executions : uses
  task_executions ||--o{ model_usage_stats : selects
  agents ||--o{ tool_permissions : grants
  agents ||--o{ model_usage_stats : records
  tools ||--o{ tool_permissions : governs
  tools ||--o{ tool_versions : versions
  tools ||--o{ tool_executions : records
  skills ||--o{ skill_versions : versions
  skills ||--o{ skill_assignments : assigns
  skill_versions ||--o{ skill_assignments : selected
  tasks ||--o{ task_logs : logs
  pipelines ||--o{ tasks : stages
  pipeline_templates ||--o{ pipelines : instantiates
  tasks ||--o{ notifications : references
  model_registry ||--o{ model_usage_stats : records
  model_registry ||--o{ model_health_checks : checks
  model_registry ||--o{ model_routes : defaults
  pipelines ||--o{ notifications : references
  task_executions ||--o{ inbox_entries : requests
  tasks ||--o{ quality_loop_attempts : reviews

  agents {
    text id PK
    text name
    text role
    text skill_path
    json config
    json capabilities
    json triggers
    json allowed_tools
    text model
    integer max_turns
    json stats
  }

  tasks {
    text id PK
    text title
    text mode
    text status
    text assignee_id FK
    text input
    text output
    text workdir
    text error
  }

  task_executions {
    text id PK
    text task_id FK
    text agent_def_id
    text status
    json progress
    real cost_usd
    integer token_count
  }

  execution_messages {
    integer id PK
    text execution_id
    text type
    text content
    text tool_name
  }

  run_traces {
    text id PK
    text task_id FK
    text execution_id FK
    text agent_id FK
    text status
    text summary
  }

  trace_spans {
    text id PK
    text trace_id FK
    text parent_span_id FK
    text type
    text name
    text status
    json metadata
    integer duration_ms
  }

  tools {
    text id PK
    text category
    text risk_level
    integer enabled
    integer approval_required
    json input_schema
  }

  tool_versions {
    text id PK
    text tool_id FK
    text version
    text implementation_ref
    text status
  }

  tool_permissions {
    text tool_id FK
    text agent_id FK
    integer enabled
    integer approval_required
  }

  tool_executions {
    text id PK
    text tool_id FK
    text execution_id FK
    text task_id FK
    text agent_id FK
    text status
    text input_hash
    integer duration_ms
  }

  pipelines {
    text id PK
    text template_id
    text status
    json stages
    integer current_stage_index
    text gate_mode
  }
```

Default database path:

```text
packages/server/data/agent-factory.db
```

Override with:

```bash
DB_PATH=/tmp/agent-factory-clean.db pnpm dev
```

## 11. Events and Real-time Updates

The server emits typed domain events through `eventBus`. `WSHub` maps them to channels so the Dashboard can update only relevant views.

```mermaid
flowchart LR
  Runtime[AgentRuntime] --> EventBus
  Pipeline[PipelineEngine] --> EventBus
  Queue[TaskQueue] --> EventBus
  EventBus --> Recorder[EventRecorder]
  EventBus --> WSHub
  WSHub --> Dashboard[Dashboard Store]
  Recorder --> SQLite[(platform_events)]
```

Typical events:

| Domain | Events |
| --- | --- |
| Task | `task:created`, `task:started`, `task:done`, `task:failed` |
| Execution | `execution:started`, `execution:message`, `execution:done`, `execution:failed` |
| Pipeline | stage start/done, blocked, done, failed |
| Agent | registry/status related updates |

## 12. Deployment View

```mermaid
flowchart TB
  Browser[Browser] --> Vite[Vite dev server :5173]
  Vite -->|proxy /api /ws| Node[Node Express :3000]
  Node --> SQLite[(SQLite file)]
  Node --> Redis[(Redis optional)]
  Node --> Python[python3 runtime_runner.py]
  Python --> Copilot[Copilot API reverse proxy]
  Python --> Internet[Optional web tools]
  Node --> Workspace[Workspace files]
```

Local startup:

```bash
pnpm install
pnpm dev
```

Separated startup:

```bash
pnpm dev:server
pnpm dev:dashboard
```

## 13. Reliability and Recovery

| Mechanism | Design |
| --- | --- |
| In-memory fallback queue | If Redis is absent, `TaskQueue` executes through local memory path |
| Recovery on startup | Recover running tasks, interrupted pipelines, and quality-loop attempts |
| Workspace isolation | Task outputs are written under task workspaces |
| Execution messages | Runtime activity is persisted for timeline/history views |
| Operator controls | Cancel/retry/delete/pipeline controls are recorded and role-gated |
| Human inbox | Approval/question/input/review entries persist operator decisions |

## 14. Current Limits and Extension Points

| Area | Current design | Extension |
| --- | --- | --- |
| Tools | Built-in Agent Factory Python tools | Add provider-backed image generation, browser automation, MCP tools |
| Model list | Static dashboard dropdown | Fetch model list from copilot-api if endpoint is available |
| Agent skills | Markdown + dashboard overlay | Versioned skill registry and diff/rollback |
| Queue | Redis optional, memory fallback | Distributed workers and per-Agent concurrency pools |
| Dashboard editing | Agent create/edit supported | Full diff view, dry-run prompt preview, tool permission templates |
| Content tools | WeChat layout + SVG cover | Real WeChat editor export, image model generation, media library |
