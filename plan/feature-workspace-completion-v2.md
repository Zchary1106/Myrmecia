---
goal: Complete remaining reviewed workspace operations and publish validated source to GitHub
version: 2.0
date_created: 2026-10-12
last_updated: 2026-10-12
status: Completed
---

# Introduction

The user authorized completion of remaining workspace capabilities and pushing
the resulting source to `Zchary1106/Myrmecia`. No force-push, PR merge, ordinary
directory deletion, credential modification or silent legacy migration is authorized.

## 1. Requirements & Constraints

- Preserve source baselines and immutable execution evidence for reviewed writes,
  additions and deletions in Git and bounded non-Git directories.
- Legacy adoption and branch deletion require separate fresh server previews.
- Keep existing identity, lease, role, path and quota checks.
- Existing dirty source/runtime/governance changes must be preserved and included
  when necessary for a buildable published checkout; exclude private runtime
  state, credentials, raw logs and generated installations.
- Live environment gates must be independently observed, not inferred from fixtures.
- Docker daemon is currently unavailable; do not start/install it without a
  distinct user decision. General OS isolation is not an achievable universal
  claim for opaque external/MCP runtimes.

## 2. Implementation Steps

| Task | Scope | State |
| --- | --- | --- |
| W2-001 | Frozen non-Git baselines, execution deletion evidence and reviewed Git/non-Git additions/deletions | Implemented and locally verified |
| W2-002 | Explicit legacy source adoption and reviewed task-branch deletion API/UI | Implemented and locally verified |
| W2-003 | Live public HTTPS clone, external working-directory probe and desktop staging/package checks where available | Passed within available environment; MCP/Docker unavailable |
| W2-004 | Full build/unit/browser/contract gates, documentation and selective publication | Local gates passed; source published to origin |

## 3. Alternatives

Automatic overwrite against current destination is rejected. Snapshot baseline,
fresh destination fingerprint and immutable output evidence are required.

## 4. Dependencies

Git, SQLite and the existing artifact/lease/journal contracts. Packaging uses the
existing desktop staging tools. Docker/Redis remain environment-dependent.

## 5. Files

### Context Map

| Files to modify | Purpose |
| --- | --- |
| `packages/shared/src/workspace-lifecycle.ts` | Additive frozen baseline metadata |
| `packages/server/src/workspace/workspace-manager.ts`, `workspace-source-snapshot.ts` | Snapshot base bytes and selected deletions |
| `packages/server/src/artifacts/execution-artifact-indexer.ts` | Immutable deletion evidence |
| `packages/server/src/workspace/workspace-changes.ts` | Manifest/evidence-backed Git and non-Git apply |
| New workspace baseline/maintenance helpers, `routes/managed-workspaces.ts` | Explicit registration and branch cleanup |
| Dashboard directory panel/management/API | Reviewed action controls and diagnostics |
| Workspace tests, E2E and docs | Independent evidence and honest remaining gates |

Dependencies: task preparation/inheritance, artifact snapshots, managed workspace
model, runtime leases, operation journals, source upload and desktop staging.
Reference patterns: existing lifecycle previews, source selection receipts,
immutable snapshot store and scoped lease reconciliation.
Risks reviewed: filesystem/SQLite crash gaps, destructive branch/deletion actions,
unregistered legacy identity, new optional DTO fields and stale UI previews.
The context map was reviewed against the existing code before implementation;
user approval already covers implementing these remaining capabilities.

## 6. Testing

Temporary fixtures only for destructive operations; stale target/baseline,
unsealed bytes, symlinks, operator scope and rollback failures must deny apply.
Run shared/server/dashboard builds, full unit suites, isolated browser tests,
contracts, pipeline validation and staged whitespace checks before Git push.

## 7. Risks & Assumptions

Unknown remote effects never imply success. Git branch deletion is merge-checked,
never forced. Non-Git multi-file changes need rollback backups and journal state.
No old directory moves or automatic ownership promotion.

## 8. Related Specifications / Further Reading

- `plan/refactor-workspace-lifecycle-v1.md`
- `docs/WORKSPACE-LIFECYCLE.md`
- `artifacts/workspace-lifecycle/delivery.md`

## Publication and remaining environment gates

Implementation commit `7aa28eabce0f1435a7e3b80762977c9ca42d55ee` was verified
on `origin/codex/workspace-completion-20261012` using the Zchary1106 account.
CI run `38160332768` started; remote gates were still running when publication
was recorded. No PR or main merge was performed.

Completed means the scoped code/local acceptance/publication tasks above.
It does not mark unavailable MCP, Docker/Redis, signed release, PostgreSQL
migration or universal external-tool isolation as passed.
