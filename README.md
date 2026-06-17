<p align="center">
  <img src="packages/dashboard/public/myrmecia-banner.svg" alt="Myrmecia — Multi-Agent Orchestration" width="100%">
</p>

<div align="center" style="line-height: 1;">
  <img alt="Node" src="https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white"/>
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-%3E%3D9-F69220?logo=pnpm&logoColor=white"/>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white"/>
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black"/>
  <img alt="Express" src="https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white"/>
  <img alt="MCP" src="https://img.shields.io/badge/MCP-enabled-7C3AED"/>
  <img alt="License" src="https://img.shields.io/badge/License-MIT-green"/>
</div>

---

# Myrmecia — Autonomous Multi-Agent Orchestration Platform

> *Formerly **Agent Factory**.* A colony of specialized agents, coordinated through a shared memory. See [Why Myrmecia](#why-myrmecia--the-colony-model).

Myrmecia is a self-hosted, code-first platform that manages a pool of specialized AI agents and runs them — independently, in coordinated pipelines, or on a **drag-and-drop canvas** — from product spec through design, code, test, and deploy. It pairs a complete agent **harness** (tool-calling loop, memory, context management, model routing) with enterprise-grade governance, observability, and a real-time dashboard.

## News
- [2026-06] **Coding tools + TDD** — agents get a sandboxed engineering toolset (`file_read` / `file_write` / `file_list` / `apply_patch` / `shell_exec` / `grep`, workspace-confined, path-traversal-proof, governed). The dev agent runs a full **test-driven** loop (write failing tests → implement → refactor) and produces working code that passes its own tests.
- [2026-06] **Auto-compact context** — long tool-calling loops summarize older turns before each model call, bounding per-call context to ~O(1) and total usage to ~O(N) so runs no longer hit the token budget.
- [2026-06] **Interactive CLI** — a zero-dependency `myrmecia` terminal shell: a welcome banner, natural-language input *routed live to the right specialist*, and `/slash` commands. Same backend as the dashboard. [See usage ↓](#command-line-cli)
- [2026-06] **Visual Orchestration** — a drag-and-drop canvas (`Orchestrate` page) to wire agents into a DAG; the `GraphWorkflowEngine` dispatches each node when its predecessors finish, feeds upstream outputs downstream, and **journals runs for replay/resume**. Live node status streams over WebSocket.
- [2026-06] **MCP (Model Context Protocol)** — a dependency-free stdio client connects external MCP tool servers and **surfaces their tools inside the agent tool-calling loop** (`mcp__server__tool`).
- [2026-06] **Unified Memory** — four-layer memory (working / episodic / semantic / procedural) + a bi-temporal entity graph, with extraction → consolidation → reflection → decay, injected into context, routing, and decomposition.
- [2026-06] **Model Gateway & Token Streaming** — provider-agnostic client routing (`MODEL_PROVIDERS`) and opt-in `token:delta` streaming over WebSocket.
- [2026-05] **Dynamic Workflow Runtime** — runtime-generated executable plans that fan out across agents with dependency tracking and validation.
- [2026-05] **Supervisor Mode** — one-line task intake with intent classification and semantic routing learned from past executions.

<div align="center">

🚀 [Framework](#agent-factory-framework) | ⚖️ [Compare](#how-myrmecia-compares) | ⚡ [Installation](#installation) | 🎛️ [Usage](#usage) | 🧠 [Memory](#unified-memory) | 🔌 [MCP](#tooling--mcp) | 🛠️ [Commands](#commands) | 🤝 [Contributing](#contributing)

</div>

## Myrmecia Framework

Myrmecia mirrors a real engineering org: specialized agents (PM, design, dev, QA, ops, review, content) collaborate through templated pipelines, dynamic fan-out workflows, a supervisor that decomposes one-line requests, or a manual canvas you wire yourself. Every run flows through tool governance, guardrails, and full tracing, and feeds a shared long-term memory so the platform gets better at routing and decomposing similar work over time.

<p align="center">
  <img src="docs/diagrams/schema.svg" alt="Myrmecia schema" style="width: 100%; height: auto;">
</p>

> Myrmecia is local-first and self-hosted. It bundles the agent harness *and* the platform around it (queue, orchestration, governance, observability, dashboard) in a single pnpm monorepo.

### Agent Pool

A registry of role-specialized agents (`agents/registry.yaml` + skill markdown). Each agent declares a role, model tier with fallback, capabilities, allowed tools, and triggers. Agents are capability templates — runtime state lives in executions, not in long-lived workers.

<p align="center">
  <img src="docs/diagrams/agent-pool.svg" alt="Agent Pool" width="100%">
</p>

- **Master** — decomposes complex requests into a dependency-ordered subtask plan (now few-shot–primed by recalled past decompositions).
- **PM / UI / Dev / QA / Ops / Review** — the core delivery roles.
- **Content & specialists** — WeChat/RedNote writers, i18n, security, accessibility, performance, and more.

### Orchestration Modes

| Mode | What it does |
| --- | --- |
| **Direct** | Assign a task straight to one agent. |
| **Pipeline** | Fixed YAML stage sequence (PM → Design → Code → Test → Deploy) with manual gating, loop stages, and rollback. |
| **Dynamic Workflow** | A plan generated at runtime that fans out across agents with dependency tracking and validation. |
| **Visual Orchestration** | Drag agents onto a canvas and connect them; the `GraphWorkflowEngine` runs the DAG with live status, replay, and resume. |
| **Supervisor** | One-line intake; intent classification + semantic routing pick the mode/agent automatically. |

<p align="center">
  <img src="docs/diagrams/dynamic-workflow-lifecycle.svg" alt="Workflow Lifecycle" width="85%">
</p>

### Unified Memory

A single dimension-adaptive vector store backs four memory layers plus a bi-temporal entity graph:

- **Working** — per-execution context assembled by the Context Manager.
- **Episodic** — every task execution (input + outcome), workspace-scoped for cross-pipeline recall.
- **Semantic** — facts, conventions, and user preferences, extracted and de-duplicated (`ADD`/`UPDATE`/`NOOP`).
- **Procedural** — routing experience and reusable lessons synthesized by post-pipeline **reflection**.

Retrieval is a hybrid score (relevance + recency + importance + success) with MMR diversity; stale, low-value memory **decays** automatically. See [`docs/MEMORY-ARCHITECTURE.md`](docs/MEMORY-ARCHITECTURE.md).

### Tooling & MCP

- **Engineering tools** — agents can actually change code through a sandbox confined to the task workspace: `file_read`, `file_list`, `grep`, `file_write`, `apply_patch` (surgical single-occurrence edits), and `shell_exec`. Paths are traversal-checked, shell commands are guardrailed, and high-risk tools (e.g. `shell_exec`) require approval by default — granted per-agent as an operator override.
- **Built-in tools** flow through a registry → policy → sandbox → approval pipeline with per-agent allowlists and DLP.
- **MCP tools** — configure external MCP stdio servers via `MCP_SERVERS`; their tools are aggregated as `mcp__<server>__<tool>` and exposed to agents inside the tool-calling loop (toggle with `MCP_TOOLS_IN_AGENTS`).
- **Auto-compact** — long agent runs summarize older conversation turns before each model call (keeping the system prompt, the task, and recent turns verbatim), so context stays bounded instead of growing until it trips the token budget.
- **TDD loop** — the dev agent writes failing tests, implements until they pass, then refactors, validating each phase by running the workspace's test command.

### Governance & Observability

<p align="center">
  <img src="docs/diagrams/runtime-governance.svg" alt="Runtime Governance and Tool Safety" width="100%">
</p>

Budget/cost guardrails, DLP redaction, policy snapshots, operator audit, multi-tenant org/workspace isolation, API keys + RBAC, OpenTelemetry traces & metrics, run traces/spans, quality loops, self-healing, and checkpoint-based rollback.

## Screenshots

| Command Center | Unified Memory |
| --- | --- |
| ![Command Center](docs/diagrams/screenshots/01-command-center.png) | ![Memory](docs/diagrams/screenshots/03-memory.png) |
| **Agents** | **Visual Orchestration (drag‑and‑drop)** |
| ![Agents](docs/diagrams/screenshots/02-agents.png) | ![Orchestrate](docs/diagrams/screenshots/04-orchestrate.png) |

## Why Myrmecia — the colony model

> *Myrmecia* (the genus of bull ants) names the philosophy behind the platform: **no single brain holds the plan — intelligence emerges from many specialized agents coordinating through a shared memory that reinforces what works and lets the rest fade.**

This isn't a decorative metaphor; ant-colony mechanics map onto components we actually built. The coordination model ants use is **stigmergy** — indirect signalling through a shared environment — and its engineering form, **Ant Colony Optimization (ACO)**, is a classic algorithm for many simple agents finding optimal routes by reinforcing successful trails. That is precisely what this platform does.

| Colony mechanism | What it is in Myrmecia | Module |
| --- | --- | --- |
| **Pheromone trails** (successful paths reinforced) | Trajectory memory + semantic routing learns which agent/mode worked for similar tasks | `memory/trajectory-store` · `intent-classifier` |
| **Pheromone evaporation** (stale trails fade) | Memory **decay/forgetting** of stale, low-value entries | `memory/decay.ts` |
| **Ant Colony Optimization** (foraging shortest path) | Success/quality-weighted routing & model selection | semantic routing · `model-registry` |
| **Caste division of labor** | Role-specialized agents (PM / dev / QA / ops / review …) | `agents/registry.yaml` |
| **Decentralized emergent coordination** | DAG / dynamic workflows advance from local dependencies + upstream outputs | `agents/graph-workflow` · `dynamic-workflow` |
| **Trophallaxis** (sharing food & information) | Agent comms, shared artifacts, federation | `agent-comms` · `shared-artifact-store` |
| **Nest as collective memory** | Four-layer memory + bi-temporal entity graph | `memory/*` · `memory/graph.ts` |
| **Colony resilience** | Self-healing, quality loops, checkpoint rollback | `self-healing` · `quality-loop` |
| **Scale (dozens → millions)** | Worker pool, queue, distributed WebSocket | `scaling/*` |

**The one honest seam:** real colonies are leaderless, yet Myrmecia has an optional **Supervisor / Master**. We resolve this by casting the Master as a *founding queen* — she only **seeds and decomposes** the initial task; runtime coordination stays stigmergic (shared memory + dependency graphs). Drop her, and the colony still runs (direct and visual-DAG modes).

**Etymology & lineage:** from Greek *myrmex* (μύρμηξ, "ant") — the same root as the mythological **Myrmidons**, the fiercely disciplined warrior-people Zeus formed from ants: a fitting image for a disciplined fleet of agents working as one.

> Brand name **Myrmecia**; package scope migrates gradually from `@myrmecia/*` to `@myrmecia/*`, so the rename stays low-risk.

## How Myrmecia compares

Most tools in this space give you **one slice** of the problem. Myrmecia's differentiator is packaging the agent **engine** *and* the production **platform** around it — queue, orchestration, governance, observability, memory, and a real-time dashboard — as a single self-hosted system.

<p align="center">
  <img src="docs/diagrams/comparison.svg" alt="How Myrmecia compares — capability matrix" width="100%">
</p>

| Category | Representative tools | What they give | What Myrmecia adds on top |
| --- | --- | --- | --- |
| **Orchestration libraries** | LangGraph · AutoGen · CrewAI | An SDK to wire agents; you build the rest | Built-in queue, pipelines, governance, observability, and live WebSocket events — a product, not a library |
| **Visual workflow builders** | Dify · n8n · Flowise | Drag-and-drop flows, shallow agent depth | Drag-drop **and** code **and** a one-line *Supervisor* that decomposes tasks — plus run replay/resume |
| **Memory services** | Mem0 · Zep | A bolt-on memory store | Four-layer memory + bi-temporal graph wired **into** context, routing, and decomposition |
| **Hosted platforms** | OpenAI Assistants · vendor clouds | Closed, data leaves your infra | **Local-first, self-hosted**, data stays on your machines |

**Where Myrmecia is strong**

- **All-in-one, self-hosted** — engine + platform in one monorepo; data never leaves your infrastructure.
- **Governance is built in** — tool registry with per-agent permissions, risk levels, approval gates, parameter constraints, cost guardrails, and audit.
- **Observability-first** — trace spans, execution scoring, token/cost tracking, and a real-time dashboard for debugging multi-agent runs.
- **Memory as a designed subsystem** — not a vector store bolted on; it feeds routing and task decomposition so the system gets better at dispatching similar work.
- **Pluggable runtimes & tools** — TypeScript loop or Python runtime, a provider-agnostic model gateway with token streaming, **MCP tools in the loop**, and a `browser.query` tool that drives a real browser.

**Where it's young (being honest)**

- Smaller community and ecosystem than LangGraph/CrewAI, and less battle-tested at scale.
- Some known engineering debt (a few TypeScript build errors and a `db.test` schema conflict) is still being cleaned up.
- The moat is **integration + governance + observability + memory** combined, not a single novel algorithm — so depth in those areas is where Myrmecia keeps its edge.

## Installation

**Prerequisites:** Node.js >= 20, pnpm >= 9, Python 3 (for the optional Python runtime).

```bash
git clone https://github.com/Zchary1106/agent-factory.git
cd agent-factory

pnpm install
pip install -r packages/python-runtime/requirements.txt

# Start dev server + dashboard
pnpm dev
# Dashboard: http://localhost:5173   ·   API: http://localhost:3000
```

### Startup options

```bash
./start.sh --clean-db        # fresh SQLite database
./start.sh --install-python  # install Python runtime deps automatically
./start.sh --server-only     # API server only (port 3000)
./start.sh --dashboard-only  # dashboard only (port 5173)
```

### Docker

```bash
docker compose up -d
# Server: http://localhost:3000   ·   Dashboard: http://localhost:5173
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `AGENT_FACTORY_BASE_URL` | OpenAI-compatible model endpoint (default provider) |
| `AGENT_FACTORY_API_KEY` | Model endpoint API key |
| `AGENT_FACTORY_MODEL` | Default fallback model |
| `ANTHROPIC_API_KEY` | Optional fallback API key |
| `MODEL_PROVIDERS` | JSON map of provider → `{ baseURL, apiKeyEnv }` for the model gateway |
| `MODEL_PROVIDER_MAP` | JSON map of modelId → provider name |
| `AGENT_STREAMING` | `true` to stream token deltas over WebSocket (default off) |
| `MCP_SERVERS` | JSON array of MCP stdio servers, e.g. `[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]` |
| `MCP_TOOLS_IN_AGENTS` | `false` to hide MCP tools from the agent loop (default on) |
| `EMBEDDING_BACKEND` | `openai` / `local` / `pseudo` for the memory vector store |
| `MEMORY_DECAY_INTERVAL_MS` | Periodic memory decay interval (0 disables) |
| `REDIS_URL` / `REDIS_HOST` | Redis connection (in-memory queue fallback if unset) |
| `DATABASE_URL` | PostgreSQL connection string (SQLite when unset) |
| `PORT` | Server port (default 3000) |
| `NODE_ENV` | `development` / `production` |

## Usage

### Dashboard

Open `http://localhost:5173`. Key pages: **Command Center**, **Interaction Console**, **Work Queue**, **Agents**, **Tools**, **Models**, **Skills**, **Pipelines**, **Orchestrate** (visual canvas), **Memory**, **Timeline**, **Observe**, **Audit**, **Costs**.

### Command-line (CLI)

Prefer the terminal? The `myrmecia` CLI drives the same server the dashboard uses — **zero install, zero dependencies** (Node ≥ 22 built-ins only).

<p align="center">
  <img src="docs/diagrams/cli-demo.gif" alt="Myrmecia interactive CLI" width="78%">
</p>

Run it with no arguments to open the **interactive colony shell** — a welcome banner, a Copilot-CLI-style **input frame** (with the active model and connection shown around it), then natural-language input that's *routed to the right specialist* live (the differentiator vs. single-agent tools), plus `/slash` commands to inspect and steer the colony:

```bash
pnpm cli                        # interactive shell (banner + input frame + routing)
pnpm cli --model claude-haiku-4.5   # start pinned to a specific model
```
```text
myrmecia ❯ Add a dark-mode toggle to settings, with tests
🐜 routed → dev · pipeline · medium · via semantic
  done      Spec · pm
  running   Code · dev
  …
myrmecia ❯ @feature Add a dark-mode toggle with tests   # put a whole team on it
🛠️  Feature Team · lead master · 5 teammates
  ✓ Spec     pm
  ▸ Code     dev
myrmecia ❯ @feature:dev use react-dropzone, keep the bundle small   # message a teammate
myrmecia ❯ /teams              # list the squads (🛠️ @feature 🐛 @bugfix 🔍 @quality …)
myrmecia ❯ /model              # show models, or `/model <id>` to switch the colony
myrmecia ❯ /agents             # see the 23-specialist colony
```

**Agent teams.** Beyond single agents, address a whole **squad** with `@team <task>`: the team's lead splits the goal into subtasks and the members **run in parallel on a shared task board** (dependency-gated), so you watch real teammates collaborate. As one teammate finishes, its key finding is shared with the others still working. You can also **talk to a teammate directly** — `@team:role <message>` (add `!` to *redirect* a finished teammate into new work, e.g. `@feature:dev! also add tests`), and press **Esc** to detach the board (it keeps running) so you can steer. Built-in teams: `@feature` (PM → UI → Dev → QA → Ops), `@bugfix`, `@quality`, `@release`, `@content`. Run `/teams` to see the roster; teams are defined in [`agents/teams.yaml`](agents/teams.yaml).

Or use it one-shot for scripting (every command streams live output):

```bash
pnpm cli health                                        # server status
pnpm cli agents                                        # list agents
pnpm cli ask "Add a dark-mode toggle with tests"       # classify + route + run
pnpm cli run pm "Write a spec for a dark-mode toggle"  # run a specific agent
pnpm cli pipeline Feature "Add CSV export to reports"  # run a pipeline (streams stages)
pnpm cli task <taskId>                                 # inspect a task
```

Point it at any server with `--server <url>` (or `MYRMECIA_SERVER`), add `--token` if API auth is enabled, and `--json` for machine-readable output. Run `pnpm cli --help` for the full list. You can also call it directly: `node packages/cli/src/index.ts`.

### Visual orchestration (drag-and-drop)

On the **Orchestrate** page, drag agents from the palette onto the canvas, click a node's `+` handle and then a target to connect them, set a Goal, and hit **Run**. Or do it over the API:

```bash
# Create a graph: PM → Dev, then Review
curl -s localhost:3000/api/v1/graph-workflows -H 'Content-Type: application/json' -d '{
  "name": "Feature flow",
  "input": "build a profile page",
  "graph": {
    "nodes": [
      {"id":"a","label":"Spec","agentRole":"product-manager"},
      {"id":"b","label":"Build","agentRole":"developer"},
      {"id":"c","label":"Review","agentRole":"reviewer"}
    ],
    "edges": [
      {"id":"e1","source":"a","target":"b"},
      {"id":"e2","source":"b","target":"c"}
    ]
  }
}'

# Run it (returns live runState; replay / resume / cancel also available)
curl -s -X POST localhost:3000/api/v1/graph-workflows/<id>/run \
  -H 'Content-Type: application/json' -d '{"input":"build a profile page"}'
```

### Dispatch a task

```bash
curl -s localhost:3000/api/v1/tasks -H 'Content-Type: application/json' -d '{
  "title": "Add dark mode",
  "description": "Implement a dark-mode toggle in the dashboard",
  "mode": "pipeline"
}'
```

### Connect an MCP server at runtime

```bash
curl -s localhost:3000/api/v1/mcp/servers -H 'Content-Type: application/json' -d '{
  "name": "fs",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
}'
curl -s localhost:3000/api/v1/mcp/tools   # aggregated tools as mcp__fs__*
```

## Architecture

This is a **pnpm monorepo** combining a TypeScript orchestrator, a React dashboard, and a Python agent runtime.

```
agent-factory/
├── packages/
│   ├── server/         # Express 5 orchestrator — agents, memory, pipelines, graph engine, MCP, queue, routes, WebSocket
│   ├── dashboard/      # React 19 SPA — command center, agents, pipelines, Orchestrate canvas, Memory, costs
│   ├── python-runtime/ # Myrmecia Python Runtime — agent subprocess runtime
│   ├── cli/            # CLI tool
│   └── shared/         # Shared TypeScript types
├── agents/             # Agent registry + skill markdown
├── templates/          # Pipeline templates (YAML)
├── docs/               # Specs, architecture, memory design, diagrams
└── docker-compose.yml
```

**Runtime flow:** `TaskQueue.enqueue()` → `AgentManager` (capacity/role) → `AgentRuntime` (TypeScript tool-loop or Python runtime; tracks cost/tokens/traces) → `PipelineEngine` / `GraphWorkflowEngine` advance dependent work → `EventBus` → WebSocket hub fans typed events to tenant-aware channels. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

<p align="center">
  <img src="docs/diagrams/architecture-overview.svg" alt="Architecture Overview" style="width: 100%; height: auto;">
</p>

## Commands

| Task | Command |
|------|---------|
| Install all deps | `pnpm install` |
| Dev server + dashboard | `pnpm dev` |
| Dev server / dashboard only | `pnpm dev:server` · `pnpm dev:dashboard` |
| CLI (terminal client) | `pnpm cli <command>` (e.g. `pnpm cli health`) |
| Build all packages | `pnpm build` |
| Type-check | `pnpm lint` |
| Server tests | `pnpm --filter @myrmecia/server test` |
| Single test file | `pnpm --filter @myrmecia/server exec vitest run tests/<file>.test.ts` |
| Dashboard tests / e2e | `pnpm --filter @myrmecia/dashboard test` · `test:e2e` |

## Contributing

Contributions are welcome — bug fixes, documentation, new agents/skills, and feature ideas. Please run the type-check and tests (`pnpm lint`, `pnpm --filter @myrmecia/server test`) before opening a PR.

## Acknowledgements

Myrmecia stands on the open-source ecosystem — Express, React, Vite, Tailwind, BullMQ, better-sqlite3, OpenTelemetry, the OpenAI SDK, and the Model Context Protocol. Its memory and orchestration designs draw on ideas from MemGPT/Letta, Mem0, Zep/Graphiti, and the Stanford Generative Agents work.

## Citation

If Myrmecia is useful in your work, a citation is appreciated:

```bibtex
@software{myrmecia_2026,
  title  = {Myrmecia: Autonomous Multi-Agent Orchestration Platform},
  author = {Myrmecia contributors},
  year   = {2026},
  url    = {https://github.com/Zchary1106/agent-factory}
}
```

## Star History

<div align="center">
<a href="https://star-history.com/#Zchary1106/agent-factory&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Zchary1106/agent-factory&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Zchary1106/agent-factory&type=Date" />
   <img alt="Myrmecia Star History" src="https://api.star-history.com/svg?repos=Zchary1106/agent-factory&type=Date" style="width: 80%; height: auto;" />
 </picture>
</a>
</div>

## License

MIT
