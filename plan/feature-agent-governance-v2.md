---
goal: Complete Agent contracts, evaluation, knowledge scope, configuration versions, budgets, recoverable setup, and debug controls
version: 2.0
date_created: 2026-10-11
last_updated: 2026-10-11
owner: Myrmecia
status: In progress
tags: [feature, agents, runtime, governance, evaluation, dashboard]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In_progress-yellow)

Complete the seven Agent setup and governance gaps remaining after
`plan/feature-agent-setup-v1.md`. Existing contracts, completion gates,
session documents, Skill versions, budget accounting, and task controls are
reused; this is not a replacement runtime.

The user confirmed Phase 1 and continued the subsequent phases on 2026-10-11.
Phases 1–6 are locally implemented. Phase 7 local browser/documentation gates
passed; dedicated Redis restart and live-provider/MCP acceptance
remain unmet environment/authorization gates.
WorkAgent task-tool discovery returned no tools:
no durable WorkAgent task has been submitted and no task ID exists.
Implementation and deterministic/HTTP test evidence do not constitute live
model/MCP, browser, Redis restart, or production acceptance.

## 1. Requirements & Constraints

- **REQ-001**: Separate mission, system instructions, routing description, owned responsibilities, excluded responsibilities, inputs, outputs, completion criteria, and escalation targets in the Agent editor. Persist the existing `AgentContract` shape; do not mistake natural-language Definition of Done for executable proof.
- **REQ-002**: Provide saved test suites, individually selected test cases, deterministic output/JSON/artifact checks, server-generated verification evidence, and version-aware comparisons. A process exit, model assertion, or literal string match must not be labeled proof of external business success.
- **REQ-003**: Configure Agent-private, explicitly Team-shared, and session-only knowledge with source provenance. Enforce authorization before retrieval, keep those scopes distinct, and render actual retrievable citations.
- **REQ-004**: Version the complete reusable Agent configuration: instructions, contract, model selection, Skill version IDs, tools, knowledge bindings, and limits. Preserve immutable run snapshots; provide publish and rollback without rewriting historical runs.
- **REQ-005**: Expose turns, wall-clock timeout, concurrency, token, tool-count, and USD limits with usage/reservation/remaining views. Server limits are authoritative, concurrent reservations are atomic, unknown prices remain unknown, and a subscription is not displayed as zero measured cost.
- **REQ-006**: Recover an unfinished setup after browser refresh using an actor/workspace-scoped server draft with stable creation/test idempotency keys. Resume only the incomplete setup stage and never dispatch a terminal test automatically.
- **REQ-007**: Add state-aware pause, resume, cancel, explicit rerun, test-case history, follow-up, and acceptance controls to inline debugging by reusing existing routes. Unsupported operations must explain their boundary rather than optimistically report success.
- **REQ-008**: Deliver separate evidence for unit/HTTP tests, isolated real-backend browser tests, dedicated Redis restart recovery, and an explicitly authorized read-only real-provider/MCP smoke test.
- **SEC-001**: Drafts, revisions, test results, budgets, knowledge bindings, citations, and artifacts are authorized by server-resolved actor/workspace. Never trust client-supplied ownership. Enforce access on both metadata and bytes.
- **SEC-002**: Do not store credentials in drafts or revisions. Store references rather than credential values; exclude file bytes and retrieved sensitive passages from configuration snapshots. Apply existing DLP to output/evidence.
- **SEC-003**: Contract tools and Skill tools cannot expand effective ToolPolicy. Knowledge content is untrusted input, cannot grant permissions, and cannot execute instructions outside the submitted task.
- **SEC-004**: User-written test cases are not arbitrary shell programs. Reuse the completion gate's bounded command allowlist only after explicit selection and authorized workspace resolution. Do not add arbitrary commands or unbounded regular expressions.
- **CON-001**: Preserve all pre-existing dirty-tree changes, historical Agent IDs, tasks, executions, artifacts, model settings, and user data. Use additive migrations; no database reset or mass overwrite.
- **CON-002**: Do not commit, push, create/merge a PR, package, publish, change provider accounts, or enable Runtime V2 globally without separate user authorization. Packaging remains excluded at the user's prior request.
- **CON-003**: SQLite is the current supported synchronous application path. `getDb()` explicitly rejects PostgreSQL; adding `DATABASE_URL` or passing a PG connection check cannot count as application compatibility. Whole-repository async/PG migration is a separately reviewed follow-on.
- **CON-004**: A runtime that cannot enforce a submitted required gate or hard limit must reject that dispatch with a structured unsupported-capability response. Do not silently weaken the policy or rely on UI enforcement.
- **GUD-001**: Retain the existing dashboard design tokens, modal keyboard/focus behavior, Markdown renderer, collapsed tool activity, and full-conversation/artifact fallbacks.
- **PAT-001**: Implement types and schemas first, then additive persistence/services, authorized routes, runtime integration, UI callers, and tests within each phase. Rebuild shared declarations before dependent checks.

## 2. Implementation Steps

Phases run sequentially. Tasks within a phase depend on the preceding task unless
an explicit dependency below says otherwise. No parallel writers are assumed.
Stop at a failed phase gate; retain the draft/report and fix that phase before
advancing. A checkmark requires the named verification evidence, not merely code.

### Implementation Phase 1 — Contract and recoverable setup

- **GOAL-001**: Persist a structured contract and recoverable wizard without duplicate Agents/tests; retain compatibility for existing Agents with no contract.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Added draft/snapshot DTOs and shared `agent-setup-payload.ts`; reused existing AgentContract/schema. Added independent system instructions, server limit/credential checks and creation placeholder ID normalization in Agent routes. | Yes | 2026-10-11 |
| TASK-002 | Added scoped `agent_setup_drafts` persistence/routes with stable server keys, revision conflicts, response-lost save replay and locked configuration. Agent/Skill/task stage is reconciled from durable receipts/assignment rather than trusted client IDs. Discard removes only the draft. | Yes | 2026-10-11 |
| TASK-003 | Added append-once `task_agent_setup_snapshots`, snapshot helpers and queue/inherited-context pinning. Runtime uses pinned instructions/contract/limits; current revoked tools/network still win. Named mandatory file inputs are checked against scoped documents/artifacts and yield waiting-for-user without model invocation. Natural-language quality/outputs are not presented as independently verified. | Yes | 2026-10-11 |
| TASK-004 | Added contract editor, server draft recovery selection, 500 ms autosave, serialized revision writes, close/create/test flush, conflict/recovery UI, current-model preservation and editable turns/timeout/concurrency. Refresh/recovery never dispatches automatically. HTTP/unit/React interaction tests and builds passed; native browser acceptance remains outstanding. | Yes | 2026-10-11 |

