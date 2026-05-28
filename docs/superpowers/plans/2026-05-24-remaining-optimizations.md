# Remaining Optimizations Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete remaining P1 and P2 optimization items from the architecture review.

**Architecture:** CLI package for quick entry, pure TS agent loop to replace Python CrewAI subprocess, OpenTelemetry export from existing trace spans, execution checkpoints for recovery, and per-tool parameter constraints.

**Tech Stack:** TypeScript, Commander.js (CLI), OpenTelemetry SDK, SQLite checkpoints

---

## P1 — Remaining

### Task 1: CLI Entry Point (`npx agent-factory`)

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/commands/run.ts`
- Create: `packages/cli/src/commands/status.ts`
- Modify: `pnpm-workspace.yaml` (add cli package)

**Goal:** `npx agent-factory run "Build a login page"` dispatches a task to the server and streams output.

- [ ] Scaffold `packages/cli` with commander.js
- [ ] `run` command: POST to `/api/v1/tasks`, connect WebSocket for streaming output
- [ ] `status` command: GET `/api/v1/tasks` and display table
- [ ] Add bin field to package.json for `agent-factory` command
- [ ] Test: `pnpm --filter @agent-factory/cli build && node packages/cli/dist/index.js --help`
- [ ] Commit

---

### Task 2: Python Worker Pool / Pure TS Agent Loop

**Files:**
- Create: `packages/server/src/agents/ts-agent-loop.ts`
- Modify: `packages/server/src/agents/agent-runtime.ts` (add TS execution path)
- Modify: `packages/server/package.json` (add `@anthropic-ai/sdk` if not present)

**Goal:** For agents that don't need CrewAI-specific tools, execute directly via Anthropic SDK in TypeScript — eliminates Python cold start (~2s per task).

- [ ] Implement `TsAgentLoop` class: builds messages, calls Anthropic SDK, handles tool use loop
- [ ] Add `AGENT_EXECUTOR=ts|crewai` env var (default: ts for agents without Python-only tools)
- [ ] Route selection logic in agent-runtime: use TS loop when agent's tools are all JS-native
- [ ] Tests: mock SDK, verify message construction and tool loop
- [ ] Commit

---

## P2 — Next Quarter

### Task 3: OpenTelemetry Integration

**Files:**
- Modify: `packages/server/src/observability/telemetry.ts` (replace no-ops with real SDK)
- Create: `packages/server/src/observability/otel-config.ts`
- Modify: `packages/server/package.json` (add `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`)

**Goal:** When `OTEL_ENABLED=true`, export real spans and metrics to any OTLP-compatible backend (Jaeger, Grafana Tempo, Datadog).

- [ ] Install OTel SDK packages
- [ ] Implement `initRealTelemetry()` that creates NodeTracerProvider + OTLPTraceExporter
- [ ] Map existing `run_traces` / `trace_spans` DB writes to also emit OTel spans
- [ ] Add metrics: `task.duration`, `agent.success_rate`, `queue.depth`, `llm_cache.hit_rate`
- [ ] Add `/metrics` endpoint (Prometheus format) for scraping
- [ ] Test: verify spans are exported when OTEL_ENABLED=true (mock exporter)
- [ ] Commit

---

### Task 4: Execution Checkpoint / Snapshot Recovery

**Files:**
- Create: `packages/server/src/pipelines/checkpoint.ts`
- Modify: `packages/server/src/pipelines/pipeline-engine.ts` (save/restore checkpoints)
- Modify: `packages/server/src/db/schema.sql` (add checkpoints table)

**Goal:** After each pipeline stage completes, save a checkpoint. On server restart or failure, resume from last checkpoint instead of re-running completed stages.

- [ ] Define checkpoint schema: `{ pipelineId, stageIndex, stageOutput, context, timestamp }`
- [ ] Save checkpoint after each stage completion in pipeline-engine
- [ ] On pipeline resume: load latest checkpoint, skip completed stages, continue from next
- [ ] Add `POST /api/v1/pipelines/:id/resume` endpoint
- [ ] Tests: simulate failure mid-pipeline, verify resume skips completed stages
- [ ] Commit

---

### Task 5: Per-Tool Parameter Constraints

**Files:**
- Modify: `packages/server/src/tools/tool-policy.ts`
- Modify: `packages/server/src/tools/tool-registry.ts`
- Create: `packages/server/src/tools/param-constraints.ts`

**Goal:** Tools can have parameter-level restrictions (e.g., `web.fetch` limited to specific domain whitelist, `image.generate_svg` limited output size).

- [ ] Define constraint types: `{ allowedDomains, maxLength, pattern, blockedValues }`
- [ ] Attach constraints to tool definitions in registry
- [ ] Validate tool call parameters against constraints before execution
- [ ] Return clear error when constraint is violated (which param, what's allowed)
- [ ] Tests: verify domain whitelist blocks disallowed URLs
- [ ] Commit

---

## Execution Notes

- Tasks 1-2 are independent and can be parallelized
- Task 3 depends on nothing but is best done after Task 2 (TS agent loop produces cleaner spans)
- Task 4 depends on pipeline-engine familiarity (loop-stage work is good context)
- Task 5 is standalone

Estimated total: ~4-6 hours of implementation across all 5 tasks.
