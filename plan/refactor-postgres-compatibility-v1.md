---
goal: Migrate the synchronous SQLite application to explicitly tested PostgreSQL compatibility
version: 1.0
date_created: 2026-10-11
last_updated: 2026-10-11
owner: Myrmecia
status: Planned
tags: [refactor, database, postgres, transaction, migration]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This is a separate proposal, not an implemented database migration. The supported
application path is `getDb()` and synchronous SQLite. The experimental
`getAsyncDb()` PostgreSQL adapter does not make routes, runtime or recovery
PostgreSQL-compatible. No database URL, dependency, data or service is changed by
this document. Implementation requires a separate approval.

## 1. Requirements & Constraints

- **REQ-001**: Preserve workspace authorization, stable task IDs, published configuration hashes, manifests, receipts, checkpoints and migrations on both backends.
- **REQ-002**: Pass the same scoped HTTP, runtime and recovery contract tests against SQLite and PostgreSQL; a connection test alone is insufficient.
- **SEC-001**: Resolve workspace/actor before SQL reads and writes. Do not use the migration to weaken permission checks or export credentials.
- **CON-001**: Do not configure PostgreSQL on the normal application until the parity and rollback gates pass. Do not delete the original SQLite database.
- **CON-002**: No transaction may span a model/tool/network request. Commit an outbox or dispatch reservation before external work, then fenced settlement after it.
- **PAT-001**: Introduce a transaction-scoped async repository context; all nested model operations must use the same connection rather than a global pool.

Read-only inventory on 2026-10-11 found `getDb()` calls in 34 files under
`packages/server/src/db/models` and nine files under `packages/server/src/routes`.
Runtime, tools, auth, knowledge and memory also call it directly. These counts
are a starting inventory, not the entire migration surface.

## 2. Implementation Steps

### Implementation Phase 1 — Driver and transaction contracts

- **GOAL-001**: Establish real backend parity before converting business callers.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add `packages/server/src/db/repository-context.ts` with `withTransaction(context, callback)` and nested same-connection context. Change `database.ts` async transaction handling to explicit savepoints; reject accidental global-client writes during a transaction. Test commit/rollback/nesting on each backend. | No | — |
| TASK-002 | Replace generic SQL substitution as a compatibility claim with explicit dialect migrations. Add `packages/server/src/db/migrations/postgres/`; map SQLite JSON/BLOB/DATETIME/PRAGMA/rowid/json_array_length/INSERT OR semantics to JSONB/BYTEA/TIMESTAMPTZ and native PG statements. Add migration ledger and old-schema upgrade tests. | No | — |
| TASK-003 | Add a scoped test-only PostgreSQL backend configuration and container identity guard. Default tests remain SQLite; refuse shared/non-loopback acceptance targets. No automatic installation/start of production PostgreSQL. | No | — |

### Implementation Phase 2 — Durable repositories

- **GOAL-002**: Convert state authority without widening race windows. Depends on GOAL-001.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Convert `db/models/task.ts`, `execution.ts`, `execution-context.ts`, `agent.ts`, `agent-config-version.ts`, `agent-setup-draft.ts`, `agent-evaluation.ts`, `agent-knowledge.ts`, auth and memory repositories to awaited operations. Pass the same transaction context through authorization, content hashing and inserts. Keep domain-specific scoped lookups. | No | — |
| TASK-005 | Convert `db/models/run-ownership.ts`, `agent-inbox.ts`, `agents/budget-service.ts`, `tools/write-once.ts` and `tool-resource-lock.ts`. Use row locking plus unique keys and compare-and-swap fencing; assert one claim/reservation/inbox materialization under concurrent independent processes. Do not emulate SQLite's single writer with unfenced async read-then-write. | No | — |
| TASK-006 | Keep immutable config/source/manifest integrity hashes content-derived. SQL JSON serialization must not change the canonical application hash. Test old revision equality and byte/locator citation checks after export/import. | No | — |

### Implementation Phase 3 — Callers and reliable external dispatch