Gate: response loss, refresh, close/reopen, actor/workspace switches, simultaneous
tabs, and partial Skill/test failure do not duplicate an Agent or task. Existing
Agents without new fields execute with their current behavior.

### Implementation Phase 2 — Complete configuration revisions

- **GOAL-002**: Every new test/run can identify a complete immutable Agent revision; active runs are unaffected by edits or rollback. Depends on GOAL-001.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Added `agent-config-version.ts` DTOs/model and additive immutable revisions/active pointer tables. Capture instructions, contract, model/policy, limits, tool declarations, exact Skill IDs/checksum or bounded resource-file content, and existing domain/knowledge references. Recursively canonicalize JSON and reuse SHA-256-identical revisions; reject known credential content. | Yes | 2026-10-11 |
| TASK-006 | Added scoped history/detail/preflight/publish/rollback APIs and atomic expected-active/expected-working-hash checks with audit. Queue and inherited task contexts pin revisions; runtime and capacity checks consume pinned settings. Skill reassignment cannot drift a run, missing/archived Skill/domain references block with reconciliation, and revoked tool/network permissions still restrict execution. Existing runs are not retroactively versioned. Added scoped execution attribution for version/hash, requested/actual model and declared/effective tools. | Yes | 2026-10-11 |
| TASK-007 | Added Agent version history in directory/setup and attribution in debug. Users see configuration summaries and changed fields, explicitly check capabilities and confirm publish/rollback. Working copy remains separate from active version; unavailable working Skill cannot prevent viewing/restoring valid history. Unit/HTTP/React and runtime/paused-checkpoint fixtures passed; native browser/live acceptance remains outstanding. | Yes | 2026-10-11 |

Gate: modify an Agent while a task is queued/running; its pinned prompt/model/
Skill/tool/limit configuration does not drift. Permission revocation still wins.

### Implementation Phase 3 — Saved evaluations and independent gates

- **GOAL-003**: A saved test suite yields durable, correctly scoped pass/fail/unavailable evidence and revision comparisons. Depends on GOAL-002.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | Define versioned evaluation suite/case/rule/result types in a new shared `agent-evaluation.ts`. Add Zod schemas, `agents/agent-evaluation.ts`, `db/models/agent-evaluation.ts`, and additive suite/run/case-result tables. Limit a suite to 20 cases, an instruction to 8,000 characters, and 20 checks per case; validate JSON schemas and impose input/output bounds. Initial rules: literal contains/not-contains, JSON Schema via existing Ajv, required output artifact, and the existing bounded command criteria. Natural-language rubrics require human review and are never automatic passes. | Yes (local gate) | 2026-10-11 |
| TASK-009 | Integrate `routes/agents.ts`, existing `/:id/test`, `queue/task-queue.ts`, `agents/completion-gate.ts`, and execution acceptance. Dispatch only explicitly selected cases, sequentially per suite; use actor/workspace-scoped suite/case keys, one pinned configuration revision, and immutable per-case completion criteria. Persist verifier output/hash/evidence server-side. Missing mandatory evidence is failed; unavailable verifiers are unavailable; empty results cannot pass. A retry or response replay never starts another case/task automatically. | Yes (local gate) | 2026-10-11 |
| TASK-010 | Add `AgentEvaluationEditor.tsx` and `AgentEvaluationResults.tsx`; provide cases, expected checks, individual execution selection, result history and revision comparison. Report counts for passed/failed/unavailable/pending separately. Semantic/business rubrics show review required; regression fixtures are visibly different from live model runs. Extend setup, completion, acceptance and dashboard tests. | Yes (local gate) | 2026-10-11 |

Gate: fixture outputs containing the word “success”, invalid JSON, missing
artifacts, changed evidence, rejected permission and unavailable external
verifiers cannot earn business acceptance. Test replay creates no duplicate run.

### Implementation Phase 4 — Knowledge boundaries and citations

- **GOAL-004**: Knowledge can be configured and cited without crossing Agent, Team, session, or workspace permissions. Depends on GOAL-003.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-011 | Add knowledge binding/source DTOs and `db/models/agent-knowledge.ts` with additive document/binding metadata. Reuse `knowledge/session-document-parser.ts` and current upload/DLP/path limits. Keep immutable source hash/version metadata; reuse existing session documents rather than converting all uploads into global knowledge. Add authenticated bind/unbind/upload/list routes and denial tests. A filename alone must never identify a source across tenants. | Yes (local gate; browser acceptance separate) | 2026-10-11 |
| TASK-012 | Extend `memory/runtime-knowledge-bridge.ts`, `knowledge/rag.ts`, `knowledge/session-documents.ts`, and runtime context preparation: resolve workspace access first, explicit Agent-private bindings second, current Team-shared bindings third, session-only documents last. Priority for overlapping authorized passages is session, Agent, Team; show provenance instead of silently claiming one source is truth. Cap combined retrieval at 12 passages/16,000 characters and label omitted content. Persist a scoped source ID/hash/locator manifest per run; deletion/revocation produces unavailable citations, never cross-scope fallback. | Yes (local gate; live acceptance separate) | 2026-10-11 |
| TASK-013 | Add `AgentKnowledgeEditor.tsx`, source-scope labels and citation links in debug/conversation Markdown. A citation link resolves only manifest-backed sources through authorized APIs. Show source file/title, passage locator and evidence scope; arbitrary model-written source IDs are not trusted. Test Team non-membership, session inheritance, identical filenames, malicious document instructions and revoked access. | Yes (local gate; browser acceptance separate) | 2026-10-11 |

