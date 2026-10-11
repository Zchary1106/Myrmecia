---
goal: Govern task working directories with explicit ownership, safe lifecycle, immutable artifacts and visible execution boundaries
version: 1.0
date_created: 2026-10-11
last_updated: 2026-10-12
owner: Myrmecia
status: Completed
tags: [refactor, workspace, artifacts, safety, runtime, dashboard]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Repository: `/Users/yadongzhai/MyWork/agent-factory`.
Planning baseline: branch `codex/release-readiness-e2e`, HEAD `ee30d76`.
The working tree includes substantial previously implemented changes; this
baseline is not the full implementation state. Preserve those changes.

The user approved implementation of all four phases, including the later phases.
All four implementation phases passed their local acceptance gates on 2026-10-12.
Delivery documentation and independent evidence are recorded below.
WorkAgent tool discovery exposed no task-submission
tools; implementation continues in this chat and no WorkAgent task ID exists.

## 1. Requirements & Constraints

- **REQ-001**: Separate the authorization `workspaceId`, registered filesystem workspace identity and each execution directory. Persist source kind, canonical root, management ownership, baseline, access mode and lifecycle instead of inferring them from directory names.
- **REQ-002**: Stop automatic commit/merge on Pipeline completion. Produce a changes summary; applying or merging requires an explicit operator request naming destination and reviewed diff hash. A human output-acceptance decision is not merge permission.
- **REQ-003**: Stop automatic physical cleanup and rollback-time deletion of managed workspaces. The retention worker only marks eligible workspaces. Archive/restore/purge require scoped operations; unregistered legacy paths and user-owned source directories are never automatically deleted.
- **REQ-004**: Offer explicit `isolated`, `shared_readonly` and `shared_write` modes. New writable top-level tasks default to isolated execution. Following up defaults to the same session workspace, visibly labeled; concurrent writers of the same canonical workspace serialize. Independent top-level tasks do not silently share a writable source directory.
- **REQ-005**: Capture immutable, bounded per-execution artifacts with content hashes. A later task changing `output/summary.md` or another source file must not change historical preview/download bytes. Legacy artifacts are labeled live references until explicitly snapshotted.
- **REQ-006**: Show source, effective execution path, baseline, isolation/access mode, other users of the directory, retention eligibility and artifact capture state in task/session and workspace UI.
- **SEC-001**: Resolve actor and authorization workspace server-side. Imported directory sessions, registered workspaces, previews, artifacts, locks and lifecycle operations require operator roles and scoped metadata/byte checks. No client path or owner field grants access.
- **SEC-002**: Canonicalize real filesystem roots and existing parent components. Reject traversal and symlink escapes for local file tools and snapshot operations. Host Shell, external Agent and MCP remain explicitly outside an OS-isolation guarantee; unsupported readonly execution fails closed rather than claiming safety.
- **SEC-003**: Require a dry-run manifest plus expected revision/hash before filesystem lifecycle or merge operations. Validate exact canonical targets immediately before mutation; retain operations journal and recovery state across filesystem/DB crash gaps. No workspace-wide force deletion or implicit `git add -A`.
- **CON-001**: Do not move existing directories, restart normal services, erase data, migrate DB backend, alter credentials/providers, enable Runtime V2 globally, commit/push/merge this checkout or install Docker as an implementation shortcut. Tests may mutate only their temporary fixture roots.
- **CON-002**: Use additive SQLite schema changes. Existing tasks and checkpoints continue at their recorded paths. Legacy paths remain explicit `legacy_unmanaged`; reads may report them but must not manufacture management ownership or authorize purge.
- **CON-003**: Workspace code and uploaded files may contain sensitive data. Exclude `.git`, dependencies, generated build trees, `.env*` and known credentials from automatic copies/snapshots. Require explicit selection for other sensitive files; preserve DLP and knowledge-source authorization.
- **CON-004**: Snapshot defaults: at most 250 files, depth 8, 20 MiB per file and 100 MiB per execution. Report exclusions, unstable files, truncation and quota failures; required unsaved artifact bytes block successful evidence capture. Do not label partial capture complete.
- **PAT-001**: Extend current Task/Execution/Queue/Completion state and existing workspace/artifact routes. A lifecycle journal is an operation recovery aid, not a second task engine.

