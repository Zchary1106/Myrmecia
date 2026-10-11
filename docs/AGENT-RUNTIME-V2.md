# Agent Runtime V2

Implementation specification: `plan/refactor-agent-runtime-v2.md`.
Execution checkpoint: `artifacts/agent-runtime-v2/progress.md`.

## Agent governance delivery — 2026-10-11

The separate `plan/feature-agent-governance-v2.md` adds recoverable setup drafts,
explicit Agent contracts, full immutable configuration versions, saved evaluation
suites, scoped knowledge/citations, editable budgets and inline debugging to the
existing runtime. These are not a replacement framework.

Budget enforcement intersects task, Agent and workspace policies. Turns, elapsed
time, tokens, tool calls and concurrency are bounded server-side; concurrent
reservations cannot both spend the same allowance. Model output limits shrink to
the available budget rather than allocating the whole quota to output and leaving
no input context. Dispatched requests with missing usage retain conservative
reservations. Resume, refresh and response replay do not grant fresh quota.
Configured pricing yields estimated USD admission bounds, not a guarantee about
the vendor invoice. Unknown/unpriced or subscription requests cannot pass an
explicit hard USD policy. Provider-owned or external loops that cannot enforce
configured host limits fail before dispatch.

Task limits/config versions remain pinned. Agent aggregate quota edits take effect
for subsequent dispatches immediately; changing a published reusable run
configuration requires publication. Budget updates use expected revision.
Refreshing usage preserves unsaved edits and detects intervening policy changes.

`GET /tasks/:id/controls` supplies authoritative per-operation capabilities.
Inline pause stays requested until a stable checkpoint; unsafe model/write
outcomes require reconciliation. Confirmed reruns and completed follow-ups create
fresh task IDs with stable response-loss keys and durable attempt history.
Active follow-up is queued only where supported. In-memory queue wakeup occurs
after the previous admission is released, closing the completion-event race that
could leave a materialized follow-up queued forever.

Verification separates these gates:

- Server regression: **1026 passed, 5 opt-in skipped** across 148 passed files
  and one skipped file, 80.84 seconds.
- Dashboard regression: **223 passed** across 18 files, 1.53 seconds.
  Isolated browser suite: **7 passed**, 1.9 minutes. Detailed logs and scenarios
  are recorded in the governance plan.
- Shared/server/dashboard builds, contract validation and Pipeline validation
  passed. Contract validation retains **28 inferred legacy-contract warnings**.
- Browser acceptance uses isolated API **3350** / web **5350**, a temporary
  SQLite database and workspaces outside the repository. Only model transport is
  scripted; HTTP, runtime, queue, persistence, evidence and UI are real. This
  does not prove real-provider/MCP availability or semantic business quality.
- Dedicated Redis restart assertions now cover job identity, pinned config,
  saved evaluation result, budget receipt and ownership fence after DB reopen.
  They remain **unverified here**: Docker's daemon is unavailable. The five
  skipped opt-in tests are not a restart pass.
- No live provider/MCP request, credential/login change, normal-service restart,
  runtime-default rollout, database switch, packaging, commit/push or PR action
  was performed for this delivery.

SQLite remains the supported application backend. The experimental PostgreSQL
adapter still requires the separately proposed async/transaction/outbox migration
in `plan/refactor-postgres-compatibility-v1.md`; that proposal is not implemented.

## Current implementation and rollout boundary

Myrmecia uses its own TypeScript runtime for all built-in Agents. Registered
runtime extensions retain precedence over the built-in fallback. The obsolete
Python/CrewAI runtime has been removed from the approved host working tree;
this does not uninstall system Python or remove independent utilities.

The current runtime has real execution state, messages, tool records, usage,
artifacts, middleware, MCP governance, human acceptance, and conservative
read-only checkpoints. V2 is a staged strengthening, not a claim that these
features are absent.

