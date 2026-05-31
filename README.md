# Agent Factory

Autonomous multi-agent orchestration platform. Manage a pool of AI agents that execute tasks independently or in coordinated pipelines — from product spec to deployment.

## Architecture

![Architecture Overview](docs/diagrams/architecture-overview.png)

Agent Factory is a **pnpm monorepo** that combines a TypeScript backend (Express 5), a React dashboard, and a Python CrewAI runtime. Agents are spawned as CrewAI subprocesses, orchestrated through a BullMQ/Redis task queue, with real-time WebSocket events streamed to the dashboard.

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + TypeScript + Tailwind CSS + shadcn/ui |
| Backend | Express 5 + TypeScript |
| Queue | BullMQ (Redis) with in-memory fallback |
| Agent Runtime | Python CrewAI (subprocess) |
| Database | SQLite (dev) / PostgreSQL (prod) |
| Real-time | WebSocket pub/sub per resource |
| Containerization | Docker Compose (server + dashboard + Redis) |

## Quick Start

**Prerequisites:** Node.js >= 20, pnpm >= 9, Python 3 (for CrewAI runtime)

```bash
pnpm install
pip install -r packages/crew/requirements.txt

# Start dev server + dashboard
pnpm dev

# Open dashboard
open http://localhost:5173
```

Startup options via `./start.sh`:

```bash
./start.sh --clean-db        # fresh SQLite database
./start.sh --install-python  # install CrewAI deps automatically
./start.sh --server-only     # API server only (port 3000)
./start.sh --dashboard-only  # dashboard only (port 5173)
```

Or via Docker:

```bash
docker compose up -d
# Server: http://localhost:3000
# Dashboard: http://localhost:5173
```

## Project Structure

```
agent-factory/
├── packages/
│   ├── server/       # Express 5 orchestrator — agents, pipelines, queue, routes, WebSocket
│   ├── dashboard/    # React 19 SPA — task/agent/pipeline monitoring, cost analytics
│   ├── crew/         # Python CrewAI bridge — agent subprocess runtime
│   ├── cli/          # CLI tool for interacting with the platform
│   └── shared/       # TypeScript type definitions shared across packages
├── agents/           # Agent definitions (registry.yaml + 23 skill .md files)
├── templates/        # Pipeline templates (11 YAML workflow definitions)
├── docs/             # Design specs, architecture docs, diagrams
├── docker-compose.yml
└── Dockerfile
```

## How It Works

1. **Task Queue** — `TaskQueue.enqueue()` creates a task, emits `task:created`, and enqueues in BullMQ (or runs in-memory when Redis is unavailable).
2. **Agent Manager** — checks concurrent capacity, delegates to `AgentRuntime`.
3. **Agent Runtime** — spawns a CrewAI Python subprocess, tracks progress/cost/tokens, records trace spans, emits events.
4. **Pipeline Engine** — listens for `task:done`, writes stage artifacts, advances to the next ready stage(s). Supports parallel stages (`dependsOn`), manual gating, loop stages, and rollback.
5. **WebSocket Hub** — maps internal events to pub/sub channels (`tasks`, `task:{id}`, `agents`, `agent:{id}`, `pipelines`, `pipeline:{id}`, `executions`, `execution:{id}`).

## Features

### Agent Pool

23 specialized agents defined in `agents/registry.yaml`: Master, PM, UI Designer, Developer, QA, DevOps, Reviewer, Security Reviewer, API Designer, DB Migration, Doc Writer, i18n, Issue Refiner, Release Notes, Release Compliance, Performance Investigator, GitOps Reviewer, React Dashboard Auditor, Accessibility Tester, QA Automation, Architecture Planner, WeChat Writer, Xiaohongshu Writer.

Custom agents can be created from the dashboard or API. Each agent has configurable model, max turns, timeout, tool whitelist, and skill assignment.

### Pipeline Workflows

11 pipeline templates for automated stage-by-stage execution:

| Template | Flow |
|----------|------|
| `full-product.yaml` | Spec → Design → Code → Test → Deploy |
| `bugfix.yaml` | Triage → Fix → Test → Deploy |
| `feature.yaml` | Spec → Code → Test → Review |
| `feature-with-qa-loop.yaml` | Feature with automated QA feedback loop |
| `product-quality.yaml` | Full product pipeline with quality gates |
| `parallel-feature.yaml` | Parallel stage execution via `dependsOn` |
| `qa-validation.yaml` | Dedicated QA validation workflow |
| `release-compliance.yaml` | Compliance-checked release process |
| `structured-autonomy.yaml` | Autonomous agent workflow with structured outputs |
| `wechat-article.yaml` | WeChat article generation pipeline |
| `xiaohongshu-note.yaml` | Xiaohongshu note generation pipeline |

Use the visual pipeline builder in the dashboard to create, edit, validate, and run custom templates.

### Agent Federation (Batch C)

Inter-agent communication protocol enabling agents to discover each other, share artifacts, and coordinate work. Includes capability registry, shared artifact store with access control, and sync/async messaging between agents.

### Skill Registry

Markdown-based skills with YAML frontmatter, versioned drafts/published states, assignment per agent, hot-reload via file watcher, and checksum-verified execution traces.

### Model Registry & Routing

Centralized model catalog with per-agent defaults, role-based routing, health badges, and automatic fallback chains. Supports GPT and Claude models via a Copilot-compatible proxy.

### Cost Dashboard

Real-time cost tracking with per-agent and per-model breakdowns, token usage charts, cost trend analysis, and summary cards.

### Execution Trace

Structured span inspection for prompt build, model selection, LLM calls, tool calls, and policy blocks. Full visibility into every agent execution.

### Tool Governance

Built-in tool runtime with enable/disable toggles, approval requirements, execution history, and per-agent tool whitelists. Blocks and approvals are recorded in the audit log.

### Quality & Governance

- **Self-healing** — automatic retry and recovery for failed executions
- **Quality loops** — feedback-driven improvement cycles
- **Execution scoring** — LLM judge evaluates output quality with sliding window averages
- **Coverage checking** — triggered on task completion
- **Pipeline rollback** — checkpoint-based stage rollback with retry
- **Operator audit** — all admin actions recorded

### Smart Notifications

WebSocket push notifications when tasks complete or require input. Optional WeCom integration.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CREWAI_BASE_URL` | CrewAI API endpoint |
| `CREWAI_API_KEY` | CrewAI API key |
| `CREWAI_MODEL` | Default model for CrewAI |
| `ANTHROPIC_API_KEY` | Fallback for CrewAI API key |
| `REDIS_URL` / `REDIS_HOST` | Redis connection (in-memory queue fallback if unset) |
| `DATABASE_URL` | PostgreSQL connection string (SQLite when unset) |
| `PORT` | Server port (default 3000) |
| `NODE_ENV` | `development` / `production` |

## Commands

| Task | Command |
|------|---------|
| Install all deps | `pnpm install` |
| Dev server + dashboard | `pnpm dev` |
| Dev server only | `pnpm dev:server` |
| Dev dashboard only | `pnpm dev:dashboard` |
| Build all packages | `pnpm build` |
| Type-check | `pnpm lint` |
| Server tests | `pnpm --filter @agent-factory/server test` |
| Single test file | `pnpm --filter @agent-factory/server exec vitest run tests/<file>.test.ts` |
| Dashboard tests | `pnpm --filter @agent-factory/dashboard test` |
| Dashboard e2e | `pnpm --filter @agent-factory/dashboard test:e2e` |

## License

MIT
