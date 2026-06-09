# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands use pnpm from the repo root. Node >=20, pnpm >=9 required.

| Task | Command |
|------|---------|
| Install all deps | `pnpm install` |
| Install Python runtime deps | `pip install -r packages/python-runtime/requirements.txt` |
| Dev server + dashboard | `pnpm dev` |
| Dev server only | `pnpm dev:server` |
| Dev dashboard only | `pnpm dev:dashboard` |
| Build all packages | `pnpm build` |
| Build one package | `pnpm --filter @myrmecia/<name> build` |
| Type-check (lint) | `pnpm lint` |
| Run server tests | `pnpm --filter @myrmecia/server test` |
| Run single test file | `pnpm --filter @myrmecia/server exec vitest run tests/<file>.test.ts` |
| Run test by name | `pnpm --filter @myrmecia/server exec vitest run tests/<file>.test.ts -t "test name"` |
| Watch server tests | `pnpm --filter @myrmecia/server test:watch` |
| Run dashboard tests | `pnpm --filter @myrmecia/dashboard test` |
| Run dashboard e2e | `pnpm --filter @myrmecia/dashboard test:e2e` |
| Preview dashboard build | `pnpm --filter @myrmecia/dashboard preview` |
| Start via script | `./start.sh` (pass `--clean-db`, `--install-python`, `--server-only`, `--dashboard-only`) |

The dashboard Vite dev server proxies `/api` and `/ws` to `localhost:3000`. Start the server before using Playwright e2e tests.

## Architecture

This is a **pnpm monorepo** for an autonomous multi-agent orchestration platform. It manages a pool of AI agents that execute tasks independently or in coordinated pipelines (Product Spec → Design → Code → Test → Deploy).

### Package layout

- **`packages/server`** — Express 5 + TypeScript orchestrator. Entry point: `src/index.ts`. Wires up SQLite, agent registry, task queue (BullMQ with Redis, or in-memory fallback), pipeline engine, WebSocket hub, and ~30 REST route modules under `/api/v1/`.
- **`packages/dashboard`** — React 19 + Vite + Tailwind + shadcn/ui. State managed via Zustand stores (`src/stores/`), API calls through `src/lib/api.ts`. Vite proxies `/api` and `/ws` to the server.
- **`packages/python-runtime`** — Agent Factory Python Runtime. `agent-runtime.ts` spawns `python3 packages/python-runtime/runtime_runner.py` as a subprocess, reading JSON-line events from stdout.
- **`packages/shared`** — TypeScript type definitions shared between server and dashboard. ESM package.
- **`agents/`** — Agent definition YAML (`registry.yaml`) and skill markdown files (`pm.md`, `dev.md`, etc.).
- **`templates/`** — Pipeline template YAML files (`full-product.yaml`, `bugfix.yaml`, `feature.yaml`).

### Runtime flow

1. `TaskQueue.enqueue()` creates a task row, emits `task:created`, and either enqueues in BullMQ (Redis) or runs in-memory.
2. `AgentManager.executeTask()` checks concurrent execution capacity, delegates to `AgentRuntime`.
3. `AgentRuntime.execute()` creates an execution row, runs the TypeScript loop or Agent Factory Python Runtime, tracks progress/cost/tokens, records trace spans, and emits events.
4. `PipelineEngine` listens for `task:done`, writes stage artifacts, and advances to the next ready stage(s). Supports parallel stages via `dependsOn`, manual gating, and rollback.
5. `EventBus` (singleton `eventBus` in `events/event-bus.ts`) emits typed events + a wildcard `*` copy. The WebSocket hub maps events to channels (`tasks`, `task:{id}`, `agents`, `agent:{id}`, `pipelines`, `pipeline:{id}`, `executions`, `execution:{id}`).

### Database

- SQLite via `better-sqlite3` (dev); PostgreSQL via `pg` when `DATABASE_URL` is set (prod).
- Schema: `packages/server/src/db/schema.sql`. Module schemas (orgs, auth, audit, etc.) are inlined in `database.ts` as `CREATE TABLE IF NOT EXISTS`.
- Columns are **snake_case** in DB; TypeScript models expose **camelCase** via `rowTo*` mapper functions in `packages/server/src/db/models/`.
- Prefer the existing DB model helpers (`createTask`, `updateTask`, `listAgents`, etc.) over raw SQL in routes/services.

### Key conventions

- **ESM**: All TypeScript packages use `"type": "module"`. Server imports local modules with `.js` extensions (e.g., `../db/database.js`).
- **REST errors**: Shaped as `{ error: { code, message } }`. The dashboard `api.ts` expects this shape and throws `error.message`.
- **Dashboard `@/` alias**: Configured in `packages/dashboard/vite.config.ts` and `tsconfig.json`, maps to `src/`.
- **Agent registry**: `agents/registry.yaml` defines agent templates. At startup, new agents are inserted only if their ID is not already in the DB. Existing agents get metadata refreshed.
- **Pipeline context**: `ContextManager` compresses older completed stages into summaries; only the immediate predecessor's output is included in full.
- **Workspaces**: Created under `.agent-factory/workspaces` by `WorkspaceManager`. These are ephemeral git worktrees or directories — do not treat them as source of truth.
- **Queue fallback**: If `REDIS_URL`/`REDIS_HOST` are absent, `TaskQueue` uses an in-memory execution path. With Redis, BullMQ uses the `agent-factory-tasks` queue.
- **Model runtime config**: `AGENT_FACTORY_BASE_URL`, `AGENT_FACTORY_API_KEY`, `AGENT_FACTORY_MODEL` env vars. `ANTHROPIC_API_KEY` is an optional fallback API key.
- **Logging**: Pino logger singleton from `src/lib/logger.ts`. Dev mode uses `pino-pretty`.

### Key services initialized at startup

`src/index.ts` wires up these services in order: telemetry → DB → tool/model registry sync → memory system → agent manager (from `agents/registry.yaml`) → skill registry + watcher → capability registry → task queue → pipeline engine → notifier → agent comms (federation) → self-healing → quality loop → coverage checker → execution scorer → pipeline rollback → Express app with middleware chain → WebSocket hub → worker pool.

### Known issues

- `pnpm lint` runs `pnpm -r lint` but no workspace currently defines a `lint` script (each uses `tsc --noEmit` via the `lint` field).
- `tests/db.test.ts` has a pre-existing failure from `schema.sql` defining `workspace_path` in both the base table and a migration.
- Server build has pre-existing TS errors around `AgentDefinition.status`, `IORedis` construction, and Express router type inference in `routes/executions.ts`.