| Boundary | Compatibility path | Implemented V2 |
| --- | --- | --- |
| Agent loop | Business and model/tool loop share `TsAgentLoop` | Thin injectable Core, business governance in Harness |
| OpenAI-compatible | Host owns model/tool iterations | Normalized events and host-loop metrics |
| GitHub Copilot | Official SDK owns internal tool iterations | Capability-aware events, truthful internal-turn metrics |
| Context | Clean-turn compaction; separate budget helper | Protected facts and budget helper in actual request preparation |
| History | DB records plus mutable request messages/checkpoints | Canonical append-only session events and pure projections |
| Follow-up | Persistent messages drained before host request | Durable claim/apply/ack; steer vs queued follow-up |
| Tools | Governed sequential dispatch | Bounded trusted reads and exclusive unknown/write barriers |
| Recovery | Stable read-only checkpoints; unknown writes blocked | Durable ownership/fencing, session identity and budget continuity |
| Sandbox | Host policy/path/command checks | Explicit host-policy capabilities and optional isolated backend |
| Completion | Output integrity and separate user acceptance | Criterion-linked outcome verification, then user acceptance |

## Compatibility contract

- Keep current Agent/Skill/Domain/Team/Workflow abstractions, workspace
  isolation, approvals, allowed tools, MCP, DLP, write-once journal and terminal
  state fencing.
- Preserve one conversation composer, Markdown/streaming, knowledge
  attachments, session history, archive/delete rules and artifact links.
- SDK authentication remains the existing local Copilot sign-in. No credential
  is transferred to dashboard clients and no provider/account switch is implied.
- One Copilot `sendAndWait` is not one internal model turn. Unknown metrics,
  cost, resume and steering capabilities remain explicitly unknown/unavailable.
- No hidden reasoning is stored or displayed. Only observable output and safe
  operational events can enter the conversation.
- Tests may simulate model and MCP transports, but must execute the production
  entry points. Offline fixtures are not proof of live integrations.
- Additive migrations preserve old history. Unknown external writes cannot be
  replayed to make a recovery test pass.

## Control Plane overlap

The existing control-plane contract is not rewritten or marked complete.
Runtime V2 uses the same authorities instead of constructing a second plane.

| Existing criterion | Runtime V2 responsibility |
| --- | --- |
| AC01 / AC02 / AC03 | Shared runtime capabilities, provider/external session boundaries, governed dispatch |
| AC04 / AC05 | Shared durable ownership, wakeups, fencing and side-effect-aware recovery |
| AC06 / AC07 | Shared persistent scoped budgets and honest idempotent accounting |
| AC08 | Existing workbench, main composer, visible identity/status and artifacts |
| AC09 / AC10 | Projects/Goals/Routines remain in the original epic, not this loop refactor |
| AC11 / AC12 | Regression evidence and documented limitations; original epic still needs all its criteria |

The legacy AC01 reference to TS/Python requires an explicitly approved future
contract revision after CrewAI removal; historical task records remain intact.

## Verification status

Phase 0 baseline was rerun on 2026-10-07: 805 server tests passed, one skipped;
157 dashboard tests passed; shared/server/dashboard builds, desktop typecheck
and contract/pipeline/social-workflow checks passed. Contract validation still
reports 28 inferred legacy contracts.

These numbers are a baseline snapshot, not a guarantee for future phases.
Stage implementation, fixture tests, live browser/backend, live Provider/MCP,
isolated Redis, sandbox enforcement, remote CI, push and merge are independent
verification states. No packaging or publication is authorized by this plan.

## Phase 1 integration and compatibility switch

The shared runtime protocol, `ProviderDriver` and thin `agents/core` modules
are implemented. Both ordinary TS and structured Skill turn bounds now run
through the Core's governed-turn adapter. Business policy, database, tracing,
research and tool execution remain Harness-owned; extracting the Core is not
a claim that all business/tool branches have been removed from `TsAgentLoop`.

`MYRMECIA_RUNTIME_V2=true` enables normalized request preparation for the
ordinary, Skill and Skill-summary paths. Its initial default is disabled
until later-phase acceptance. `false` retains the legacy gateway projection
with the corrected late-result cancellation checks. Both modes keep the same
official Provider authentication.

The compatibility adapter is intentional: the standalone Core has injectable
request/context/tool hooks and a normalized model/tool loop, while the
existing Harness owns its business turn bodies. Further phases connect
context/session authority and the shared safe scheduler without bypassing
those existing policy checks.

When V2 is enabled, execution `runState.metrics` separates host request count
from observable model turns; SDK-owned internal turn counts remain `null`.
Unknown usage/cost is not displayed as an observed zero.

## Phase 2 context integration

V2 ordinary, Skill-step and Skill-summary requests all use
`buildRequestContext` / `buildContextBudgetPlan`, including the Core's context
transformation boundary. Model context-window size is independent of the
whole-task token allowance. Both are bounded, and schema overhead plus reply
reserve count before dispatch.