### Pre-implementation State

Read-only source inspection before implementation established:

- `WorkspaceManager` defaults its root to `MYRMECIA_WORKSPACE_ROOT` or server
  cwd; creates task/Pipeline worktrees from committed `HEAD`, otherwise plain
  directories. Git failure can silently fall back to an empty directory.
- `AgentRuntime.execute()` reuses a supplied path; terminal follow-up inherits
  execution context. Team tasks can share a source path. The root path does not
  automatically imply isolated execution or separate ownership.
- Pipeline stages share a root and write stage output files. Completion calls
  `mergePipelineWorkspace()`; rollback calls `cleanupWorkspace()`.
- `cleanupExpiredWorkspaces()` uses directory mtime; cleanup can force-remove a
  worktree and its branch. The worker runs on startup and every 30 minutes,
  retaining active task/Pipeline IDs by default for a seven-day window.
- Execution artifact metadata references mutable working files; reply text is
  persisted separately. `output/summary.md` is overwritten by later successful
  execution in the same directory.
- Web local-folder import copies files into `imported-workspaces`; import sessions
  use a process-local Map, with no persisted actor/workspace owner in that Map.
  The browser selection is not a link to the original user's directory.
- Built-in local file tools check lexical path containment; artifact serving
  checks real paths. Neither establishes OS-level isolation of host commands,
  remote MCP or opaque external runtimes.

### Target State

The operator selects a scoped source and access mode, sees the effective
execution directory and frozen baseline, and receives immutable versioned
artifacts plus a changes summary. Work is never implicitly merged back into
source. Retention produces reviewable cleanup candidates, not automatic loss.
Shared writes are serialized and recovery preserves directory/task identity.

## 2. Implementation Steps

### Implementation Phase 1 — Contracts and immediate lifecycle safety

- **GOAL-001**: Eliminate implicit destructive lifecycle actions while adding explicit scoped contracts. Phase 1 is independently deliverable; it does not wait for the directory-management UI.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add `packages/shared/src/workspace-lifecycle.ts` and exports in `index.ts`: source kind, management ownership, access mode, baseline provenance, capture state and lifecycle DTOs. Distinguish `workspaceId`, `filesystemWorkspaceId` and execution path; legacy DTO fields remain readable. | Yes | 2026-10-12 |
| TASK-002 | Add scoped `managed_workspaces`, `workspace_operation_journal` and `workspace_execution_bindings` tables in `packages/server/src/db/schema.sql`; create `db/models/managed-workspace.ts`. Store actor/workspace ownership, explicit registration, canonical identity, revision and status. Do not backfill guessed ownership from paths. | Yes | 2026-10-12 |
| TASK-003 | Remove completion-time auto-merge and rollback-time cleanup from `pipelines/pipeline-engine.ts`. Completion retains files and records a reviewable change-set state; rollback cancels owned work but preserves files. Reject the old `WorkspaceManager.mergePipelineWorkspace()` entry; reviewed patch application uses `workspace-changes.ts`. No compatibility flag re-enables unattended merge. | Yes | 2026-10-12 |
| TASK-004 | Change `workers/workspace-cleanup.ts` and `WorkspaceManager.cleanupExpiredWorkspaces()` to candidate marking only. Use recorded last-use/all-linked-task settlement time instead of directory mtime; missing/legacy ownership, active/paused executions, pending capture or unresolved operations block eligibility. Default candidate age remains 168 hours. Reject old unguarded `cleanupWorkspace()` calls. | Yes | 2026-10-12 |
| TASK-005 | Add Phase 1 regression tests in `workspace-manager.test.ts`, `pipeline-engine.test.ts` and new `workspace-lifecycle.test.ts`. Prove completion/rollback/retention leave paths, bytes, HEAD and branches intact; viewer/cross-workspace requests cannot register ownership or prepare mutations. | Yes | 2026-10-12 |

