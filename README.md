# 🏭 Agent Factory

**Autonomous Agent Orchestration System**

A multi-agent task management platform powered by Claude Code CLI. Manage a pool of AI agents that can work independently or as a coordinated pipeline — from product spec to deployment.

## Features

- 🎯 **Three Operation Modes**: Master dispatch, direct assign, or full pipeline
- 👀 **Real-time Dashboard**: Monitor all agents, tasks, and pipelines via web UI
- 🔗 **Pipeline Workflows**: Automated stage-by-stage execution (PM → UI → Dev → QA → Deploy)
- 🤖 **Agent Pool**: Specialized agents with distinct roles and capabilities
- 🧰 **Tool Runtime**: Govern built-in tools with enable/approval policy, execution history, and Dashboard catalog
- 🧭 **Run Trace**: Inspect structured spans for prompt build, model selection, LLM calls, tool calls, and policy blocks
- 🧠 **Model Registry & Routing**: Manage Copilot proxy GPT/Claude models, role defaults, health badges, and fallbacks
- 📚 **Skill Versioning**: Import Markdown skills, draft/publish versions, assign/rollback per Agent, and trace execution checksums
- 🔧 **Visual Pipeline Builder**: Create/edit multi-stage templates, validate roles/prompts, and run them from the dashboard
- 🧾 **Permission Audit**: Role-gate runtime/config controls and record Agent/Tool/Task/Pipeline operator actions
- 📢 **Smart Notifications**: Get notified when tasks complete or need your input
- ⚡ **Parallel Execution**: Multiple agents working simultaneously

## Architecture

```
┌─────────────────────────────────┐
│        Web Dashboard            │
│  Task Board · Logs · Agents     │
└──────────────┬──────────────────┘
               │ WebSocket
┌──────────────┴──────────────────┐
│        Orchestrator API         │
│  Queue · Pool · Pipeline · Bus  │
└──────────────┬──────────────────┘
               │
     ┌─────────┼─────────┐
     ▼         ▼         ▼
  Mode A    Mode B    Mode C
  Master    Direct    Pipeline
  Dispatch  Assign    Flow
     │         │         │
     ▼         ▼         ▼
┌─────────────────────────────────┐
│          Agent Pool             │
│  PM · UI · Dev · QA · Ops · Rev│
└─────────────────────────────────┘
```

## Quick Start

```bash
# One-click local startup
./scripts/start.sh

# Or through pnpm
pnpm start:local

# Open dashboard
open http://localhost:5173
```

Useful startup options:

```bash
./scripts/start.sh --clean-db        # start with a fresh local SQLite DB
./scripts/start.sh --install-python  # install CrewAI runtime dependencies
./scripts/start.sh --server-only     # start only the API server
./scripts/start.sh --dashboard-only  # start only the dashboard
DB_PATH=/tmp/agent-factory.db ./scripts/start.sh
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + TypeScript + Tailwind CSS + shadcn/ui |
| Backend | Express + TypeScript + BullMQ |
| Agent Runtime | Claude Code CLI (subprocess) |
| Queue | Redis + BullMQ |
| Database | SQLite (better-sqlite3) |
| Real-time | WebSocket (ws) |
| Notifications | WebSocket push + WeCom (optional) |

## Project Structure

```
agent-factory/
├── docs/                    # Design docs & specs
│   ├── SPEC.md              # Product specification
│   ├── ARCHITECTURE.md      # Technical architecture
│   ├── API.md               # API reference
│   ├── DEPLOYMENT.md        # Deployment and security notes
│   └── diagrams/            # Architecture diagrams
├── packages/
│   ├── server/              # Backend API + Orchestrator
│   │   ├── src/
│   │   │   ├── agents/      # Agent management & lifecycle
│   │   │   ├── pipelines/   # Pipeline engine
│   │   │   ├── queue/       # Task queue (BullMQ)
│   │   │   ├── routes/      # Express routes
│   │   │   ├── ws/          # WebSocket handlers
│   │   │   └── db/          # SQLite models
│   │   └── package.json
│   └── dashboard/           # Frontend React app
│       ├── src/
│       │   ├── components/  # UI components
│       │   ├── hooks/       # Custom hooks
│       │   ├── pages/       # Route pages
│       │   └── stores/      # State management
│       └── package.json
├── agents/                  # Agent definitions
│   ├── pm.md                # PM Agent skill
│   ├── ui.md                # UI Agent skill
│   ├── dev.md               # Dev Agent skill
│   ├── qa.md                # QA Agent skill
│   ├── ops.md               # DevOps Agent skill
│   └── review.md            # Review Agent skill
├── templates/               # Pipeline templates
│   ├── full-product.yaml    # Spec → Design → Code → Test → Deploy
│   ├── bugfix.yaml          # Triage → Fix → Test → Deploy
│   └── feature.yaml         # Spec → Code → Test → Review
└── package.json             # Monorepo root
```

## Modes of Operation

### Mode A: Master Dispatch
You give a high-level task to the Master Agent. It breaks it down and delegates to worker agents automatically.

### Mode B: Direct Assign
You assign tasks directly to specific agents from the dashboard.

### Mode C: Pipeline Flow
A predefined pipeline runs stage-by-stage. Each agent's output feeds the next stage's input.

Open **Pipelines** to use the visual builder: add/reorder stages, select an Agent role for each stage, edit prompt templates, choose auto/manual gates, validate missing roles or prompts, save the template, and run it immediately.

## Custom Agents and Tools

Agent Factory supports custom Agent creation from both the API and dashboard. Open the **Agents** page and use **Create Custom Agent** to define:

- name, emoji, role, description/skill prompt
- capabilities and trigger keywords
- model, max turns, timeout
- allowed tool whitelist

The server also exposes `POST /api/agents` for programmatic registration. Dynamically-created agents are stored in SQLite and can execute even when they are not present in `agents/registry.yaml`.

Built-in CrewAI tools are dependency-light and governed by the server-side Tool Runtime. Open the **Tools** page to enable/disable tools, require approval, and inspect recent tool executions. Runtime filters each Agent's `allowedTools` through the platform policy before passing tools to CrewAI, and Python tool calls emit `tool_use` / `tool_result` events that are persisted in SQLite.

| Tool | Purpose | Good fit |
| --- | --- | --- |
| `web.search` | Search web results for current research | PM, doc writer, content writer, review |
| `web.fetch` | Fetch compact page text from http/https URLs | PM, doc writer, i18n, dev, content writer |
| `crawler.extract_links` | Extract visible links from a page | doc writer, research, WeChat article planning |
| `content.wechat_layout` | Generate mobile-friendly WeChat HTML layout blocks | WeChat writer |
| `content.hashtag_plan` | Generate Chinese keyword/tag clusters | WeChat/Xiaohongshu writer, PM |
| `image.generate_svg` | Generate a simple SVG cover asset in `generated-assets/cover.svg` | UI, WeChat/Xiaohongshu writer |

Preset agents in `agents/registry.yaml` already include appropriate `allowed_tools`. On startup, registry metadata refreshes existing preset agents so newly added tool permissions are applied without recreating the database.

Recommended custom agent presets:

- **Research Assistant**: `web.search`, `web.fetch`, `crawler.extract_links`
- **WeChat Operator**: `web.search`, `web.fetch`, `content.wechat_layout`, `content.hashtag_plan`, `image.generate_svg`
- **Visual Content Assistant**: `image.generate_svg`

Skills are now governed resources too. Startup imports `agents/*.md` into the Skill Registry as published versions and assigns them to matching preset Agents. Open the **Skills** page to create draft prompt versions, publish them, diff against the current published version, and assign or roll back any Agent to a published skill version. New executions persist `skillVersionId` and include the skill checksum in the `prompt.build` trace span.

Agent model selection is loaded from the server-side Model Registry instead of a hardcoded UI list. The registry is intentionally limited to configured copilot-api reverse proxy models, and the dashboard dropdown shows only enabled models. Runtime routing uses explicit Agent model first, then role default routes, then fallback groups/global defaults. Because CrewAI talks to the copilot-api reverse proxy through an OpenAI-compatible client, Claude models are also configured with the `openai/` LiteLLM prefix.

| Model ID | Recommended use |
| --- | --- |
| `openai/claude-opus-4.7` | strongest Claude reasoning for master planning, architecture, high-risk review |
| `openai/claude-opus-4.6` | complex planning and long-context analysis |
| `openai/claude-sonnet-4.6` | high-quality balanced Claude model for PM, review, content, docs |
| `openai/claude-sonnet-4.5` | stable balanced Claude fallback |
| `openai/claude-haiku-4.5` | fast/low-cost Claude model for QA, i18n, simple processing |
| `openai/claude-sonnet-4` | Claude Sonnet fallback |
| `openai/gpt-5.5` | strongest planning, review, orchestration |
| `openai/gpt-5.4` | default balanced model for most agents |
| `openai/gpt-5.4-mini` | fast/low-cost QA, i18n, simple docs |
| `openai/gpt-5.3-codex` | coding, refactoring, engineering work |
| `openai/gpt-5.2-codex` | coding fallback |
| `openai/gpt-5.2` | general fallback |
| `openai/gpt-5-mini` | lightweight tasks |
| `openai/gpt-4.1` | compatibility/fast fallback |

## Demo Walkthroughs

1. **Custom Research Agent**: open **Agents**, create a Research Assistant with `web.search` and `web.fetch`, choose an enabled model, run it, then inspect **Timeline** for model/tool trace spans.
2. **Skill rollback**: open **Skills**, create a draft version for an Agent skill, publish it, assign it to the Agent, then roll back by assigning an older published version.
3. **Model fallback**: disable a model through `/api/models/:id` or the model API, run an Agent that requested it, and inspect the `model.route` span for the fallback reason.
4. **Tool governance**: open **Tools**, require approval or disable a tool, run an Agent that requested it, and review blocked tool policy spans plus Audit records.
5. **Visual pipeline**: open **Pipelines**, build a multi-stage template, validate roles/prompts, save it, run with auto or manual gates, and monitor stage progress.

## License

MIT
