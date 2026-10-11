# Workspace lifecycle delivery

Acceptance date: **2026-10-12**. Status: **local implementation accepted**.

Repository: `/Users/yadongzhai/MyWork/agent-factory`.
Branch: `codex/release-readiness-e2e`; unchanged HEAD: `ee30d76`.
The checkout also contains earlier runtime/governance/UI work and CrewAI removal.
This report concerns workspace lifecycle; it does not attribute all dirty files
to this feature. No commit, push, PR or merge was performed.

## Delivered phases

| Phase | Delivered outcome |
| --- | --- |
| 1 — contracts and safety | Scoped registrations/bindings/journals; no completion auto-merge, rollback deletion or destructive retention |
| 2 — roots/import/concurrency | Explicit selected source, isolated HEAD/copy preparation, persistent import receipts, shared writer fencing and pause-baseline checks |
| 3 — evidence/lifecycle/apply | Hash-verified immutable execution output, partial evidence, reviewed archive/restore/purge and tracked Git patch application |
| 4 — visible workflow/acceptance | Launcher modes, session facts, Home management, confirmations, browser evidence, docs and checked-off plan |

Scope details: [Workspace lifecycle](../../docs/WORKSPACE-LIFECYCLE.md).
Task checkoff: [Implementation plan](../../plan/refactor-workspace-lifecycle-v1.md).

## Independent verification

| Gate | Observed result |
| --- | --- |
| Shared build | Passed |
| Server build | Passed |
| Dashboard production build | Passed |
| Full server suite | **1,044 passed / 5 skipped**, 152 passed files / 1 skipped file |
| Full dashboard suite | **225 passed**, 19 files |
| Focused workspace/runtime/auth/pipeline suite | **75 passed**, 8 files |
| Final storage/root/coverage regression | **13 passed**, 3 files |
| Real-backend fixture browser suite | **9 passed**, approximately 2.4 minutes |
| Contract validation | Passed: 36 Agents, 15 workflows; 28 legacy-inference warnings |
| Pipeline validation | Passed: 16 templates, 85 stages, 50 known roles |
| Whitespace check | Tracked `git diff --check` passed; feature-owned new source/docs had no whitespace diagnostics |
| Existing local services | API readiness and Dashboard returned HTTP 200 on 3000/5173 |

The five skipped server tests belong to the opt-in Redis recovery suite
(`REDIS_URL` and `MYRMECIA_REDIS_RECOVERY_TEST=true` are required; the actual
container-restart case additionally requires a dedicated test-container name).
Skipped tests are not counted as passes. No Docker installation/restart occurred.

Build warning: Browserslist's local compatibility dataset is old; build succeeded.
Contract inference warnings describe legacy definitions, not validation errors.
An additional broad untracked-file scan found whitespace in pre-existing raw
logs, evidence/patch fixtures and an earlier governance test. Those unrelated
files were preserved; this is not a claim that every historical untracked
artifact is formatting-clean.
Earlier browser fixture logs include non-Git coverage-check diagnostic noise; the
coverage checker subsequently received an own-Git-root/readonly guard and passed
its targeted test plus the final full server suite. UI/browser assertions were
unchanged by this worker guard.

Local command logs (temporary files; durable conclusions are in this report):

- `/tmp/myrmecia-workspace-server-final.log`
- `/tmp/myrmecia-workspace-dashboard-final.log`
- `/tmp/myrmecia-workspace-focused-final.log`
- `/tmp/myrmecia-workspace-storage-final.log`
- `/tmp/myrmecia-workspace-build-final.log` (Dashboard build output; shared/server
  success was separately observed in the same successful composite command)
- `/tmp/myrmecia-workspace-browser-final.log`

Retained browser evidence:

- [JSON test report](browser-e2e.json)
- [Execution-directory panel](browser-e2e/workspace-lifecycle-source-217a8-re-are-real-persisted-facts/execution-directory.png)
- [Workspace management](browser-e2e/workspace-lifecycle-source-217a8-re-are-real-persisted-facts/workspace-management.png)