Gate: no normal runtime completion, rollback or periodic cleanup can delete or
merge files. No existing data relocation. Shared/server/dashboard builds and
focused lifecycle/Pipeline tests pass before continuing.

### Implementation Phase 2 — Execution roots, import ownership and concurrency

- **GOAL-002**: Every new execution resolves a truthful authorized directory and supported access mode. Depends on GOAL-001.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | Refactor `workspace/workspace-manager.ts` to `prepareExecutionWorkspace(binding)`. Use the explicitly registered source repository, not server cwd. Git isolation pins source commit with a `codex/` branch; non-Git sources use bounded filtered copy. Git preparation failure stops dispatch with an error, never silent empty-folder fallback. Existing recorded roots are retained. | Yes | 2026-10-12 |
| TASK-007 | Add `workspace/path-policy.ts` canonical-root validation and integrate `skills/tool-sandbox.ts`. Validate nearest existing parents for writes, reject symlink-root swaps and escape paths, check file descriptors/identity around reads and writes where possible. Expose limitations for host commands; deny host Shell and unsupported opaque adapters in `shared_readonly`. | Yes | 2026-10-12 |
| TASK-008 | Persist import session ownership/revision and completion receipts in `routes/workspace-sources.ts` and the new model. Require operator/actor/workspace checks for upload/complete/cancel; bounded total/file counts, expiry candidates and filtered file manifest. Keep successful imported roots and existing records; authorize network clone using current SSRF/redirect policy before any remote action. Tests use local fixture repositories, not live clones. | Yes | 2026-10-12 |
| TASK-009 | Add `workspace/workspace-lease.ts` with transactional canonical-root admission and fenced ownership. One writer per workspace across processes; readonly claims conflict with active writers. Multi-resource callers use deterministic ordering. Pause retains the directory relationship and blocks archive, while safe yield can release the active writer lease; resume rechecks capture/baseline integrity. Expired uncertain owners require reconciliation, not blind replay. | Yes | 2026-10-12 |
| TASK-010 | Thread explicit bindings through `agents/agent-runtime.ts`, `execution-context.ts`, `queue/task-queue.ts`, `routes/tasks.ts`, `master-agent.ts`, `team-coordinator.ts`, `routes/teams.ts` and `pipeline-engine.ts`. New top-level writable tasks isolate; session follow-ups inherit the root; Team/Pipeline shared writes serialize or explicitly branch. Retain pinned model/knowledge/limits and propagate execution facts without rewriting checkpoint history. | Yes | 2026-10-12 |
| TASK-011 | Add source-baseline and lease tests. Default Git baseline contains committed HEAD only and explicitly labels excluded working edits. Offer explicit dirty-source snapshot only with reviewed file manifest/hash, no credentials or arbitrary untracked files. Test independent source roots, non-Git copy, same-root aliases, reader/writer races, queue wakeup, pause/resume, crash/reopen and legacy path compatibility. | Yes | 2026-10-12 |

Gate: source remains unchanged in isolated mode; same-directory writers cannot
overlap; readonly unsupported tools are denied. Root/mode/model/knowledge facts
survive continuation and recovery. Git worktree is never described as OS isolation.

### Implementation Phase 3 — Immutable output and recoverable lifecycle operations

