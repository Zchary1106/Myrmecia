# Workspace task creation upgrade fix — 2026-10-13

Scope: fix the real Dashboard failure captured in
`artifacts/development-e2e-20261013.F8Wdld/acceptance-report.md`, then repeat that
development task with the original independent acceptance tests.

No reset/delete of the existing database, no account/provider change, no GitHub
publication, no automatic Runtime V2/Redis/Docker switch. Preserve prior local
changes. The original failed acceptance task is cancelled and remains recorded.

## Context Map

### Files to Modify

| File | Purpose | Changes Needed |
| --- | --- | --- |
| `packages/server/src/db/schema.sql` | Upgrade existing databases | New idempotent migration for workspace preparation requests, leaving old migration IDs intact |
| `packages/server/src/queue/task-queue.ts` | Task creation consistency | Atomically create task + preparation request; terminal evidence for later initialization failure |
| `packages/server/tests/migrations.test.ts` | Upgrade regressions | Simulate an old database that has applied lifecycle migration but lacks the new table |
| `packages/server/tests/task-queue.test.ts` | Failure regressions | Verify insertion failure rolls back task and later failures cannot leave runnable pending rows |
| `packages/server/src/agents/agent-contract-input.ts` + focused tests | Required Markdown input | Real rerun requires `approved-spec`, but Markdown uploads require an extension; match the exact logical stem and Markdown type, retaining scope/requirement gates |
| `packages/server/src/db/schema.sql` + migration regression | Budget dispatch upgrade | Real follow-up reached budget dispatch but the installed reservation CHECK constraint lacks `dispatched`; rebuild the table transactionally under a new migration ID, preserving all reservations, receipts, policies and index |

### Dependencies

| File | Relationship |
| --- | --- |
| `db/database.ts` | Tracked migration IDs are deliberately skipped; use a new migration instead of replaying history |
| `workspace/task-workspace.ts`, `workspace-manager.ts` | Preparation reads the request record and binds an isolated directory |
| `routes/tasks.ts`, `events/event-bus.ts` | Preserve API rejection; publish terminal failure evidence when a created task cannot initialize |
| `db/models/task.ts`, execution context | Use existing transaction, failed state and log handling |

### Test Files

| Test | Coverage |
| --- | --- |
| migrations / task-queue | Upgrade idempotence, old data preservation, atomic creation, failure status |
| workspace lifecycle / control routes | Existing directory ownership, queue admission and API behavior |
| original E2E fixture | Real UI submission, actual Agent edits, tests, independent acceptance, result rendering |

### Reference Patterns

| File | Pattern |
| --- | --- |
| `tests/migrations.test.ts` | Remove a table only in an explicit temporary fixture and reopen it with migration history preserved |
| `github/github-fix-delivery.ts` | Transactionally publish task and operator ownership |
| `queue/task-queue.ts` | Keep uncertain remote admission separate from pre-dispatch initialization |

### Risk Assessment

- [x] Additive database migration required; no destructive live DDL.
- [x] Existing task/queue failure semantics must remain intact.
- [x] No public API or deployment-default change required.
- [x] Real Agent calls consume the existing provider quota; limit to the synthetic task.
- [x] Partial execution directories must be retained if preparation fails.

Map reviewed against current source and the actual old database before code changes.

## Acceptance

- [x] Old lifecycle migration remains recorded; new preparation table is created once.
- [x] Existing tasks/workspace bindings/preparation rows are preserved after reopen.
- [x] Preparation request insertion failure cannot leave a new pending task.
- [x] Later initialization failure records a failed terminal task, error and event.
- [x] Focused regressions, builds and full server tests pass.
- [x] Current application applies the new migration through normal initialization.
- [x] Required Markdown contract names can be satisfied by their correctly named
      indexed Markdown files, but not wrong stems, types or other sessions.
- [x] An already-applied budget migration upgrades to support `dispatched`
      without losing reservations or receipts or weakening budget enforcement.
- [x] Original synthetic task is resubmitted from the UI and independently tested.
- [ ] The synthetic task passes all external acceptance and the platform QA/review
      gate. Final external result is 12/13; one bounded correction failed its token
      budget after read-before-write rejections. QA requires command authorization.

WorkAgent/Chrome DevTools connectors were unavailable; use local tests and the
built-in browser without claiming WorkAgent or remote CI acceptance.

## Result

Infrastructure fixes are verified: 93 focused tests, 1,122 server tests (6
environment-dependent skips), 236 Dashboard tests, both builds and diff checks.
The live instance applied both new migration IDs normally (53 total).
The budget-table upgrade preserved the existing reservations byte-for-byte
against a pre-upgrade local SQLite backup.

Real development produced code, tests, README and 21 paired tool receipts in
the isolated example directory. The example's own 12 tests pass, but the external
13 tests have one failure (`separator: null`), and automatic QA remains blocked
by approval. Do not mark this as end-to-end accepted or grant global shell
permission to turn the result green. See the evidence/report in
`artifacts/development-e2e-20261013.F8Wdld/`.