- **GOAL-003**: All application callers await transactions and durable dispatch. Depends on GOAL-002.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Convert `routes/agents.ts`, `tasks.ts`, `executions.ts`, budget/knowledge APIs, Team/Pipeline/Workflow callers, event listeners, `queue/task-queue.ts` and `agents/agent-runtime.ts` to async repositories. Trace every direct `getDb()` caller with `rg`; no unawaited Promise may determine permission or state. | No | — |
| TASK-008 | Add transaction-backed dispatch outbox and idempotent queue publication, including setup tests, evaluation cases, rerun and follow-up. A crash after task commit but before BullMQ publication must dispatch the same task once, not recreate it. Publish realtime events only after commit. | No | — |
| TASK-009 | Convert checkpoints/session harness/knowledge retrieval and completion verification; avoid holding DB transactions while parsing files or calling models/tools. Revalidate permission at dispatch/output/citation boundaries after async reads. Guard stale control events and cancel/completion races. | No | — |

### Implementation Phase 4 — Migration acceptance and rollout

- **GOAL-004**: Prove parity and recoverable data transition before changing defaults. Depends on GOAL-003.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | Execute full server tests, isolated browser tests and dedicated Redis recovery on both backends. Add two-process races for run ownership, Agent concurrency, quotas, drafts and suite advance. Record skips and failures separately. | No | — |
| TASK-011 | Export a task-owned seeded SQLite database, import to a task-owned PostgreSQL instance, and compare row counts, scoped IDs, canonical hashes, receipts, citations and runtime recovery. Document paused/unresolved external work as reconciliation-required, not replayable. | No | — |
| TASK-012 | Publish a backup/checksum/cutover/rollback procedure. Initial rollout is opt-in with no dual writes; stop dispatch before copying state. Retain read-only original SQLite and verify restore before any separately authorized normal-service switch. | No | — |

## 3. Alternatives

- **ALT-001**: Setting `DATABASE_URL` or installing `pg` without converting callers is rejected; `getDb()` currently rejects that configuration.
- **ALT-002**: A generic SQLite-to-PG SQL string replacement is rejected for migrations, locking, JSON functions and transaction semantics.
- **ALT-003**: Dual writes during migration are rejected in the first rollout because divergent receipts/ownership can duplicate external actions.

## 4. Dependencies

- **DEP-001**: Approval of this proposal, task-owned PG test resources and an explicit data-transition window.
- **DEP-002**: Existing run fences, reservation receipts, immutable config/source hashes and fixture HTTP/browser test infrastructure.

## 5. Files

- **FILE-001**: `packages/server/src/db/database.ts`, new repository context/dialect migrations and all direct synchronous callers.
- **FILE-002**: Model, runtime, auth, queue, tools, memory and knowledge tests; isolated browser and dedicated Redis suites.
- **FILE-003**: `README.md`, `docs/ARCHITECTURE.md`, `docs/AGENT-RUNTIME-V2.md` and migration operations documentation.

## 6. Testing

- **TEST-001**: Concurrent independent-process transaction tests prove single claims, no budget overspend and no duplicated dispatch.
- **TEST-002**: Backend matrix proves equivalent scoped HTTP responses, paused recovery, version hashes, citations and completion freshness.
- **TEST-003**: Seeded import/export roundtrip and backup restore prove preserved IDs, bytes, revisions and receipts without model/tool calls.

## 7. Risks & Assumptions

- **RISK-001**: Async conversion changes previously synchronous event ordering; add post-commit event publication and outbox recovery.
- **RISK-002**: PostgreSQL row locks differ from SQLite writer serialization; every read-modify-write invariant requires an explicit lock/CAS test.
- **RISK-003**: Interrupted model/write-tool outcomes remain unknown even if database migration succeeds; never auto-replay them.
- **ASSUMPTION-001**: SQLite remains the supported application backend until this proposal is approved, implemented and independently verified.

## 8. Related Specifications / Further Reading

- `plan/feature-agent-governance-v2.md`: budget, knowledge, revisions and acceptance requirements.
- `packages/server/src/db/database.ts`: current synchronous boundary and experimental async adapter.
- `packages/server/src/db/models/run-ownership.ts`: fenced runtime writes.
- `packages/server/src/agents/budget-service.ts`: transactional reservations and receipt deduplication.