Gate: an Agent cannot retrieve another Agent's private documents or another
workspace's same-named file; the user can open every displayed verified citation
or see an explicit access/deletion explanation.

### Implementation Phase 5 — Enforced budgets and usage UI

- **GOAL-005**: Editable limits take effect on the server, including concurrent dispatch and resume; measured and unknown usage remain distinct. Depends on GOAL-004.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-014 | Add validated limit forms/types and scoped policy/read-usage APIs using `agents/budget-service.ts`. Preserve existing defaults for Agents without policies. New limits accept turns 1–200, timeout 10–3,600 seconds, concurrency 1–8, optional positive token/tool quotas and USD cap; server global/workspace ceilings still override. Editing a configured cap requires expected policy revision; do not overwrite a running task's immutable limit snapshot. | Yes | 2026-10-11 |
| TASK-015 | Integrate policy checks/reservations into `agents/runtime-limits.ts`, `runtime-adapter.ts`, host loop model/tool dispatch and `queue/task-queue.ts`, including V2 disabled paths. Resume counts prior usage and reservations; replay cannot double-charge. Unsupported external runtimes/limits are blocked before dispatch. Unknown-price requests under a hard USD cap are rejected as unenforceable rather than assigned zero. Apply the minimum remaining bound from task/Agent/workspace constraints. | Yes | 2026-10-11 |
| TASK-016 | Add `AgentBudgetEditor.tsx` and live debug budget summaries: observed usage, reserved usage, remaining quota and unknown cost. Show period boundaries explicitly as UTC day or lifetime. Test parallel requests, released undispatched reservations, usage receipt duplication, exhausted quota, subscription cost uncertainty, configured model overrides and pause/resume accounting with V2 both enabled and disabled. | Yes | 2026-10-11 |

Gate: two concurrent requests cannot both spend the same remaining allowance;
neither refresh nor resume grants a fresh budget. UI fields map to actual limits.

### Implementation Phase 6 — Inline debug and acceptance controls

- **GOAL-006**: Setup testing offers truthful run controls, history and acceptance without opening unrelated workflows. Depends on GOAL-005.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-017 | Add a shared control-capability response computed server-side from task/run state and runtime kind. Reuse `routes/tasks.ts` pause/resume, `routes/executions.ts` cancel/follow-up/acceptance, loop checkpoint validation and queue fencing. Pause stays requested until a stable boundary is persisted; unsupported external/graph controls return the existing boundary or a structured capability error. No premature paused/accepted UI. | Yes | 2026-10-11 |
| TASK-018 | Extend `AgentSetupDebug.tsx` with state-aware controls, selected test-case history, explicit rerun confirmation and inline follow-up. A rerun has a fresh key and task ID; prior attempts/evidence remain visible. Completed-task follow-up uses the existing full-session follow-up/new-task mechanism rather than sending to a closed stream. Acceptance calls existing evidence-freshness checks and requires a user decision. Keep full-session/artifact fallbacks. | Yes | 2026-10-11 |
| TASK-019 | Test pause during model streaming, a read tool, a write/unknown-effect tool and queued work; verify reconciliation before unsafe resume. Test close/reopen, event reconnect, cancel/completion races, stale acceptance evidence, duplicate clicks, keyboard focus and recovery from server errors. Old socket events cannot change the selected test's status. | Yes | 2026-10-11 |

Gate: each button matches a server-permitted operation and the UI follows the
persisted state. Closing the wizard still does not silently cancel a task.

### Implementation Phase 7 — Acceptance evidence and documentation

- **GOAL-007**: Prove the implemented scope in independent environments without overstating production readiness. Depends on GOAL-006.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | Extend the isolated fixture server/browser suite using `tests/fixtures/runtime-v2-server.ts`, `playwright.runtime-v2.config.ts` and new `e2e/agent-governance.spec.ts`. Use default isolated API 3350/web 5350, validate port ownership, never reuse an unrelated service, and use temporary DB/workspaces. Cover create/reload, versions, test results, citations, budgets, pause/resume and acceptance in the real HTTP/DB/Core/UI chain with clearly labeled fixture transport. | Yes | 2026-10-11 |
| TASK-021 | Run real dedicated Redis restart recovery through `tests/task-queue.redis.test.ts` after confirming a task-owned test container and local URL. Scope queue/task IDs to the fixture; restart only that dedicated container. Verify the persisted Agent revision, test result, budget receipt and run ownership survive; perform no restart of the normal app or shared Redis. Record skipped as skipped if Docker/Redis is unavailable. | No | — |
| TASK-022 | Perform an explicitly authorized read-only real-provider/MCP smoke test after stating selected configured model/Agent/source, expected tool calls, privacy exposure and quota/cost boundary. One model test plus at most one MCP read; no login/QR/credential changes, publication or arbitrary user-task retries. Log requested/resolved model, source, timeline, output/evidence and actual error. If access/tools are unavailable, report an unmet acceptance gate rather than fixture equivalence. | No | — |
| TASK-023 | Update `docs/AGENT-RUNTIME-V2.md`, `docs/ARCHITECTURE.md`, `README.md` and this plan only with features/gates actually verified. Run the final command set below, collect new test counts and report remaining opt-in skips. Leave `MYRMECIA_RUNTIME_V2` unchanged; a future default rollout requires a separate decision using the results. | Yes | 2026-10-11 |
| TASK-024 | Add `plan/refactor-postgres-compatibility-v1.md` as a separate migration proposal based on a read-only inventory of synchronous model/route/runtime dependencies and transaction semantics. Correct PG readiness wording where inaccurate; do not switch the application database or install/migrate PG as part of this task. Report full PG compatibility as outstanding until that separate proposal is approved and implemented. | Yes | 2026-10-11 |

Final gate: declare implementation completion only for features that passed their
phase gates. Separately report browser/Redis/live-provider acceptance, WorkAgent
availability, PostgreSQL migration and default-runtime rollout. Environment
limitations must not be converted into a passed checkmark.

