# Pause control and orchestration state repair

Date: 2026-10-10 (Asia/Shanghai)

## Delivery status and provenance

Implemented and verified locally in the current dirty working tree. All previous
changes were retained. The WorkAgent task `myrmecia-pause-control-20261010` was
registered under contract version 2 but failed without code or completion
evidence because its isolated committed baseline omitted local Runtime V2 work
and its tool-output session budget was exhausted. This document is a **local
implementation report**, not WorkAgent evidence or a Completion Guard approval.
The failed WorkAgent record was not rewritten.

## Context map and modifications

| Area | Files | Role |
|---|---|---|
| Durable controls | `packages/server/src/agents/pause-control.ts`, shared Task/Pipeline types and additive SQL migrations | Persist requested/paused holds independently of outcome and manual approval |
| Runtime and queue | TS loop, AgentRuntime, loop checkpoints, TaskQueue, MasterAgent, self-healing classification | Yield at complete turns, withhold descendants, continue compatible read-only checkpoints, preserve holds after restart |
| Plan ownership | Orchestrator and PipelineEngine | Link pipeline before asynchronous stage creation, collect later tasks, reconcile unknown orphan records without guessed ownership |
| API | Task, Pipeline and Supervisor routes; dashboard API client | Authorized scoped pause/resume; actionable unsupported/unsafe-boundary errors |
| UI | TaskSession, AgentRunStatus, OrchestrationBoard and Workflow controls | Pause/resume, actual requested/paused states, busy/error handling and separation from approval |
| Tests | Pause-control tests, runtime baseline tests and session interaction tests | Actual HTTP, real TS loops with transport fixtures, SQLite recovery and React interactions |

The existing ownership fences, task identity, user model selection, messages,
tool observations, budgets, approval and publication gates were retained.
Runtime V2 was not enabled globally and `.env` was not changed.

## Verification

- Full server regression: **952 passed, 5 opt-in tests skipped**, 142 test files
  passed and one opt-in file skipped; no failed tests.
- Full dashboard regression: **167 passed**, 13 test files passed.
- Additional affected-server verification: **91 passed** across eight files.
- Shared build, server typecheck/build, dashboard typecheck/build and
  `git diff --check` passed.
- Actual built-in TS loop exercised in both legacy and V2 modes: a completed file
  read is retained in the checkpoint, pause prevents the next model turn, and
  resume supplies the observation without re-reading the file.
- Actual loopback HTTP Task pause/resume and repeated pause requests passed;
  viewer access remains rejected with HTTP 403.
- SQLite reopen/recovery retains holds; interrupted unconfirmed pauses settle
  their dead running execution and require reconciliation.
- Changed fingerprints, recorded writes, unknown effects and unsupported
  runtimes fail closed.
- Manual approval hold remains manual approval after user resume.
- Actual asynchronous task event envelope populates pipeline-owned plan tasks;
  unknown historical ownerless running plans become a truthful unknown-outcome
  failure.
- The default Web service was started with `pnpm dev`. Dashboard HTTP 200 and
  API readiness were confirmed without dispatching a new live model/MCP task.
- The historical `orch_bb7ca404` now reports
  `ORCHESTRATION_OWNER_MISSING` after normal application startup reconciliation.
  No direct database status override or task deletion was used.

## Recovery backup

Before normal startup applied the additive migrations, SQLite's backup API
created an owner-private local recovery copy:

`artifacts/pause-control/pre-migration-20261010-73511f72-d343-46e0-a538-2cb1203954f8.sqlite`

This contains private runtime data and must not be committed or uploaded.

## Scope and remaining boundaries

- Cooperative pause occurs at a complete **model/tool turn**, not an arbitrary
  instruction boundary. Already-started turns and SDK-owned inner tool loops
  may continue until they settle or hit their existing timeout.
- Automatic resume is restricted to compatible, confirmed **read-only**
  checkpoints. A pause after writes/unknown effects requires explicit
  reconciliation. It is not cancellation followed by blind retry.
- Validation-bearing structured Skill steps only have the checkpoints already
  supported by their executor; no arbitrary mid-validation suspension is
  claimed.
- External/non-TS runtime pause is rejected without a verified capability.
  Graph and dynamic Workflow pause were not added.
- Dedicated Redis recovery, real authenticated model/MCP pause and browser
  visual acceptance were not run in this turn. The five opt-in skips are not
  passes for those environments.
- No commit, push, PR, merge, packaging or publication was performed.

## Follow-up: historical activity looked permanently running

The user's new screenshot was matched through read-only API queries to
`task_fa71974a` (`hello`) and its QA child `task_90aca95b`.
Both executions were already `done`; the overall task was `failed` because QA
returned null command/cwd/exitCode evidence. No execution was running on the
normal server. The progress message recorded a policy-blocked shell operation,
but its UI always rendered infinite thinking dots, including after completion.
This was a presentation/state-refresh defect, not a live pause failure on that
specific task. No historical outcome was changed or retried.

The bounded follow-up changes only TaskSession and its regression tests:

- A completed execution's progress message is labelled historical activity and
  has a static icon. A different running Agent cannot animate that old entry.
- A stopped partial stream retains its received content without a generation
  cursor or "Writing a response" badge.
- Empty completed conversations no longer show an infinite waiting animation.
- Pause/resume responses update Task/Pipeline state directly. They do not rely
  exclusively on a WebSocket notification or a subsequent global list reload.
- Active/user-held conversations refresh scoped task, execution and pipeline
  state every 2.5 seconds when visible, and refresh on focus. Failed refreshes
  show an explicit stale-state warning, not a false pause confirmation.
- In-flight REST snapshots cannot overwrite newer WebSocket/store updates;
  polling preserves partial replies when no complete answer was recorded.

No database, runtime policy, approval settings or credentials were changed.
Native browser interaction and live-provider pause acceptance remain unverified.

Follow-up verification: dashboard **176 passed / 13 files**; server pause-control
regression **14 passed**; dashboard typecheck/build and `git diff --check` passed.
Normal API readiness returned healthy, running-execution count was zero, and
Vite served the updated historical/activity/partial-stream labels with HTTP 200.
No commit, push or new real-model task was performed.