Approved task facts and user instructions are protected. Compaction summaries
carry provenance/versioned facts and bounded tool evidence; small historical
tool results also receive full durable artifacts before leaving the prompt.
File activity is recorded only from completed governed tool executions.
Failure records remain historical data, not new user/system instructions.
Generated context carries internal provenance that is stripped before the
Provider request and prevents recursively duplicated constraint summaries.

A 50-turn actual TS-loop fixture with real local read tools, mocked model
transport and an in-flight mailbox instruction verifies repeated compaction
without losing constraints. This is offline integration evidence, not a live
model benchmark. Phase-2 full checks: server 842 passed / 1 skipped,
dashboard 157 passed; builds/typecheck/contract/pipeline checks all passed.

## Phase 3: canonical sessions and durable instructions

The append-only `agent_session_events` journal has scoped sequence allocation,
immutable retry keys, DLP/size guards and pure projections. V2 dispatch reads
its persisted request envelope. Stable recovery rehydrates messages from
canonical checkpoint events, not mutable compatibility buffers. Replay does
not execute tools; the public projection excludes system messages and tuning.

Inbox states are `pending → claimed → applied → acknowledged`. Applied means
included in a persisted request, not observed model delivery. An assistant,
tool or usage event supplies the receipt. A dispatched request with no receipt
remains uncertain. Steering arriving during the final request receives an
explicit rejection when the execution settles.

Queued follow-up does not modify the current request. Successful completion
atomically materializes one same-session task; its first actual request
confirms receipt. Failure/cancellation rejects unscheduled follow-up promptly.
The same main composer supports both modes, preserves retry keys, displays
delivery status and deduplicates canonical/legacy turns.

Streaming scans accumulated text instead of independent transport chunks.
An unfinished token and 128-character tail protect the current bounded
multi-token DLP patterns; cancellation does not flush the tail. This is not a
guarantee for arbitrary future custom patterns or a hidden-reasoning stream.

## Phase 4: governed scheduling

Trusted source-controlled builtin metadata and the Xiaohongshu read allowlist
permit bounded reads. Default concurrency is 1; explicit trusted reads may
use 1–4. Writes/unknown effects are exclusive barriers. Permissions and
classification are rechecked at dispatch; quota is reserved before concurrent
calls. Model context retains original call order; activity retains actual
start/finish order.

SQLite resource locks also coordinate different executions/processes.
Overlapping resource keys and one MCP server serialize. Waits support timeout
and cancellation. Unknown writes remain sealed. Scoped operator reconciliation
releases reviewed locks but does not replay an operation. SDK-native internal
batches cannot be controlled by this host scheduler.

## Phase 5: ownership, budgets and bounded continuation

Ownership has 60-second leases, 20-second heartbeats and monotonic fencing
tokens. Runtime writes carry their original async owner scope. An expired
worker cannot commit late output or clear another worker's abort controller.
The first-start timestamp retains the cumulative task clock. Recovery skips
live owners and retains existing Redis job IDs instead of duplicating work.

Persistent workspace/Agent/task policies use UTC daily or task-lifetime
periods. Reservations and delta/cumulative receipts deduplicate. Unknown
usage retains conservative allowance; unknown USD cost is null. A hard USD
cap cannot approve unpriced usage. Subscription defaults use non-USD limits;
an explicitly configured hard USD cap is not subscription-exempt. A cache
hit records zero *new* model usage, not another charge for historical usage.

`MYRMECIA_BOUNDED_CONTINUATION=true` opts into slices no longer than 600,000 ms.
`MYRMECIA_RUNTIME_SLICE_MS` can shorten a slice; the cumulative limit still
applies. Stable ordinary read-only tool turns and completed read-only Skill
steps can persist wakeups for the existing queue. Skills with validation
commands are not automatically resumed because those commands may mutate
their workspace. In-flight request checkpoints and pending/unclean SDK
sessions require reconciliation, not fresh automatic replay.

The installed Copilot SDK 1.0.9 exposes `resumeSession`. Session identity
includes workspace/conversation/Agent/model/system/config/tools. Resume
sets `continuePendingWork: false` and custom-only tools; a reference is stable
only after confirmed cleanup. This sends a recorded host envelope to a reused
SDK session, not an exact reconstruction/deduplication of private SDK turns.
Follow-up real acceptance proved settled read-only SDK continuity across two
separate OS processes using the existing account: the second request contained
no nonce/history and the resumed SDK returned the exact prior synthetic nonce.
This does not verify unknown in-flight request replay or all resume configurations.
Evidence: `artifacts/agent-runtime-v2/live-integration-verification.md`.