Final validation commands, executed against isolated test resources:

```sh
pnpm --filter @myrmecia/shared build
pnpm --filter @myrmecia/server build
pnpm --filter @myrmecia/dashboard build
pnpm --filter @myrmecia/server test
pnpm --filter @myrmecia/dashboard test
pnpm validate:contracts
pnpm validate:pipelines
pnpm --filter @myrmecia/dashboard exec playwright test --config playwright.runtime-v2.config.ts
git diff --check
```

Redis opt-in command, only with the validated dedicated container variables:

```sh
MYRMECIA_REDIS_RECOVERY_TEST=true pnpm --filter @myrmecia/server test tests/task-queue.redis.test.ts
```

No test command above authorizes setting credential values, production DB URLs,
restarting unrelated services, or invoking a real model through fixture tests.

## 3. Alternatives

- **ALT-001**: A new universal runtime/framework is rejected: existing host-loop and control-plane foundations can support the required features without discarding prior work.
- **ALT-002**: Browser-local drafts are insufficient for actor/workspace isolation and cross-device recovery. Use authorized server drafts; browser state holds the selected draft ID only.
- **ALT-003**: LLM self-grading is not authoritative acceptance. Use bounded deterministic checks/evidence plus explicit human decisions for semantic rubrics.
- **ALT-004**: Enabling Runtime V2 or PostgreSQL by default to make tests pass is rejected. Both have separate staged-compatibility boundaries.

## 4. Dependencies

- **DEP-001**: Existing `AgentContract`, `CompletionCriterion`, ToolPolicy, scoped HTTP auth, immutable execution context and acceptance freshness checks.
- **DEP-002**: Existing Skill version/assignment storage, session document parser, RAG bridge, artifact APIs, DLP, budget reservations and run fencing.
- **DEP-003**: Available pnpm toolchain and current Ajv/Zod/React/Markdown dependencies; no new library is presumed required.
- **DEP-004**: Browser-control access, isolated Docker/Redis and a user-authorized configured model/MCP session are acceptance prerequisites only; their absence must remain explicit.
- **DEP-005**: WorkAgent submission is unavailable in this session. Recheck after plan approval; if a task tool is exposed, submit the agreed scope/base ref/evidence contract and retain its returned ID before execution. Never invent task status.

## 5. Files

- **FILE-001**: Shared `packages/shared/src/agent-setup.ts`, `contracts.ts`, `completion-protocol.ts`, `index.ts`, and new `agent-evaluation.ts`: cross-layer DTOs and compatibility.
- **FILE-002**: `packages/server/src/db/schema.sql` and new models `agent-setup-draft.ts`, `agent-config-version.ts`, `agent-evaluation.ts`, `agent-knowledge.ts`: additive scoped persistence.
- **FILE-003**: `packages/server/src/routes/agents.ts`, `tasks.ts`, `executions.ts` and `contracts/team-composer-contracts.ts`: authorized validation, controls, revisions and evidence.
- **FILE-004**: `packages/server/src/agents/agent-setup.ts`, `agent-prompt.ts`, `execution-context.ts`, `execution-plan-snapshot.ts`, `completion-gate.ts`, `runtime-limits.ts`, `runtime-adapter.ts`, `ts-agent-loop.ts`, `loop-checkpoint.ts`, and new `agent-evaluation.ts`: pinned configuration and enforceable runtime behavior.
- **FILE-005**: `packages/server/src/agents/budget-service.ts`, `queue/task-queue.ts`, `memory/runtime-knowledge-bridge.ts`, `knowledge/rag.ts`, `knowledge/session-documents.ts`: dispatch accounting, retrieval and scope.
- **FILE-006**: `packages/dashboard/src/components/agents/AgentSetupWizard.tsx`, `AgentSetupDebug.tsx`, new contract/evaluation/knowledge/budget editors, `pages/Agents.tsx`, `lib/api.ts`, `lib/agent-setup-draft.ts`: user workflow.
- **FILE-007**: Server setup/completion/acceptance/budget/knowledge/pause tests, new revision/evaluation/draft tests, dashboard setup tests, isolated fixture server and browser E2E.
- **FILE-008**: `README.md`, `docs/ARCHITECTURE.md`, `docs/AGENT-RUNTIME-V2.md`, this plan, and the separately reviewed PostgreSQL migration proposal.

### Context Map

#### Files to Modify

| File | Purpose | Changes Needed |
|------|---------|----------------|
| `packages/shared/src/index.ts` and `agent-setup.ts` | Public Agent/setup types | Draft/revision/evaluation/knowledge/limit DTOs with backward compatibility |
| `packages/server/src/routes/agents.ts` | Already validates `config.contract`; setup/test entry point | Draft/revision/evaluation/knowledge/policy APIs with authoritative scope |
| `packages/server/src/agents/agent-prompt.ts` | Runtime profile and Skill prompt composition | Use pinned explicit instructions/responsibility without widening permissions |
| `packages/server/src/agents/completion-gate.ts` | Existing artifact/output/command verifiers | Saved typed checks and independent evidence, not subjective auto-acceptance |
| `packages/server/src/agents/budget-service.ts` and `runtime-limits.ts` | Reservations and per-run hard limits | Policy/usage reads and enforceable legacy/V2 dispatch integration |
| `packages/dashboard/src/components/agents/AgentSetupWizard.tsx` and `AgentSetupDebug.tsx` | Creation/testing workflow | Contract/draft/version/evaluation/knowledge/budget/control UI |

#### Dependencies (may need updates)

| File | Relationship |
|------|--------------|
| `packages/server/src/contracts/team-composer-contracts.ts` | Existing contract validation imported by Agent routes |
| `packages/server/src/db/models/skill.ts` | Published version bindings are part of Agent configuration snapshots |
| `packages/server/src/agents/execution-context.ts` and `execution-plan-snapshot.ts` | Durable task inheritance and audited configuration |
| `packages/server/src/agents/loop-checkpoint.ts` and `queue/task-queue.ts` | Stable pause/recovery boundaries, state fencing, idempotent dispatch |
| `packages/server/src/knowledge/session-document-parser.ts` and `memory/runtime-knowledge-bridge.ts` | Upload parsing, source scope and authorized context retrieval |
| `packages/server/src/routes/tasks.ts` and `routes/executions.ts` | Reuse controls/acceptance; UI is not a new control authority |