- **GOAL-003**: Preserve execution-specific artifact bytes independently of source directory changes and make storage lifecycle recoverable. Depends on GOAL-002.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-012 | Add `artifacts/artifact-snapshot-store.ts` and additive snapshot metadata in `db/models/execution-artifact.ts` / `schema.sql`. Store workspace-scoped immutable bytes/hash/size under execution identity using temp staging and atomic finalize. Enforce CON-003/CON-004, report excluded/unstable files, and never use a mutable source path as a verified snapshot. | Yes | 2026-10-12 |
| TASK-013 | Refactor `indexExecutionArtifacts()` and runtime/Pipeline output capture. Snapshot result and file evidence before successful completion/acceptance is reported; failed/cancelled runs retain bounded observed partial artifacts labeled partial. Preserve actual generated outputs, not all checkout files. Store per-execution summaries; `output/summary.md` may remain a mutable convenience pointer but is not historical evidence. | Yes | 2026-10-12 |
| TASK-014 | Update `routes/artifacts.ts`, completion verifiers, knowledge/evidence consumers and `workers/artifact-cleanup.ts` to resolve snapshot hashes/bytes and preserve freshness authorization. Legacy live references are labeled mutable and never automatically claimed immutable. Required snapshot failure blocks corresponding completion criterion; cleanup cannot remove retained evidence or pending capture. Snapshot retention is separate from execution-directory retention. | Yes | 2026-10-12 |
| TASK-015 | Add scoped dry-run/archive/restore/purge operations in new `routes/managed-workspaces.ts`, registered in `index.ts`. Archive closes writes and retains the directory/worktree in place; no physical quarantine is needed. Restore verifies source/baseline. Purge requires fresh explicit confirmation/hash, no active references and verified retained artifact coverage; no user-source deletion and no force fallback. Branches remain retained; a future branch-deletion flow would require a separate explicit preview. | Yes | 2026-10-12 |
| TASK-016 | Add explicit change-set preview/apply in `workspace/workspace-changes.ts`. Require target path/branch/base HEAD, reviewed file list and diff hash. Snapshot source deltas without implicit commit. Apply/merge refuses changed baseline, dirty destination, active writer or missing evidence; unsupported states produce a downloadable patch plus reconciliation instructions. Never auto-push, create a PR or merge merely because a task was accepted. | Yes | 2026-10-12 |
| TASK-017 | Test byte/hash immutability across follow-up overwrite and source deletion using temporary roots; quotas, secret exclusions, symlink swap, artifact auth, legacy labels, capture failure, lease/archive races and crash gaps. Test reviewed tracked Git patch apply only in temporary repositories, require matching sealed file evidence, and prove denied/unconfirmed requests leave destination unchanged. | Yes | 2026-10-12 |

Gate: execution A downloads the same bytes after execution B overwrites the
working file. Active/shared/legacy paths cannot be purged. A crashed operation
has one recoverable journal identity and does not infer success or replay effects.

### Implementation Phase 4 — Visible workflow, acceptance and documentation

- **GOAL-004**: Operators can understand directory ownership and safely choose lifecycle actions. Depends on GOAL-003.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-018 | Add `components/session/ExecutionWorkspacePanel.tsx`, wire `TaskSession.tsx`, `WorkLauncher.tsx`, `AgentSetupDebug.tsx`, Agent Team directory selection and `lib/api.ts`. Show source versus execution path, Git baseline/dirty exclusions, shared/isolated/readonly state, lock owner, historical artifact version and host-isolation disclaimer. Preserve existing chat composer/model/settings behavior. | Yes | 2026-10-12 |
| TASK-019 | Add workspace-management UI with scoped list, last-use/size/capture/candidate status, archive/restore controls and explicit purge preview. Put change-set preview beside artifacts; acceptance, applying changes and deleting storage remain different actions. Include keyboard focus, confirmations, stale revision/server error handling and delayed-response isolation. Existing unregistered directories display read-only reconciliation guidance. | Yes | 2026-10-12 |
| TASK-020 | Extend temporary real-backend fixture/browser scenarios on isolated 3350/5350, or other prevalidated unused ports. Cover source selection, effective paths, shared writer wait, fresh follow-up, immutable artifact download and archive/restore. Validate purge/merge via fixture HTTP/tests, not unattended destructive native-GUI actions. Use scripted provider/no live MCP; record screenshots, failure traces and independent unit/HTTP/browser counts. | Yes | 2026-10-12 |
| TASK-021 | Update `README.md`, `docs/ARCHITECTURE.md`, `docs/AGENT-RUNTIME-V2.md` and create `docs/WORKSPACE-LIFECYCLE.md`. Run final commands below; record legacy boundaries/skips and rollback operations. No normal-service restart, broad data migration or default-runtime change without separate approval. Mark completed only for verified gates. | Yes | 2026-10-12 |

