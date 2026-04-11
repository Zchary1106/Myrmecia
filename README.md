# 🏭 Agent Factory

**Autonomous Agent Orchestration System**

A multi-agent task management platform powered by Claude Code CLI. Manage a pool of AI agents that can work independently or as a coordinated pipeline — from product spec to deployment.

## Features

- 🎯 **Three Operation Modes**: Master dispatch, direct assign, or full pipeline
- 👀 **Real-time Dashboard**: Monitor all agents, tasks, and pipelines via web UI
- 🔗 **Pipeline Workflows**: Automated stage-by-stage execution (PM → UI → Dev → QA → Deploy)
- 🤖 **Agent Pool**: Specialized agents with distinct roles and capabilities
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
# Install dependencies
pnpm install

# Start dev server (API + Dashboard)
pnpm dev

# Open dashboard
open http://localhost:3000
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

## License

MIT
