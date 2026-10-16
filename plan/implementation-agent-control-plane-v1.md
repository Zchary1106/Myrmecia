# Myrmecia Agent Control Plane V1

Date: 2026-10-07 (Asia/Shanghai)
Base: ee30d76f4520035655d95e1ecdb516541622a74f
WorkAgent task: myrmecia-agent-control-plane-v1-20261007

## User-authorized objective

Implement the five improvements accepted after the Paperclip source comparison:

1. A shared execution contract for built-in and external Agents.
2. Durable ownership, wakeups, waiting states, and bounded recovery.
3. Persistent, scoped budget enforcement.
4. A unified conversation/task/run/artifact/acceptance workbench.
5. Governed Routines and lightweight Projects/Goals.

Borrow architectural patterns, not Paperclip's branding or entire company model.
Preserve Myrmecia's existing Agent/Skill/Domain/Team abstractions, chat, streaming
Markdown, knowledge attachments, memory, workflow approvals, and acceptance.

## Context Map

### Files to Modify

| Path | Purpose | Intended change |
| --- | --- | --- |
| `packages/shared/src/` | Shared API and runtime types | Add versioned capabilities, events, ownership/wakeup, budget, routine/project/goal contracts without breaking existing types |
| `packages/server/src/agents/runtime-adapter.ts` | Built-in runtime adapter boundary | Normalize execution metadata and declare supported capabilities |
| `packages/server/src/agents/external-agent-adapters.ts` | Local CLI and HTTP transports | Structured events, separate diagnostic output, honest usage, supported session continuation and cancellation |
| `packages/server/src/agents/external-agent-runtime.ts` | External task/run lifecycle | Consume the common contract, enforce governance, fence late results, connect compatible workflow/team dispatch |
| `packages/server/src/agents/agent-runtime.ts` | Built-in execution lifecycle | Connect the shared event/accounting/ownership boundary |
| `packages/server/src/agents/run-state.ts` | Execution phase state machine | Preserve monotonic settled states and distinguish waiting, stopping, completion, and acceptance |
| `packages/server/src/agents/safety-guardrails.ts` | Current process-local budget guard | Replace cost enforcement counters with durable scoped policy/accounting |
| `packages/server/src/queue/task-queue.ts` | Queue dispatch and recovery | Integrate durable wakeups, claims, leases and bounded replay |
| `packages/server/src/agents/team-coordinator.ts` | Team orchestration | Preserve roles/dependencies and use governed execution ownership |
| `packages/server/src/agents/graph-workflow.ts` | Visual workflow execution and approval | Integrate supported external executors through the common boundary; retain approval gates |
| `packages/server/src/workers/external-agent-scheduler.ts` | External scheduled/event work | Common routine/wakeup dispatch with overlap and missed-run policies |
| `packages/server/src/db/database.ts`, `packages/server/src/db/schema.sql`, `packages/server/src/db/models/` | SQLite migrations and records | Additive durable ownership/wakeup/budget/project/goal/routine data |
| `packages/server/src/routes/`, `packages/server/src/index.ts` | APIs and startup wiring | Tenant-scoped APIs, worker recovery and read models |
| `packages/dashboard/src/lib/api.ts`, `packages/dashboard/src/stores/` | Client transport and state | Typed common execution/routine/project/goal data |
| `packages/dashboard/src/components/session/TaskSession.tsx` | Main conversation/workbench | Clear owner/runtime/model/status/waiting reason, folded tool events, artifacts and acceptance without a second composer |
| `packages/dashboard/src/components/agents/ExternalAgentsPanel.tsx` | External Agent setup | Capability and environment diagnostics; avoid promises a runtime cannot satisfy |
| `packages/dashboard/src/pages/`, related home/navigation components | Workspace/routine/project/goal surfaces | Incremental integrated management, explicit loading/empty/unavailable states |
| `README.md` | Product documentation | Document shipped functionality, limits and verification separately |

### Dependencies

- Preserve shared contract compatibility, API authentication/roles and workspace scope.
- Existing execution ledger/audit, event bus, conversation lineage, artifacts,
  tool policy, secrets, cancellation and acceptance gates remain authoritative.
- Do not substitute raw CLI stdout or process exit code for task acceptance.
- Preserve the Redis queue path and SQLite local path; PostgreSQL remains
  experimental and is not part of this upgrade.
- Prefer current dependencies; do not introduce new runtimes or a new UI framework.

### Test Files