Gate: UI displays actual server-authorized directory facts and saved bytes.
Confirmations cannot be mistaken for permissions on another destination.
Unit/HTTP/build/browser evidence is separate from real-provider/Redis/OS-isolation
acceptance and packaging.

## 3. Alternatives

- **ALT-001**: A permanent folder per Agent is rejected: execution/session ownership is the correct boundary; multiple Agents can contribute while writer access is serialized.
- **ALT-002**: Moving every existing directory to a new global root is rejected. Register only explicitly reviewed legacy paths; retain existing checkpoint locations.
- **ALT-003**: Copying a full repository for each model turn is rejected. Directory lifetime belongs to session/task group; immutable snapshots cover delivered artifacts, not every read.
- **ALT-004**: Automatic merge after success and automatic destructive retention are rejected. Output acceptance does not authorize Git integration or data destruction.
- **ALT-005**: Treating tool path checks as a universal sandbox is rejected. Host Shell, external/MCP tools and isolated execution-world capabilities remain distinct.

## 4. Dependencies

- **DEP-001**: Existing scoped auth/operator roles, Task/Execution contexts, queue admission, checkpoint integrity, run fences, completion criteria and artifact APIs.
- **DEP-002**: SQLite additive migrations, canonical content hashing, filesystem atomic rename and temporary Git fixture tooling already in the repository.
- **DEP-003**: User review of this plan and first-phase gate. WorkAgent submission requires tool availability; absence is recorded rather than inventing a durable task.
- **DEP-004**: Normal application data must stay outside fixture operations. Snapshot/lifecycle tests use new temporary roots, private databases and occupied-port checks.

## 5. Files

### Context Map

#### Files to Modify

| File | Purpose | Changes Needed |
|------|---------|----------------|
| `packages/shared/src/index.ts`, new `workspace-lifecycle.ts` | Shared contracts | Scoped source/execution/lifecycle types |
| `packages/server/src/db/schema.sql`, new `db/models/managed-workspace.ts` | Persistence | Registrations, operation journal, bindings and lease/snapshot metadata |
| `packages/server/src/workspace/workspace-manager.ts`, new path/lease/change helpers | Directory authority | Explicit source prep, isolation, canonical claims, gated lifecycle |
| `packages/server/src/workers/workspace-cleanup.ts`, `artifact-cleanup.ts` | Retention | Candidates, active-reference/evidence protection, no automatic removal |
| `packages/server/src/agents/agent-runtime.ts`, `execution-context.ts` | Runtime | Actual bound execution directory and immutable capture |
| `packages/server/src/pipelines/pipeline-engine.ts` | Pipeline lifecycle | No implicit merge/delete; stage capture and gated apply |
| `packages/server/src/routes/workspace-sources.ts`, `tasks.ts`, `artifacts.ts`, new `managed-workspaces.ts` | API | Actor/workspace ownership, binding, snapshot serving, dry-run operations |
| `packages/dashboard/src/components/common/WorkLauncher.tsx`, `session/TaskSession.tsx`, `agents/AgentSetupDebug.tsx`, `lib/api.ts` | UI | Source/effective path/mode visibility and distinct lifecycle actions |

#### Dependencies (may need updates)

| File | Relationship |
|------|--------------|
| `packages/server/src/index.ts` | Workspace routes and startup retention scheduling |
| `packages/server/src/agents/master-agent.ts`, `team-coordinator.ts`, `routes/teams.ts`, `queue/task-queue.ts` | Directory inheritance, shared writer leases and wakeup |
| `packages/server/src/skills/tool-sandbox.ts`, execution-world helpers | Local path validation and supported readonly capabilities |
| `packages/server/src/artifacts/execution-artifact-indexer.ts`, `db/models/execution-artifact.ts` | Capture before stable completion and byte provenance |
| Completion/knowledge/evidence consumers | Consume fixed artifact identity without widening source access |

