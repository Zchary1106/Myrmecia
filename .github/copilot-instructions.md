# Copilot instructions for Agent Factory

## Commands

Use pnpm from the repository root. Node >=20 and pnpm >=9 are expected.

| Task | Command |
| --- | --- |
| Install JS dependencies | `pnpm install` |
| Install Python agent runtime deps | `pip install -r packages/python-runtime/requirements.txt` |
| Run server + dashboard in dev | `pnpm dev` |
| Run only server | `pnpm dev:server` |
| Run only dashboard | `pnpm dev:dashboard` |
| Build all workspaces | `pnpm build` |
| Build server | `pnpm --filter @agent-factory/server build` |
| Build dashboard | `pnpm --filter @agent-factory/dashboard build` |
| Run server tests | `pnpm --filter @agent-factory/server test` |
| Run one server test file | `pnpm --filter @agent-factory/server exec vitest run tests/context-manager.test.ts` |
| Run one server test by name | `pnpm --filter @agent-factory/server exec vitest run tests/context-manager.test.ts -t "should include previous stage output"` |
| Watch server tests | `pnpm --filter @agent-factory/server test:watch` |
| Preview dashboard build | `pnpm --filter @agent-factory/dashboard preview` |

Playwright MCP is configured in `.vscode/mcp.json` for browser workflows against the Vite dashboard; start the dashboard with `pnpm dev:dashboard` or the full app with `pnpm dev` before using it.

Current command caveats:

- `pnpm lint` is defined at the root as `pnpm -r lint`, but no workspace currently defines a `lint` script.
- `pnpm --filter @agent-factory/server exec vitest run <file>` is the reliable single-test form; passing the file after `pnpm ... test --` can still run the full suite.
- Server tests currently include a pre-existing `tests/db.test.ts` failure from `schema.sql` adding `workspace_path` both in the base table and migration section.
- Server build currently has pre-existing TypeScript errors around `AgentDefinition.status`, `IORedis` construction, and the inferred Express router type in `routes/executions.ts`.

## Architecture

This is a pnpm monorepo for an autonomous multi-agent orchestration app:

- `packages/server` is an Express 5 + TypeScript orchestrator. `src/index.ts` wires SQLite, agent registry loading, queueing, pipeline templates, notification/self-healing/quality services, REST routes, and the WebSocket hub.
- `packages/dashboard` is a React 19 + Vite dashboard. Vite proxies `/api` and `/ws` to the server on port 3000 during local development.
- `packages/python-runtime` is the Agent Factory Python Runtime used by the server runtime. `agent-runtime.ts` spawns `python3 packages/python-runtime/runtime_runner.py` and parses JSON-line events from stdout.
- `agents/registry.yaml` defines agent capability templates and points to skill markdown files in `agents/*.md`.
- `templates/*.yaml` defines pipeline stage sequences. `PipelineEngine.loadTemplates()` reads `prompt_template` fields and persists them as `promptTemplate` in SQLite.

Runtime flow:

1. `TaskQueue.enqueue()` creates a task row, emits `task:created`, and either queues it in BullMQ when Redis is configured or runs the in-memory path.
2. `AgentManager.executeTask()` checks active execution capacity and delegates to `AgentRuntime`.
3. `AgentRuntime.execute()` creates a task execution row, runs the TypeScript loop or Agent Factory Python Runtime, updates task/execution state, records logs/messages, tracks cost through guardrails, and emits task/execution events.
4. `PipelineEngine` listens for `task:done`, writes stage artifacts, and advances stages. Manual gate mode pauses between stages; auto mode starts the next stage immediately.
5. `eventBus` emits typed events and a wildcard copy. `WSHub` maps events to channels such as `tasks`, `task:{id}`, `agents`, `agent:{id}`, `pipelines`, `pipeline:{id}`, `executions`, and `execution:{id}`.

Data model:

- SQLite is initialized from `packages/server/src/db/schema.sql`; `DB_PATH` overrides the default database path.
- Database columns are snake_case, while TypeScript models expose camelCase via `rowTo*` mappers in `packages/server/src/db/models`.
- Agents are capability templates, not long-lived worker state. Runtime state lives in `task_executions`, `execution_messages`, task status fields, and active execution counts.

## Repository-specific conventions

- TypeScript workspaces are ESM (`"type": "module"`). Server source imports local TS modules with `.js` extensions, e.g. `../db/database.js`.
- Prefer the existing DB model helpers (`createTask`, `updateTask`, `listAgents`, etc.) over raw SQL in routes/services so JSON parsing and snake_case/camelCase mapping stay consistent.
- REST error responses are shaped as `{ error: { code?, message } }`; `packages/dashboard/src/lib/api.ts` expects that shape and throws `error.message`.
- Dashboard API calls go through `src/lib/api.ts`; shared client state lives in `src/stores/store.ts` using Zustand. Several store loaders intentionally fall back or no-op when the backend is offline to keep the UI previewable.
- Dashboard imports can use the `@/*` alias configured in `packages/dashboard/vite.config.ts` and `packages/dashboard/tsconfig.json`.
- Agent registry changes require both `agents/registry.yaml` metadata and the referenced skill markdown. At server startup, registry agents are only inserted if their ID is not already present in the DB.
- Template YAML edits may not update already-persisted templates automatically because startup loading skips template names already present in SQLite.
- Pipeline context is intentionally compressed by `ContextManager`: older completed stages are summarized, while the immediate predecessor output is included in full.
- Workspaces and stage artifacts are generated under `.agent-factory/workspaces` by `WorkspaceManager`; do not treat those directories as source of truth when searching or editing. They may contain stale copies of repo files.
- If Redis env vars (`REDIS_URL` or `REDIS_HOST`/`REDIS_PORT`) are absent, `TaskQueue` uses the in-memory execution path. With Redis, BullMQ uses the `agent-factory-tasks` queue.
- Model runtime configuration comes from `AGENT_FACTORY_BASE_URL`, `AGENT_FACTORY_API_KEY`, and `AGENT_FACTORY_MODEL`; `ANTHROPIC_API_KEY` is used only as an optional fallback API key.
- The server exposes supervisor mode at `/api/supervisor/*`; `IntentClassifier` first uses keyword rules, then a simple fallback classifier.