#### Test Files

| Test | Coverage |
|------|----------|
| `packages/server/tests/agent-setup.test.ts` | Creation/test replay, capability boundaries and new draft routes |
| `packages/server/tests/completion-gate.test.ts` and `execution-acceptance.test.ts` | Verifier status, evidence freshness and no false acceptance |
| `packages/server/tests/budget-service.test.ts` and `copilot-budget.test.ts` | Quotas, subscriptions, reservation receipts and limit precedence |
| `packages/server/tests/session-documents.test.ts` and `runtime-knowledge-bridge.test.ts` | Existing upload/retrieval compatibility and added source isolation |
| `packages/server/tests/pause-control.test.ts` and `task-queue.redis.test.ts` | Stable pause/resume, reconciliation and dedicated Redis recovery |
| `packages/dashboard/tests/agent-setup.test.tsx` | Wizard recovery, staged failures, controls, accessibility and results |
| `packages/dashboard/e2e/runtime-v2-real-backend.spec.ts` and new governance E2E | Isolated HTTP/DB/Core/browser proof with labeled fixture model |

#### Reference Patterns

| File | Pattern |
|------|---------|
| `packages/server/src/agents/agent-setup.ts` | Scoped durable `setupEntity()` and read-only `preflightAgent()` |
| `packages/server/src/db/models/skill.ts` | Skill versions and immutable assignments; not whole-Agent versioning |
| `packages/server/src/agents/completion-gate.ts` | Missing/unavailable evidence is not a pass |
| `packages/server/src/agents/budget-service.ts` | Atomic fenced reservation and idempotent usage settlement |
| `packages/server/src/db/database.ts` | Explicit synchronous SQLite / experimental PostgreSQL boundary |

#### Risk Assessment

- [x] Public API additions and optional fields needed; retain existing consumers.
- [x] Additive database migrations needed; test against a seeded pre-change DB.
- [x] Per-Agent policy configuration needed; no global runtime/account change.
- [x] Runtime and knowledge scope coupling requires independent negative tests.

## 6. Testing

- **TEST-001**: Draft saves/restores, stale revisions, refresh during all stages, lost responses and separate tenants; assert one Agent and one task per original key.
- **TEST-002**: Contract ID/role mismatch, unavailable input, skill prompt precedence, denied tools, no contract legacy Agent, unsupported hard gates and immutable task snapshot.
- **TEST-003**: Revision publish/rollback races, recursive hash changes, active/queued/paused run stability, deleted knowledge/Skill permissions, and truthful legacy labels.
- **TEST-004**: Multi-case evaluation success/failure/unavailable, invalid JSON, missing artifact, unregistered external verifier, duplicate receipts, request replay, DLP and stale acceptance evidence.
- **TEST-005**: Agent-private/Team/session/workspace isolation, source manifest hashes, revoked documents, prompt injection and invented citations.
- **TEST-006**: Token/tool/runtime/USD hard caps, remaining reservations, parallel dispatch, unknown price, subscription accounting, duplicate usage, resume and V2 on/off.
- **TEST-007**: State-aware inline controls, stable pause checkpoints, unsupported runtime controls, cancel/completion races, full-session follow-up, selected-history event isolation, keyboard/focus and error states.
- **TEST-008**: Isolated real-backend browser flow with fixture transport, actual dedicated Redis restart, additive upgrade compatibility, and separately consented live model/MCP smoke.
- **TEST-009**: Full shared/server/dashboard build, server/dashboard regression, contract/pipeline validation and whitespace checks. Capture current counts; do not reuse older passing counts as this plan's evidence.

## 7. Risks & Assumptions

- **RISK-001**: The worktree already contains large Runtime V2 and prior fixes. Implementation must inspect overlapping diffs before each edit; no wholesale revert or cleanup is permitted.
- **RISK-002**: Execution-context, budget and completion integrations have side effects. A policy unsupported by a runtime must block the request, not change live account/global settings to simulate support.
- **RISK-003**: Model output may omit or fabricate citations and semantic completion. Provenance lookup and human review remain separate from output formatting.
- **RISK-004**: External runtime/graph pause and arbitrary instantaneous interruption are not universally supported. Inline controls must expose the actual checkpoint capability; adding general external pause is not silently included.
- **RISK-005**: Browser/live-service prerequisites may be unavailable. Report implementation, deterministic verification and live acceptance separately rather than making the feature checklist imply production readiness.
- **RISK-006**: PostgreSQL needs whole-application async model/transaction migration, not this plan's additive SQLite tables. The follow-on proposal remains unimplemented until separately approved.
- **ASSUMPTION-001**: The user authorizes this seven-gap scope after review, but not Git publication, packaging, account changes, default Runtime V2 rollout or database migration.
- **ASSUMPTION-002**: Existing Agents keep their old behavior until a contract/limit/revision is explicitly configured. New revisions are normalized snapshots, not automatic provider entitlement.

### Rollback / Recovery Plan

1. Before each migration/runtime phase, record the affected user-owned diff and
   take a consistent backup of the dedicated acceptance DB. Do not copy an open
   SQLite file without its WAL or a SQLite-consistent backup mechanism.
2. Add nullable fields/tables first and retain compatible readers. If a phase
   fails, stop advancing; disable only its new entry points on the test service
   and retain records for diagnosis. Do not down-migrate by deleting user data.
3. A faulty published Agent revision can be replaced through authorized rollback
   for future tasks. Already queued/running tasks retain their snapshot; pause or
   cancel them only with explicit task authority and supported controls.
4. Do not resume a write/unknown-effect checkpoint after configuration drift.
   Retain the task and require reconciliation; never recreate it to hide history.
5. Normal app services and runtime environment defaults remain unchanged.
   Clean up only task-owned temporary fixtures after evidence is retained.

## 8. Related Specifications / Further Reading