| Existing tests | Coverage to retain/extend |
| --- | --- |
| `packages/server/tests/agent-runtime-contract.test.ts`, `agent-run-state.test.ts`, `ts-agent-loop-completion.test.ts` | Runtime selection, transitions and final-output semantics |
| `packages/server/tests/external-agent-adapters.test.ts`, `external-agent-runtime.test.ts`, `external-agent-routes.test.ts` | CLI/HTTP execution, callbacks, cancellation, workspace checks |
| `packages/server/tests/task-queue.test.ts`, `task-queue.redis.test.ts` | Queue ownership, cancellation and restart recovery |
| `packages/server/tests/external-agent-scheduler.test.ts`, `external-agent-model.test.ts` | Schedule claims, events and lifecycle |
| `packages/server/tests/copilot-budget.test.ts`, `research-budget.test.ts`, related new budget tests | Accounting distinctions, enforcement and limits |
| `packages/server/tests/graph-workflow.test.ts`, `team-registry.test.ts`, `execution-acceptance.test.ts` | Workflow gates, team execution and human review |
| `packages/server/tests/conversations.test.ts`, `execution-artifacts.test.ts` | Conversation identity, real outputs and deliverable links |
| `packages/dashboard/tests/` and existing E2E suite | Composer continuity, status/owner visibility, tool disclosure, unavailable states and management CRUD |

### Reference Patterns

- Existing `run-state.ts` terminal-state fencing and `loop-checkpoint.ts`
  side-effect-aware recovery.
- Existing schedule claims and execution acceptance idempotency.
- Existing artifact indexing, structured cost types and workspace-aware routes.
- Paperclip reference snapshot `99a9de9940bf5974352d9dbfbb2f21e62e89689f`:
  adapter capabilities/session codecs, issue checkout, DB wakeups, scoped budgets,
  routine overlap/catch-up policies. This is a reference, not a dependency.

### Risk Assessment

- Public API compatibility: keep old fields/endpoints or provide explicit compatible adapters.
- Database migrations: additive and idempotent; test old data without deleting it.
- Configuration: retain defaults; optional external runtime capabilities must be probed.
- Side effects: tests use fixtures/fake transports and isolated temporary databases.
- UI: preserve current navigation and composer; avoid duplicated status panels.

The main-agent source review identified these boundaries before implementation.
WorkAgent must inspect the paths and review the executable plan before source edits.

## Implementation sequence

### P0-A — Common runtime contract

Define capabilities rather than assuming all runtimes support resume, streaming,
cancellation, usage reporting or tools. Normalize assistant text, diagnostic
output, tool lifecycle, state changes, usage and artifact events. Implement
bounded parsing for the supported CLI profiles; preserve a generic fallback.
Persist conversation/session references only for genuinely supported runtimes.
Route supported Team/Workflow work through the governed runtime, not a bypass.

### P0-B — Durable coordination

Persist wakeups and execution ownership with idempotency keys, lease/fencing
identity, coalescing and explicit waiting reasons. Claim before dispatch.
Recover safely after process loss; never blindly replay external writes.
Prevent concurrent duplicate work and late-result overwrite after cancellation.

### P0-C — Budget ledger

Persist policies and cost records scoped to workspace/Agent/project where
applicable. Restore enforcement after restart, check before dispatch and account
incrementally when supported. Keep exact, estimated, subscription and unknown
cost distinct. Do not record unavailable cost as zero. Make thresholds and
blocked reasons observable; acknowledge delayed/in-flight accounting limits.

### P1-A — Unified workbench

Use the existing conversation composer. Show responsible Agent, runtime/model,
current state and why a task is queued, waiting, blocked or stopped. Keep tool
calls collapsed by default; live updates modify their existing card. Group
artifacts and explicit accept/reject/revise actions with the relevant run.
Provide meaningful loading, empty, disconnected and retry states.
Preserve Markdown, streaming, follow-up context and attachments.

### P1-B — Routines and lightweight Projects/Goals

Add tenant-scoped Project and Goal records and link them to tasks/runs/routines.
Add governed routine definitions and append-only revisions, execution history,
cron/once/API/existing event triggers, overlap choices (coalesce/skip/enqueue),
and capped missed-run handling. Keep existing schedules compatible.
Every dispatched routine should lead to a tracked task/run with a known owner.
Do not add an unnecessary CEO/CTO/company hierarchy.

## Verification and delivery

Use isolated test data. Capture command, cwd, exit status and useful output.
Build shared, server and dashboard; run server/dashboard unit and integration
regressions and the relevant E2E scenario. Treat source/build, fixture tests,
real browser rendering, live external integration and remote CI as separate
verification states.

Do not claim real CLI/HTTP provider integration from fixtures. Do not claim
completion without persisted evidence for all mandatory criteria. If a runtime
requires credentials or capabilities not available locally, report that precise
boundary instead of inventing success or changing providers.

No push, PR, merge, release packaging, credential changes, database reset,
unrelated cleanup or modification of WorkAgent's own repository is authorized.
Keep `.workagent/`, `artifacts/`, `.env`, cookies and runtime databases local.