## Phase 6: explicit execution worlds

`MYRMECIA_EXECUTION_WORLD=host_policy` remains the compatibility default:
no filesystem, process, network or credential isolation. `EXECUTOR_MODE=docker`
by itself does not change the TS tool world.

`docker_isolated` requires an available Docker daemon and preinstalled image
(`MYRMECIA_WORLD_IMAGE`, default `node:22-alpine`); it performs no pulls,
installation or daemon startup. Supported local tools are `file_read`,
`file_write` and `shell_exec`. They use a non-root user, read-only rootfs,
network none, dropped capabilities, no-new-privileges, CPU/memory/PID limits
and bounded tmpfs. Input reaches fixed worker source through stdin. Cancellation
removes only the exact generated container.

Unsupported tools, host plugins and structured Skill host-shell validation
fail closed. There is no automatic host fallback. External MCP requires
`MYRMECIA_ALLOW_EXTERNAL_MCP=true` and is still outside container isolation.
External CLI/HTTP Agent internals are not isolated by this setting. Real
enforcement was tested on this macOS host's Colima Docker context; other
platform/daemon combinations are not certified by those results.

## Phase 7: evidence-linked completion

Criteria are submitted at task creation and cannot be weakened by an executor:

- `artifact`: indexed scoped bytes and optional submitted SHA-256.
- `output_contains`: a literal assertion, not general external outcome proof.
- `test_command`: bounded operator-submitted `pnpm test`, `pnpm build` or
  `npm test`, with write journal/resource/budget governance and hashed output.
- `external`: unavailable unless the verifier is registered.

Mandatory failed/unavailable evidence blocks success while preserving partial
output. Graph workflow and external result/callback paths enforce the same
gate. Callback receipts bind immutable input before verifier dispatch, so a
retry does not rerun commands or undo a locally rejected remote success.
A crash during callback verification remains uncertain and requires review.

Human acceptance remains independent. It rechecks freshness but does not
rerun verifier commands. Modified artifacts cannot reuse an old pass.
Ordinary chat without criteria reports outcome `not_requested`.

## Repeatable validation and reports

Run from the repository root:

```sh
node scripts/verify-runtime-v2.mjs final
pnpm --filter @myrmecia/server exec tsx scripts/runtime-benchmark.ts --mode=fixture
RUNTIME_V2_REAL_BACKEND=true pnpm --filter @myrmecia/dashboard exec playwright test --config playwright.runtime-v2.config.ts
MYRMECIA_TEST_DOCKER=true pnpm --filter @myrmecia/server exec vitest run tests/execution-world.test.ts
```

The 12-category fixture report is an assertion-backed regression matrix,
not a live model task-success rate. Unaggregated model metrics and cost are
null. The dedicated browser suite uses real HTTP/SQLite/Core/queue/UI and only
scripts model transport. The general dashboard route-mock E2E suite remains
a rendering contract, not a live service result.

Redis tests require `MYRMECIA_REDIS_RECOVERY_TEST=true` and a dedicated loopback
instance. The local labelled fixture uses port 6388; identity checks precede
destructive queue cleanup. Its separate restart scenario really restarts
that disposable Redis, not a user's queue.

Optional live smoke uses an already configured account/provider, only synthetic
read-only inputs, and requires explicit opt-in:

```sh
MYRMECIA_RUNTIME_BENCHMARK_LIVE=true pnpm --filter @myrmecia/server exec tsx scripts/runtime-benchmark.ts --mode=live --model=<existing-model-id>
```