- `plan/feature-agent-setup-v1.md`: locally completed first-batch setup and its acceptance boundaries.
- `plan/refactor-agent-runtime-v2.md`: runtime migration and staged switch.
- `plan/fix-pause-and-orchestration-state-20261010.md`: pause/recovery boundaries.
- `docs/AGENT-RUNTIME-V2.md`: runtime protocol and compatibility.
- `packages/shared/src/contracts.ts`: current Agent responsibility/I/O contract.
- `packages/shared/src/completion-protocol.ts`: current typed completion evidence.
- `packages/server/src/db/database.ts`: actual PostgreSQL support boundary.

### Review Decision

The user authorized Phases 5–7 on 2026-10-11. Budget and inline-debug
implementation is locally verified; Phase 7 records independent acceptance
results below. Redis restart and live-provider/MCP acceptance must not be
inferred from local fixture passes. PostgreSQL migration remains a separate
unapproved proposal.

### Phase 1 Local Evidence and Boundaries

- Added HTTP tests cover draft owner/workspace isolation, viewer denial, revision
  conflict, credentials/invalid limits, locked payload matching, normalized Agent
  IDs, and receipt-backed recovery without duplicate dispatch.
- Added persistence/runtime tests cover DB reopen, response loss, draft discard
  preserving Agent/tasks, save-only followed by first test, locked test prompts,
  pinned parent/child task settings, tool revocation, and missing scoped inputs.
- Dashboard tests cover remount recovery without auto-run, conflict stopping
  creation, serialized saves, close-save success/failure and the contract form.
- Final dashboard regression: 198 passed across 14 files. Shared/server/dashboard
  builds passed. Contract and Pipeline validation passed; the contract checker
  retains 28 warnings for legacy inferred contracts rather than rewriting them.
- Final server full regression: 975 passed, 5 opt-in skipped across 144 passed
  files and one skipped file. Final run duration: 69.99 seconds.
  These counts are deterministic/local evidence, not live acceptance.
- No WorkAgent task, native browser acceptance, real model/MCP request, Redis
  restart, PostgreSQL acceptance, Git commit/push/PR, or packaging was performed.
- Normal API/dashboard ports were not listening during the read-only service
  check. No normal service was started or restarted.
- Phase-one snapshots do not pin Skill content or full model policy/version
  history; those belong to Phase 2. Required textual input means the explicit
  user instruction; typed files require a named authorized uploaded/indexed
  source. Semantic completeness/schema-specific input checks remain future gates.
- Draft contents are stored server-side, not browser-local, and are not encrypted
  at rest by this feature. Known credential patterns are rejected; account
  secrets must remain in the existing provider configuration. Schema strictness
  excludes arbitrary credential fields and file bytes.

### Phase 2 Local Evidence and Boundaries

- Added immutable full configuration revisions and a separate activation pointer;
  updating or rolling back the pointer does not change existing task snapshots.
  Same normalized configuration reuses a revision; creation times and actor IDs
  are not part of its content hash.
- New Agent/assigned tasks with an explicit setup contract/instructions or active
  published version are pinned during context creation. Completely legacy Agents
  without those fields retain their old behavior; existing execution history is
  never backfilled. A late-bound Agent can be pinned at start and is explicitly
  labeled `pinnedBeforeDispatch: false` when no queue-time snapshot exists.
- Before explicit publication, the current configuration remains the working
  behavior. After publication, future tasks use the active snapshot, not later
  working edits. Task-selected model and domain overrides remain separate facts.
- Exact published Skill version/checksum is retained across reassignment.
  Versioned runs do not invoke dynamic latest-Skill matching. Deleted/archived
  Skill references require reconciliation rather than silently loading a file or
  latest version. File-only Skills retain bounded immutable instruction content;
  synthetic file IDs are not inserted into Skill foreign keys.
- Domain/knowledge binding hashes detect configuration drift. Removed/missing
  scoped knowledge is unavailable. This is reference/configuration provenance,
  not immutable document-byte versioning or the knowledge editor/citation system
  planned in Phase 4.
- Revoked tool declarations, explicit denies and network restrictions still win
  over a saved version. A task whose effective prompt/tools differ at a paused
  boundary cannot resume without existing reconciliation checks.
- Activation checks expected current version and current working/dependency hash
  in one transaction; a stale tab receives 409. Working-reference failure still
  exposes a non-sensitive hash/history so a usable old revision can be restored.
  No credentials are stored in revision metadata, configuration or audit entries.
- Runtime tests verified the adapter receives pinned model/instructions/Skill.
  Checkpoint tests verified new publication does not change an old task's
  fingerprint while tool revocation prevents unsafe automatic recovery.
- Dashboard full regression: 201 passed across 15 files, including three new
  history/publish/rollback interaction tests. Shared/server/dashboard builds,
  contract/Pipeline validation and whitespace checks passed.
- Final server full regression: 987 passed, five opt-in skipped, 145 passed files
  plus one skipped file; duration 76.07 seconds. Focused verification also passed
  58 tests across five files. These are local deterministic/HTTP evidence,
  not browser/live proof.
- No normal service restart, real model/MCP call, browser E2E, Redis restart,
  PostgreSQL enablement, Runtime V2 default rollout, Git commit/push/PR or
  packaging was performed. WorkAgent submission remained unavailable.

### Phase 3 Local Evidence and Boundaries

- Saved suites are actor/workspace/Agent scoped, revisioned, canonical-hashed,
  and protected by expected-revision writes. An uncertain identical save can
  recover without another revision; a conflicting edit is rejected.
- Maximums: 20 cases per suite, 8,000 prompt characters, 20 checks per case,
  128 KB suite JSON, 16 KB JSON Schema, 200 KB evaluated output. Empty or
  optional-only checks cannot imply a passed suite. JSON checks use a strict
  bounded structural Ajv subset: no regex, remote/reference schemas, recursive
  or combinatorial schema rules, format coercion or arbitrary shell.
- The completion gate now supports literal exclusion, structural JSON and
  explicit human-review rubrics in addition to existing artifact/command checks.
  Literal checks are output assertions, not external business-success proof.
  Required human rubrics remain unavailable/review-required, never auto-passed.