#### Test Files

| Test | Coverage |
|------|----------|
| `packages/server/tests/workspace-manager.test.ts` | Worktree preparation, preserved retention and guarded explicit merge |
| `packages/server/tests/execution-artifacts.test.ts`, `completion-gate.test.ts` | Immutable bytes, authorization and capture freshness |
| `packages/server/tests/pipeline-engine.test.ts`, `runtime-v2-baseline.test.ts`, `task-queue.test.ts` | Shared runtime callers, continuation/recovery/lease behavior |
| New `workspace-lifecycle.test.ts`, `workspace-lease.test.ts`, Dashboard component tests | Scoped state machines, races, UI errors and confirmations |
| `packages/dashboard/e2e/agent-governance.spec.ts`, fixture server/config | Isolated real-backend integration, no live provider |

#### Reference Patterns

| File | Pattern |
|------|---------|
| `packages/server/src/db/models/run-ownership.ts` | Transactional claims and stale-owner fences |
| `packages/server/src/agents/budget-service.ts` | Scoped admission, compare-and-swap and response-loss receipts |
| `packages/server/src/db/models/agent-knowledge.ts` | Authorized source provenance and revocable bindings |
| `packages/dashboard/src/components/agents/AgentVersionHistory.tsx` | Preflight, revision conflict and separate confirmation |

#### Risk Assessment

- Public API: additive DTOs plus deliberate removal of implicit destructive behavior.
- Database: additive SQLite migrations required; no PG migration.
- Configuration: preserve existing root settings; no forced host-level path change.
- Runtime: shared writes become serialized; Team throughput and UI waiting state change.

- **FILE-001**: Shared contracts and scoped database models above.
- **FILE-002**: Workspace manager/path/lease/lifecycle/change-set and runtime callers above.
- **FILE-003**: Snapshot store/indexer/serving/retention and evidence consumers above.
- **FILE-004**: Dashboard workspace controls, regression tests, docs and this plan.

## 6. Testing

- **TEST-001**: No side effects on task completion/rollback/retention: unchanged source HEAD, tracked/untracked bytes and directory/branch presence.
- **TEST-002**: Cross-actor/workspace import, binding, lifecycle and artifact access fails without leaking filesystem paths/bytes.
- **TEST-003**: Two independent DB/process claimants and aliased canonical paths cannot concurrently acquire writer access; queued continuations wake after release.
- **TEST-004**: Real TS runtime and fixture tools honor selected roots; symlink/traversal/readonly denial, pinned context and interrupted ownership fail closed.
- **TEST-005**: Immutable capture, secret exclusions, quotas, legacy mutable labels and filesystem/DB crash journals have deterministic results.
- **TEST-006**: Browser-visible path/mode/history and artifact downloads agree with real HTTP/storage; UI never optimistically claims archive/apply/purge success.

Final commands, after each focused phase gate:

```sh
pnpm --filter @myrmecia/shared build
pnpm --filter @myrmecia/server build
pnpm --filter @myrmecia/dashboard build
pnpm --filter @myrmecia/server test
pnpm --filter @myrmecia/dashboard test
pnpm validate:contracts
pnpm validate:pipelines
HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= http_proxy= https_proxy= all_proxy= RUNTIME_V2_REAL_BACKEND=true pnpm --filter @myrmecia/dashboard exec playwright test --config playwright.runtime-v2.config.ts
git diff --check
```

No test command authorizes physical deletion/merge of real user directories,
credential access, live Provider/MCP calls or starting/restarting normal services.

## 7. Risks & Assumptions