This separate two-case smoke cannot establish full MCP, resume/recovery or
12-category live performance. Both read-only cases passed with the existing
Copilot / claude-haiku-4.5 configuration; SDK internal turns and subscription
USD cost remain unknown/null. Final reports/screenshots
and explicit gaps are in `artifacts/agent-runtime-v2/verification.md`.
Additional opt-in real-integration acceptance uses
`scripts/runtime-live-integrations.ts` with
`MYRMECIA_RUNTIME_LIVE_INTEGRATIONS=true`, an isolated absolute `--root` under
`artifacts/agent-runtime-v2`, and `--case=sdk-seed` then `--case=sdk-resume`
in different processes. `--case=xhs` exercises the real model/runtime/MCP
read-only chain; npx configurations require `--bridge` to the existing
package's `mcp-remote` stdio proxy, never its diagnostic client or a new install.
`--case=xhs-probe` is a single direct transport diagnostic, not a model retry.
`--case=xhs-evidence` inspects a prior durable result without new live calls.
The initial actual Xiaohongshu search failed at its own deadline. An authorized
local connector repair and structured tool-evidence envelope now pass one
actual search plus original-title/source-link matching and browser rendering;
detail reads/all filters/full live matrix remain separate unverified gates.
See `docs/XIAOHONGSHU-MCP-SEARCH-REPAIR.md` and
`artifacts/agent-runtime-v2/xhs-connector-repair-verification.md`.
V2 remains opt-in: local acceptance does not migrate a production DB, switch
accounts, publish content, package, push, merge or deploy.
# User pause and plan reconciliation (2026-10-10)

User pause is a durable scheduling hold in `runtime_pause_controls`, independent
of Task outcome and manual approval gates. The Task/Pipeline API exposes
`pauseControl.state` (`requested` or `paused`). A requested pause waits for a
complete model/tool turn; it does not kill an in-flight process or roll back a
remote action. Queues withhold held tasks and descendants, including descendants
created after the request, and keep them held after restart.

The chat header, Workflow controls and orchestration board expose pause/resume.
Supported built-in TS runs retain their turn checkpoint, messages, model/tool
fingerprint, cumulative tokens and elapsed execution time. Resume requeues the
same Task with a new execution attempt and reads the confirmed checkpoint; it
does not claim to revive the previous OS process.

Boundaries:

- Automatic continuation remains **read-only**. Recorded writes, unknown
  effects, incomplete requests, missing checkpoints, changed model/tool/prompt
  fingerprints or damaged canonical journal references fail closed.
- Pause takes effect at a **complete turn boundary**, not between every
  individual tool in an already-started turn. SDK-owned internal loops remain
  opaque while their current provider call is pending.
- External/non-TS runtimes without a verified checkpoint capability reject
  pause. Structured Skills only yield at their existing eligible checkpoints;
  validation-bearing steps may finish before a checkpoint is available.
- User resume is not content/publication approval. Manual gates remain in
  their prior state and require their existing approval flow.
- Graph and dynamic Workflow runtime cancellation APIs are unchanged; these
  are not claimed to support the new user-pause lifecycle.

Pipeline orchestration now stores `pipeline_id` before asynchronous stage
creation, attaches later tasks through the actual event envelope, and derives
its state from the persisted owner. Startup reconciliation labels historical
ownerless running plans as an unknown-outcome failure requiring review; it
does not guess ownership by name or manufacture successful output.

Verification is fixture-based: real TS loops in legacy/V2 modes, actual file
reads and retained observations, isolated SQLite reopen/recovery, real loopback
HTTP authorization/control routes, and React pause/resume/error interactions.
These checks are separate from real provider/MCP, dedicated Redis and browser
visual acceptance.

## Execution-directory lifecycle integration

Workspace lifecycle is an additive control-plane feature shared by legacy and
V2 callers; it does not enable Runtime V2 globally. Task source selection produces
a persistent filesystem binding. Follow-ups and delegated tasks inherit it;
canonical/overlapping shared writers serialize through durable fenced leases.

Pause/resume verifies the recorded Git baseline and artifact integrity. Unknown
external effects retain uncertain claims until an operator stops/settles tasks
and confirms a fresh reconciliation manifest. This is not process resurrection,
automatic lock stealing or exactly-once remote writes.

Result/changed-file snapshots precede success and evidence verification. Waiting
for user input and failed/cancelled output retain explicitly partial evidence.
Tool output, compaction summary versions and pipeline envelopes are immutable too.
Completion does not authorize a commit/merge/deletion; directory archive/purge and
reviewed file-patch application are separate operations.

`shared_readonly` denies writes, Shell/MCP and opaque provider loops. The displayed
server directory is not a proof of an external provider's actual working directory
or an OS sandbox. See [Workspace lifecycle](WORKSPACE-LIFECYCLE.md) and the
workspace delivery report under `artifacts/workspace-lifecycle/`.
