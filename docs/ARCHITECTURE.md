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
  Runtime --> TSRuntime[TypeScript Agent Loop]
  TSRuntime --> Gateway[ModelGateway<br/>OpenAI-compatible or Copilot SDK]
  TSRuntime --> Tools[Governed Sandbox / MCP Tools]
  Runtime --> Workspaces[(Task Workspaces)]
  Server --> Notifications[Notifications / Inbox]
```

### Responsibilities

| Layer | Responsibility |
| --- | --- |
| Dashboard | Agent 管理、任务发起、Pipeline 控制、实时状态、Inbox、观测和设置 |
| Express API | REST API、鉴权、任务/Agent/Pipeline/模板/系统路由 |
| TaskQueue | 任务入队、优先级、Redis/BullMQ 或本地内存执行路径 |
| Agent Runtime | 创建 execution、选择 TS loop 或注册的扩展执行器、记录消息/成本/状态 |
| Model Router | 选择实际模型、应用 role/global fallback、记录健康状态和使用量 |
| TypeScript Loop | 组装上下文与 skill prompt，通过 ModelGateway 调用模型与受治理的工具 |
| SQLite | Agent 定义、任务、执行记录、消息、Pipeline、通知、审计事件 |
| WebSocket Hub | 把内部事件广播到 Dashboard 对应 channel |

### Module Map

| Area | Primary files | Notes |
| --- | --- | --- |
| Startup wiring | `packages/server/src/index.ts` | Initializes telemetry, DB, registries, task queue, pipeline engine, dynamic/supervisor routes, WebSocket hub, and background services |
| Agent registry | `agents/registry.yaml`, `agents/*.md`, `agents/agent-manager.ts` | Registry YAML defines default agents; markdown files define prompt/skill behavior; DB rows are the runtime source |
| Runtime execution | `agents/agent-runtime.ts`, `agents/ts-agent-loop.ts`, `agents/runtime-adapter.ts` | Runs tasks, emits events, records traces, applies DLP, tracks cost/tokens, and enforces runtime budgets |
| Dynamic workflow | `agents/dynamic-workflow.ts`, `routes/supervisor.ts` | Generates executable plans, dispatches fan-out tasks, watches task events, validates and summarizes runs |
| Pipeline engine | `pipelines/pipeline-engine.ts`, `templates/*.yaml` | Fixed workflow templates with stage dependencies, artifacts, manual gates, QA loops, and rollback |
| Model routing | `models/model-registry.ts`, `models/smart-router.ts` | Task-aware routing, fallback groups, retry escalation, long-context selection, health/usage tracking |
| Tool governance | `tools/tool-policy.ts`, `skills/tool-sandbox.ts`, `skills/tool-guardian.ts` | Tool enablement, approval gates, high-risk metadata, command blocking, secret/unsafe input checks |
| Audit and security | `audit/execution-audit.ts`, `auth/*`, `security/*` | API auth, tenant scoping, DLP rules, policy snapshots, audit reports, event recording |
| Dashboard state | `packages/dashboard/src/stores/store.ts`, `packages/dashboard/src/lib/api.ts` | Zustand state, REST client, WebSocket updates, preview-friendly fallback loaders |

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

  subgraph Execution["TypeScript Execution"]
    Loop[ts-agent-loop.ts]
    Gateway[ModelGateway]
    Sandbox[tool-sandbox.ts / MCP]
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
  Runtime --> Loop
  Loop --> Sandbox
  Loop --> Gateway
  Gateway --> ModelEndpoint[OpenAI-compatible Endpoint / Copilot SDK]
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
  participant Loop as TypeScript Agent Loop
  participant LLM as ModelGateway / Provider
  participant Tool as Built-in Tools
  participant WS as WebSocket Hub

  UI->>API: POST /api/tasks or /api/agents/:id/execute
  API->>DB: create task
  API->>Queue: enqueue task
  Queue->>RT: execute(agent, task)
  RT->>DB: create task_execution
  RT->>WS: task:started / execution:started
  RT->>RT: build system prompt<br/>skill file + runtime profile overlay
  RT->>Loop: execute with governed task context
  Loop->>Loop: build prompt and allowed tool definitions
  Loop->>LLM: model request / streamed text
  Loop->>Tool: validated sandbox / MCP calls
  Tool-->>Loop: tool results
  Loop-->>RT: normalized result / stop reason / usage
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

Tools are governed by a server-side Tool Runtime and implemented in `packages/server/src/skills/tool-sandbox.ts` or connected MCP services. An Agent can request tools through `allowedTools`, but the server filters that list through the tool catalog, enabled flags, per-Agent permissions, disallowed tools, and approval requirements before passing tools to execution. The optional `browser.query` tool uses a remote browser service configured by `BROWSER_QUERY_URL` and `BROWSER_QUERY_TOKEN`; it does not require a Python Agent runtime.

```mermaid
flowchart LR
  Agent[Agent Definition] --> Allowed[allowedTools]
  Allowed --> Policy[Tool Policy Filter]
  Catalog[(tools / tool_permissions)] --> Policy
  Policy --> Loop[TypeScript Agent Loop]
  Loop --> ToolRegistry[Governed Tool Sandbox / MCP]
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

![Dynamic Workflow Lifecycle](diagrams/dynamic-workflow-lifecycle.svg)

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

### Dynamic workflow lifecycle

| Phase | Status | What happens |
| --- | --- | --- |
| Create | `planning` | API accepts `{ goal }` or an executable `{ plan }`; the planner creates/validates steps and dependencies |
| Dispatch | `dispatching` | Each step is assigned to an available agent role and persisted as a normal task |
| Run | `running` | Existing queue/runtime executes sub-tasks; events include `workflow:task_dispatched`, `workflow:task_completed`, and `workflow:task_failed` |
| Validate | `validating` | When all child tasks reach terminal state, required steps are checked and outputs are aggregated |
| Finish | `done` / `failed` / `cancelled` | Result and validation summary are persisted in `dynamic_workflows` |

Dynamic workflows intentionally reuse the normal task/execution path instead of creating a second worker system. This means model routing, DLP, tool governance, audit snapshots, workspace scoping, task logs, execution timeline, and WebSocket delivery all remain consistent.

### Dynamic workflow API

| Endpoint | Behavior |
| --- | --- |
| `POST /api/v1/supervisor/workflows` | Create a workflow from `{ goal }` or dispatch a supplied `DynamicWorkflowPlan` |
| `GET /api/v1/supervisor/workflows` | List workflow runs, optionally scoped by workspace |
| `GET /api/v1/supervisor/workflows/:id` | Return workflow run plus child tasks |
| `POST /api/v1/supervisor/workflows/:id/cancel` | Mark a workflow cancelled |

The current planner is deterministic and rule-based. It can be replaced or augmented later by an LLM planner that produces the same validated `DynamicWorkflowPlan` shape.

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
| `image.generate_wechat_cover` | 本地生成 900×383 公众号 PNG 封面 |

### Recommended Tool Mapping

| Agent | Recommended tools |
| --- | --- |
| PM / Master / Review | `web.search`, `web.fetch` |
| Dev / API / DB / Ops | `web.search`, `web.fetch` |
| Doc Writer | `web.search`, `web.fetch`, `crawler.extract_links` |
| WeChat Writer | `web.search`, `web.fetch`, `crawler.extract_links`, `content.wechat_layout`, `image.generate_wechat_cover`, `mcp__wechat-official-account__wechat_permanent_media`, `mcp__wechat-official-account__wechat_draft` |
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
  Runtime --> Loop[TypeScript Agent Loop]
  Loop --> Gateway[ModelGateway]
  Gateway --> Proxy[OpenAI-compatible endpoint / Copilot SDK]
  Proxy --> Model[GPT / Claude / Codex]
```

Routing order:

1. **Task route** from goal/input/profile, prompt size, and retry count:
   - simple summaries/docs/triage -> cheap route
   - code/fix/refactor/API/DB -> `gpt-5.3-codex`
   - explicit security/tenant/DLP/sandbox/release-risk reviews -> strong route
   - long prompt/context -> `gpt-5.4`
   - repeated failures -> balanced, then strong
2. Explicit enabled `agent.model`.
3. Explicit enabled `agent.config.model` / `modelPolicy.preferredModel`.
4. `modelPolicy.fallbackModel` or `modelPolicy.tier`.
5. Enabled `role:<agent.role>` route.
6. Enabled `global` route.
7. Highest-priority enabled model in the requested fallback group.
8. `AGENT_FACTORY_MODEL` as the final runtime fallback.

Each execution writes a `model.route` trace span and a `model_usage_stats` row with selected model, tokens/cost when available, latency, and route reason. `/api/models` exposes the catalog, enabled flags, health checks, and route updates; model config changes are audited as `model.update` / `model.route.update`.

### Model routing examples

| Task profile | Selected model | Why |
| --- | --- | --- |
| "summarize release notes" | `gpt-5.4-mini` | cheap default for small low-risk text tasks |
| "fix TypeScript API bug" | `gpt-5.3-codex` | coding route |
| "security review tenant isolation" | `gpt-5.5` | explicit high-risk review route |
| "analyze entire repository" | `gpt-5.4` | long-context route |
| cheap task failed once | `gpt-5.4` | retry escalation to balanced |
| task failed repeatedly | `gpt-5.5` | retry escalation to strong |

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
| `wechat-article` | 选题 → 写作 → 审核 → 排版 → 草稿箱同步 → 人工确认发布 |
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
  dynamic_workflows ||--o{ tasks : dispatches
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

  dynamic_workflows {
    text id PK
    text goal
    text status
    json plan
    json task_ids
    text workspace_id
    text result
    text validation_summary
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
| Workflow | `workflow:created`, `workflow:planned`, `workflow:task_dispatched`, `workflow:task_completed`, `workflow:done`, `workflow:failed` |
| Agent | registry/status related updates |

## 12. Deployment View

```mermaid
flowchart TB
  Browser[Browser] --> Vite[Vite dev server :5173]
  Vite -->|proxy /api /ws| Node[Node Express :3000]
  Node --> SQLite[(SQLite file)]
  Node --> Redis[(Redis optional)]
  Node --> TSLoop[TypeScript Agent Loop]
  TSLoop --> ModelEndpoint[OpenAI-compatible endpoint / Copilot SDK]
  TSLoop --> Internet[Governed web / MCP tools]
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
| Workspace lifecycle | Registered source and immutable execution binding; isolated preparation or leased shared roots; candidate-only retention |
| Artifact evidence | Separate hash-verified snapshot storage before completion; reviewed archive/restore/purge and patch apply |
| Execution messages | Runtime activity is persisted for timeline/history views |
| Operator controls | Cancel/retry/delete/pipeline controls are recorded and role-gated |
| Human inbox | Approval/question/input/review entries persist operator decisions |
| Runtime budgets | Max turns, output length, token budget, tool-call count, cumulative tool runtime, and wall-clock limits |
| Model fallback | Task route fallback group, role/global routes, retry escalation, and final env fallback |

### Execution directory and artifact layers

The authorization `workspaceId`, filesystem workspace registration and Task
directory binding are distinct identities. Additive SQLite records persist roots,
actors, baselines, imports, preparation recipes, fenced leases, operation journals
and immutable artifact metadata. Follow-ups, child tasks and pipeline stages
inherit the recorded directory; shared writers serialize even across Agents.

`workspace-manager.ts` prepares pinned Git HEAD worktrees or bounded filtered
copies without defaulting to the service repository. `task-workspace.ts` verifies
paused checkpoints. `artifact-snapshot-store.ts` seals fixed bytes independently
of directory retention. Lifecycle and patch routes recheck actor/workspace scope,
fresh preview receipts, root identity and blockers at mutation time.

Completion, acceptance, source integration and storage removal are separate
operations. Retention marks candidates, archive preserves files, purge requires
owned archived storage and verified coverage. Reviewed Git/non-Git apply supports
frozen-baseline additions/edits and sealed deletion evidence rather than a
commit/merge. Legacy adoption and merge-checked task-branch cleanup have separate
scoped previews. Uncertain effects need explicit lease
reconciliation; no timeout stealing or write replay.

These host path controls do not imply OS isolation, external-provider working
directory control, or readonly Shell/MCP support. See
[Workspace lifecycle](WORKSPACE-LIFECYCLE.md) for API, quotas, legacy compatibility,
recovery and the exact acceptance boundary.

## 13.1 Security and Governance Boundaries

### Agent Runtime V2 opt-in boundary

`MYRMECIA_RUNTIME_V2=true` composes the existing control plane with a thin Core
and Runtime Harness, rather than introducing a second task system:

| Responsibility | Authority |
| --- | --- |
| Model/tool iteration and hooks | `agents/core`, normalized `ProviderDriver` |
| Request and replay context | Scoped append-only session events and pure projections |
| Steering and queued next task | Durable Inbox, `SessionHarness`, existing `TaskQueue` |
| Parallel trusted reads and resource exclusion | Core scheduler and shared SQLite tool-resource locks |
| Durable state writes | Owner lease, fencing token and transactional commit gates |
| Spend and cumulative limits | Persistent scoped policies, reservations and usage receipts |
| Stable read-only continuation | Canonical checkpoints and wakeups, same queue/job identity |
| Outcome and human approval | Submitted completion criteria, evidence hashes, separate acceptance |

Ordinary, structured Skill and summary requests share context preparation.
SDK-owned internal loops remain capability boundaries; internal model turns
and unavailable usage/cost are unknown, not inferred from host requests.
Stable checkpoints replay context only, never external tools. In-flight
requests and unknown effects stop automatic recovery.

`host_policy` has no OS isolation. The optional `docker_isolated` backend
protects only supported local tools; remote MCP, external Agent internals and
host plugins do not inherit it. Unsupported isolated operations fail closed.
Real enforcement evidence currently covers this host's Colima Docker
configuration, not every deployment platform. See [AGENT-RUNTIME-V2.md](AGENT-RUNTIME-V2.md).

![Runtime Governance and Tool Safety](diagrams/runtime-governance.svg)

| Boundary | Enforcement |
| --- | --- |
| API auth | Static admin token and API key auth with route scope checks |
| Tenant/workspace | Request workspace context gates REST routes, WebSocket subscriptions, and audit/workflow access |
| Tool policy | Tool catalog must be enabled, allowed by agent, not approval-required, and pass metadata checks |
| Tool guardian | Blocks pipe-to-shell, destructive git, unsafe SQL, obvious exfiltration, high-confidence secrets, and unsafe package installs |
| DLP | Agent output, tool output, and cached output pass through DLP redaction/blocking |
| Runtime isolation | TS loop enforces turn/token/time/output limits and sandbox-profile permissions; its tools are in-process, not automatically container-isolated by `EXECUTOR_MODE` |
| Auditability | Execution policy snapshots capture model route, tool policy, runtime limits, workspace scope, DLP mode, and blocked events |

## 14. Current Limits and Extension Points

### Agent configuration and governance

Agent identity/configuration, a task's pinned configuration, and runtime execution
state are separate records. Setup drafts belong to the server-resolved actor and
workspace. Config revisions include instructions, contracts, model policy, Skill
versions, authorized knowledge bindings, tools and limits; publishing changes the
activation pointer, never historical task snapshots.

| Surface | Authority and boundary |
| --- | --- |
| Setup recovery | Scoped server drafts, revision checks and idempotent creation/test receipts; recovery never auto-runs a terminal test |
| Evaluation | Saved bounded checks and selected config version; runtime collection persists hashes/provenance, while semantic quality requires human review |
| Knowledge | Agent-private, explicit Team-shared and session-only scopes; retrieval, citation metadata and file bytes recheck workspace/actor access |
| Budget editing | `routes/agent-budget.ts`, expected revision, actual legacy defaults and live Agent aggregate policy |
| Dispatch accounting | `agent-budget.ts` / `budget-service.ts`: task, Agent and workspace policy intersection, transactional reservations, dispatched-unknown retention and idempotent receipts |
| Concurrent admission | AgentManager claims before async workspace preparation; AgentRuntime checks active executions atomically before insert; queue wakes continuations after admission release |
| Inline controls | `GET /tasks/:id/controls` computes capabilities; pause/resume/cancel use the existing queue/checkpoint authority, not optimistic browser state |
| Attempt history | Scoped `agent_debug_task_history`; confirmed rerun and terminal follow-up use fresh task IDs with response-loss idempotency |
| Acceptance | Current completion evidence and freshness checks plus explicit human decision; failed/unavailable evidence is not accepted |

Task run caps remain pinned, whereas edited Agent aggregate quotas apply to new
dispatches immediately. Resume does not reset usage or allow reservation replay.
USD admission relies on configured pricing and conservative estimates; unknown
pricing/subscription usage is not displayed as measured zero. Opaque external or
provider-owned loops are rejected when required limits cannot be enforced.
`utc_day` quotas reset at UTC midnight, not local browser time.

The running application remains synchronous SQLite. `getAsyncDb()` is an
experimental PostgreSQL boundary, not end-to-end compatibility. The separate
`plan/refactor-postgres-compatibility-v1.md` covers async caller conversion,
transaction/locking parity, dispatch outbox, backend tests and controlled data
migration. This governance work does not switch databases or runtime defaults.

| Area | Current design | Extension |
| --- | --- | --- |
| Tools | TypeScript sandbox tools and MCP integrations | Add governed provider-backed tools |
| Model list | Static dashboard dropdown | Fetch model list from the configured OpenAI-compatible endpoint if available |
| Agent skills | Markdown + dashboard overlay | Versioned skill registry and diff/rollback |
| Queue | Redis optional, memory fallback | Distributed workers and per-Agent concurrency pools |
| Dashboard editing | Agent create/edit supported | Full diff view, dry-run prompt preview, tool permission templates |
| Content tools | WeChat layout + SVG cover | Real WeChat editor export, image model generation, media library |