- **RISK-001**: Legacy directory identity may be ambiguous or shared. Keep unregistered records readonly for lifecycle; user registration must enumerate affected tasks and source ownership.
- **RISK-002**: Filesystem operations cannot join a SQLite transaction. Stage/journal/checkpoint before mutation; reopen reconciles exact owned targets and never treats an uncertain action as completed.
- **RISK-003**: Artifacts may grow or contain secrets. Enforce byte/file quotas and documented exclusions; do not silently retain a full checkout, private config or knowledge upload.
- **RISK-004**: Shared writer serialization reduces Team/Pipeline parallelism. Make waiting explicit; use separate isolated branches when parallel editing is required, not unsafe concurrent host writes.
- **RISK-005**: Root validation cannot universally constrain host shell subprocesses or external tools. Capabilities and fail-closed readonly policy must reflect that boundary.
- **ASSUMPTION-001**: Existing dirty user working tree and normal service data must be preserved; task continuation uses recorded paths.

### Rollback Plan

1. Back up only the explicitly approved database/fixture before applying schema
   changes. Additive schema remains readable by compatible older callers; do not
   drop registration/snapshot history to force a rollback.
2. If new preparation/capture fails, stop affected dispatches and preserve roots,
   branches, operation journals and partial snapshots. Return an actionable
   reconciliation state, not an empty-directory fallback or duplicated run.
3. Disable new workspace-management mutations while retaining safe reads.
   Reverting must not restore automatic deletion or completion-time merge.
4. Restore a quarantined owned workspace via its journal/manifest after validating
   target availability and Git registration. Never reset a user's checkout.
5. Verify artifact hashes and scoped bindings before resuming. No automatic replay
   of uncertain Shell/MCP writes or partially applied merge operations.

## 8. Related Specifications / Further Reading

- `plan/feature-agent-governance-v2.md`: immutable Agent config, budgets, controls and acceptance gates.
- `plan/refactor-agent-runtime-v2.md`: host/external runtime and execution-world capability boundaries.
- `docs/AGENT-RUNTIME-V2.md`: current local evidence and runtime compatibility.
- `packages/server/src/workspace/workspace-manager.ts`: current directory/merge/cleanup implementation.

### Review Decision

The user confirmed implementation of all four phases. This approval does not
authorize committing/pushing this checkout, merging source changes, deleting
normal user directories, or restarting normal services. Lifecycle mutation
requires its own fresh preview/confirmation. No WorkAgent task was submitted.

### Completion and evidence — 2026-10-12

- TASK-001 through TASK-021: completed within the supported boundaries below.
- Shared/server/dashboard builds: passed.
- Full server: 152 files passed, 1 skipped; 1,044 tests passed, 5 skipped.
- Full dashboard: 19 files / 225 tests passed.
- Browser: 9 passed, including two workspace scenarios with actual HTTP/SQLite
  and scripted provider; path-panel viewport and screenshots inspected.
- Final storage/root regressions: 13 passed; focused runtime/workspace/auth/
  pipeline suite: 75 passed.
- Contract validation: 36 Agents, 15 workflows; 28 explicit legacy-inference
  warnings, no error. Pipeline validation: 16 templates / 85 stages.
- `git diff --check`: passed.
- Normal API/Dashboard readiness: HTTP 200 on ports 3000/5173; no explicit restart.
- Delivery: `artifacts/workspace-lifecycle/delivery.md`.
- Operator documentation: `docs/WORKSPACE-LIFECYCLE.md`.

Supported delivery boundaries: archive is in place, Git branches are retained,
and automatic integration is reviewed tracked Git file-patch apply only, with
matching complete sealed file evidence. Non-Git/untracked files export manual
patches; deletions, damaged evidence and post-capture external edits require
reconciliation. There is no commit/merge/push/PR or automatic data destruction.
Host path checks are not a universal OS sandbox; readonly opaque/Shell/MCP
execution fails closed. Production authentication is separate from disabled-auth
local development. Legacy directories/artifacts are not silently promoted.

External gates not claimed here: live provider/MCP, live HTTPS clone,
dedicated Redis restart, PostgreSQL migration, native packaging, and universal
OS isolation. No new authority was used for those gates.