- A run locks suite content/selected cases and one exact configuration revision.
  Only its first selected case is dispatched at creation; `next` explicitly
  advances one case. New unsubmitted cases are not materialized as queued tasks,
  so polling, response replay or restart cannot auto-start the next case.
  Sequential dispatch is enforced transactionally per suite. Case identity is
  durable; uncertain dispatch retries the same task, not a replacement task.
- Every materialized case has immutable task criteria and a pinned Agent
  snapshot. Subsequent suite edits or Agent publication do not change them.
  Current permission revocation and reference validation remain authoritative.
- Server verifier receipts, contract/output/evidence hashes, actual Provider and
  actual model are retained even after a failed gate. Unknown actual models are
  not filled from requested models. Final case results cannot be overwritten
  by later collection. Missing/mismatched evidence or empty output is failed;
  unavailable verifiers are separately counted. Human acceptance still calls
  the existing persisted-state and evidence-freshness gate.
- Dashboard offers saved cases/checks, version selection, explicit case
  selection, submission recovery, history, same-suite revision comparison,
  separate pending/running/passed/failed/unavailable counts, Markdown output and
  collapsed evidence. Comparison shows fixture/real/unknown transport and actual
  model on both sides; changed case scope/content is not a regression conclusion.
  Full-session and artifact/download fallbacks remain available.
- History API returns at most 30 summaries per page without all outputs/receipts;
  selecting a run fetches full bounded evidence. The UI can load older history
  and refresh new configuration versions without discarding unsaved edits.
- Added server tests: 12 evaluation cases cover validation, scoped writes,
  replay/reopen, explicit order, old revisions, verifier evidence, missing/empty
  results, HTTP authorization, stale acceptance, bounded command fixtures and
  actual in-memory queue/runtime event collection using fixture model transport.
- Added Dashboard tests: six evaluation cases cover explicit submission,
  save conflicts, lost-response key reuse, read-only polling, Markdown/evidence
  rendering and version comparisons; existing setup tests use the named single
  test input rather than the last textarea.
- Final server regression: 999 passed, five opt-in skipped, 146 passed files
  plus one skipped file; duration 74.51 seconds. Log:
  `/tmp/myrmecia-phase3-server-delivery.log`.
- Final Dashboard regression: 207 passed across 16 files; duration 1.40 seconds.
  Log: `/tmp/myrmecia-phase3-dashboard-delivery.log`.
  Shared/server/Dashboard builds, contract validation (28 legacy-inference
  warnings), Pipeline validation and `git diff --check` passed.
- These are local unit/component/HTTP/Core/SQLite/fixture evidence, not native
  browser acceptance or real-provider quality proof. No normal app service
  restart, real model/MCP/login, dedicated Redis restart, PostgreSQL switch,
  Runtime V2 default rollout, Git commit/push/PR or packaging was performed.
  WorkAgent tool discovery still exposed no submission tool; no durable
  WorkAgent task ID or approval is claimed.

### Phase 4 Local Evidence and Boundaries

- Added source/binding DTOs, additive SQLite tables and scoped management APIs.
  Agent-private and Team-shared originals and parsed passages are stored
  separately from workspace RAG vectors and long-term memory. Existing chat
  uploads remain session-only. Source identity includes workspace, scope, owner,
  source ID, binding ID, version and immutable content hashes; filenames confer
  no authority. Upload/bind/unbind/remove operations emit metadata-only audits.
- Uploads reuse TXT/Markdown/PDF/DOCX parsing with a 5 MB file limit, bounded
  parser concurrency, at most 20 active sources per owner, and bounded parsed
  text. Existing DLP rejects known credential patterns and redacts parsed text.
  This is not encryption or complete secret detection: original uploaded bytes
  remain unencrypted server-side, and the editor states that boundary.
- Team knowledge requires both explicit server-persisted task/workflow
  affiliation and exact current Team membership. Agent role substring matching,
  a client-supplied Team ID on task submission, or a same-named file cannot grant
  retrieval access. Inherited task/session scope is resolved within the same
  workspace, including durable execution-context parent links.
- Retrieval first authorizes sources, then deterministically ranks excerpts.
  Priority is session, Agent-private, Team-shared, workspace domain. A combined
  manifest includes at most 12 passages and 16,000 excerpt-text characters;
  metadata framing is additional. Truncated or omitted material is labeled.
  Workspace retrieval uses explicitly bound current domain knowledge IDs and
  drops deleted documents from legacy vector-search results.
- Each execution stores a hash-guarded provenance manifest without excerpt
  bytes. Same-task retries/resume preserve the first retrieved source selection;
  a new follow-up task retrieves fresh sources. Live steer does not silently add
  newly uploaded, unmanifested documents. Published Agent revisions pin private
  binding references: working uploads require a new explicit publication to
  affect future runs on an already published Agent.
- Sources, binding revocation, Team membership and passage hashes are rechecked
  before subsequent model requests, tool dispatch, streamed model output, final
  runtime output and citation resolution. Already transmitted content cannot be
  recalled. A revoked or changed source fails with an explicit unavailable
  result; no same-name or latest-version fallback is allowed.
- Unbind preserves the source for explicit rebind, which creates a new binding
  identity and cannot resurrect an old revoked reference. Remove is a
  recoverable tombstone retaining original bytes, not physical erasure; there is
  no restore UI in this phase. Session/private/Team-derived output is not
  automatically promoted to workspace memory, trajectories or Team findings.
- The Agent editor and setup wizard offer scoped uploads, binding metadata,
  explicit sharing/removal confirmations and unbound-source reattachment.
  Configuration history shows private binding counts. Debug/conversation
  Markdown renders manifest-backed citation controls; collapsed source lists
  expose omissions even if the model does not cite. Opening/reopening a citation
  resolves it afresh, rejects forged IDs and stale responses, and renders the
  excerpt as text without executing raw HTML. A valid citation proves excerpt
  provenance/access, not the truth of a model's claim.