Both screenshots were inspected. Sidebar directory details can scroll; the
browser test explicitly scrolls the safety boundary into the viewport.

## What the tests establish

Unit/HTTP/storage tests exercise:

- Filtered copy and independent source roots, pinned Git HEAD, tracked `.env`
  exclusion, and a non-Git import nested inside the service repository.
- Traversal/symlink denial and root identity; supported local readonly denial.
- Persistent actor/authorization-workspace import receipts across DB reopen,
  idempotent completion, secret exclusions and cancelled-byte retention.
- Cross-actor/workspace denial and viewer/operator-header spoofing rejection.
  Authenticated token/API-key identity cannot adopt `x-user-id` or elevate scope.
- Canonical/overlapping writer exclusion, monotonically fenced claims and a
  separate process attempting the same persistent lease.
- Uncertain-owner release requires fresh claims and explicit stopped-effects
  attestation; no process kill or write replay.
- Paused Git continuation rejects changed execution HEAD.
- Historical bytes remain unchanged after work-file overwrite/deletion; quotas,
  preserved legacy labels and conservative purge denial.
- Archive/restore/owned-fixture purge with stale preview protection. Purge
  retains snapshot bytes and does not remove source or task branches.
- Explicit tracked Git patch apply leaves target HEAD unchanged; absent
  confirmation, dirty/stale/missing evidence and unsealed edits deny application.
  Untracked/non-Git patches are downloadable; deletions require reconciliation.
- Pipeline stage/final report bytes exist before the done event.
- Waiting-for-user questions retain partial immutable evidence.
- Long-loop context-summary versions never rewind after context refresh.
- UI delayed-response isolation, cancellation focus, and server conflicts do
  not produce an optimistic archived state.

Browser tests exercise the actual Dashboard, HTTP routes, TS/Core, queue and
SQLite using a scripted model:

1. Existing governance/runtime flows (seven scenarios): Agent setup/evaluation,
   knowledge authorization, budgets, pause/resume, steering and acceptance gates.
2. Uploaded source versus isolated execution paths, same-root follow-up, fixed
   historical download, management archive/restore, confirmation focus, and no
   browser page errors in the workspace scenario.
3. Two distinct Agents serialize `shared_write` to the same directory; the second
   waits in queued state and starts after the first settles without a failed run.

This is actual browser/backend integration, **not live model/MCP acceptance**.

## Safety and compatibility limits

- Directory isolation/path checks do not universally constrain Host Shell, MCP
  or opaque provider-owned execution. The UI says “server execution directory”.
- Unsupported readonly Shell/MCP/native loops are denied. External CLI allowed
  roots are not silently widened; deployment setup may be required.
- Legacy paths remain `legacy_unmanaged`; old artifact refs remain mutable/live.
- Archive keeps files in place. Periodic retention only marks candidates.
- Purge is limited to owned, archived, settled roots with complete retained byte
  coverage. Excluded files, symlinks, dirty Git worktrees and unsaved inputs block
  it. Git branches remain; branch deletion is not implemented.
- Patch apply is not a commit, merge, push or PR. Non-Git/untracked changes and
  deletions require manual review/reconciliation.
- Dirty-source overlays are explicit existing-file selections over bounded
  filtered HEAD; large repositories use HEAD-only preparation.
- Additive SQLite storage is used. PostgreSQL migration and broad old-data
  ownership backfill were not performed.
- Filesystem/DB failures retain journals and reconciliation state. Automatic
  recovery does not infer completion or replay uncertain effects.
- Mutation authority is actor/workspace scoped; artifact reading retains the
  existing workspace-collaborator authorization contract.

## External gates and operations not performed

Live Provider/MCP, authenticated/private or live HTTPS clone, dedicated Redis
restart, packaging and universal OS-isolation proof remain separate gates.
No credentials/provider settings changed, Runtime V2 was not globally enabled,
no ordinary directory was deleted/moved, and normal services were not explicitly
restarted. Temporary fixture cleanup removed only task-owned test data.

WorkAgent discovery exposed no submission tools; no WorkAgent task ID or durable
WorkAgent approval exists. Implementation and verification ran in this chat.