- Added 15 server tests cover scoped retrieval, exact Team membership and task
  inheritance, same filenames, source/manifest tampering, context bounds, DLP,
  pinned versions, revocation at dispatch/output, tombstones, stale vectors,
  HTTP permissions/audits and actual fixture AgentRuntime execution. Added seven
  Dashboard tests cover uploads/bindings/confirmations, explicit citation fetch,
  revoked/forged citations, late-response isolation and collapsed manifests.
- Final server regression: 1,014 passed, five opt-in skipped, 147 passed files
  plus one skipped file; duration 78.43 seconds. Log:
  `/tmp/myrmecia-phase4-server-delivery.log`.
- Final Dashboard regression: 214 passed across 17 files; duration 1.55 seconds.
  Log: `/tmp/myrmecia-phase4-dashboard-delivery.log`.
  Shared/server/Dashboard builds, contract validation (28 legacy-inference
  warnings), Pipeline validation and `git diff --check` passed.
- These are local unit/component/HTTP/Core/SQLite/fixture results. Native browser,
  real-provider/MCP, dedicated Redis restart and production acceptance remain
  outstanding. No normal service restart, login/credential change, PostgreSQL
  switch, Runtime V2 default rollout, Git commit/push/PR or packaging occurred.
  WorkAgent submission tools remain unavailable; no durable task ID or approval
  is claimed. This is the historical Phase 4 checkpoint; Phase 5–7 results below
  supersede its forward-looking status.

### Phase 5–6 Local Evidence and Boundaries

- Added `agent-governance.ts`, `agent-budget.ts`, scoped budget routes and additive
  budget/debug-history migrations. Existing Agent defaults remain intact.
  Policy saves use optimistic revision and support same-content response-loss
  recovery without resetting receipts or rewriting pinned configuration.
- Host-loop model and tool dispatch uses persistent reservations in both
  legacy/V2 paths. Task/Agent/workspace constraints intersect; selected model
  overrides cannot widen a stricter Agent limit. Request output shrinks with
  remaining allowance. Dispatched unknown usage is retained conservatively;
  released or already-dispatched keys cannot authorize a new dispatch.
  Compare-and-swap failure also rejects cross-process claim races.
- AgentManager claims concurrency before yielding to workspace preparation;
  AgentRuntime checks active executions transactionally. Browser acceptance
  reproduced and fixed a completion/admission-release race: queued follow-up
  tasks are awakened after the prior run releases admission.
- USD admission uses configured model pricing estimates. Input token estimates
  are not a provider tokenizer guarantee; cost limits are not vendor-invoice
  guarantees. Unknown/subscription cost remains unknown, and explicit required
  caps reject transports whose internal loop/usage cannot be governed.
- Budget UI separates observed/reserved/remaining usage and UTC/lifetime scopes.
  Refresh preserves unsaved edits, detects revision drift and requires explicit
  form-replacing reload after conflict.
- Shared control capabilities mirror server queue/checkpoint/acceptance authority.
  Inline debugging has confirmed cancel/rerun/acceptance, explicit follow-up,
  persisted attempt history and collapsed tools/artifacts. Unsupported actions
  explain their boundary; no optimistic pause or acceptance state is displayed.
- Tests cover actual TS-loop streaming/read boundaries in legacy/V2, unsafe
  write reconciliation and queued holds, persisted cancellation versus late
  output, stale completion evidence, setup close/reopen/focus, response-loss
  keys, delayed old-task responses and refresh-error retention/reconnection.
  Fixtures do not prove external side effects or business quality.

### Phase 7 Acceptance Evidence and Remaining Gates

- Final server regression: **1026 passed, 5 skipped**, 148 passed files plus one
  skipped file, 80.84 seconds. Log:
  `/tmp/myrmecia-governance-server-delivered.log`.
- Final Dashboard regression: **223 passed**, 18 files, 1.53 seconds. Log:
  `/tmp/myrmecia-governance-dashboard-delivered.log`.
  Shared/server/dashboard builds, contract validation (28 retained inferred
  legacy-contract warnings), Pipeline validation and `git diff --check` passed.
- Isolated browser suite: **7 passed**, 1.9 minutes, real HTTP/Core/SQLite/queue/UI
  and scripted model transport. Log:
  `/tmp/myrmecia-governance-browser-delivered.log`; structured report:
  `artifacts/agent-runtime-v2/browser-e2e.json`.
- Added two governance browser scenarios cover save-only/reload recovery without
  auto-test, private citation, budget save/usage continuity, pause/resume,
  acceptance, fresh follow-up, saved version/hash, selected-case UI submission,
  result history/comparison, Markdown and inline case debugger.
  Version publication is exercised through real HTTP and preflight/component
  tests; native-browser publication confirmation was blocked by the automation
  dialog, not recorded as a successful click-through.
- Browser resources use API 3350/web 5350 with `reuseExistingServer: false`;
  temporary SQLite/workspace roots are outside the repository. Native checks
  and runner use synthetic data, no real credentials or MCP. Normal 3000/5173
  services are untouched. An early test-root placement created one isolated
  test worktree under `artifacts`; it is retained, not confused with normal
  user data, and subsequent fixture roots were moved outside the repo.
- Redis restart test assertions now check config snapshot, failed fixture
  evaluation, budget receipt and ownership fence after DB reopen/container
  restart. **TASK-021 remains No**: Docker CLI exists but its Colima daemon is
  unavailable; no dedicated/shared Redis or normal service was restarted.
- **TASK-022 remains No**: no action-time model/Agent/source/privacy/quota
  confirmation has been obtained. No real-provider or MCP request was made.
- PostgreSQL proposal contains 12 unique tasks and four phases; read-only
  inventory confirmed 34 direct model callers and nine route callers.
  `README.md`, `docs/ARCHITECTURE.md` and DB comments now distinguish experimental
  async adapter from supported application compatibility. No PG switch,
  migration, installation or dependency change occurred.
- WorkAgent tools remain unavailable: no durable task ID, WorkAgent review or
  approval is claimed. No commit/push/PR/merge, packaging, default Runtime V2
  rollout, login or credential changes are part of this delivery.
