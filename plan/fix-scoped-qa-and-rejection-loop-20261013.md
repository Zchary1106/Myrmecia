# Scoped QA authorization and bounded correction — 2026-10-13

User approved continuation of the existing synthetic development acceptance.
Keep the same session and isolated directory. No global shell permission changes,
account/model changes, budget increases, Git publication, or agent-substituted
implementation of the sample feature.

## Context Map

### Files to Modify

| File | Purpose | Changes |
| --- | --- | --- |
| server/db/schema.sql | Durable authorization | New migration, task-session grant bound to workspace, canonical directory, package hash, operator, expiry and revoke state |
| server/testing/task-test-authorization.ts (new) | Narrow verifier | Fixed npm test only; validate scope and package on every run, sanitized environment, bounded execution and real evidence |
| server/routes/tasks.ts | Operator API | Confirmed grant/read/revoke; do not grant arbitrary shell execution to a model |
| server/pipelines/quality-loop.ts | QA/review handoff | Use the explicitly authorized host test runner when generic QA shell is blocked; pass actual implementation/test evidence to reviewer |
| server/testing/quality-input-artifacts.ts, agents/agent-contract-input.ts | Scoped typed input bindings | Bind immutable parent evidence to host-created quality children only; do not borrow other sessions |
| server/agents/execution-middleware.ts | Read-before-write recovery | Actionable structured rejection, per-path bounded refusal count, reset only on successful read |
| server/agents/ts-agent-loop.ts | Rejection receipts | Persist paired blocked-tool messages and stop bounded rejection loops; retain existing deny checks |
| server/agents/task-continuation.ts | Fresh execution semantics | Explicitly require a fresh read before editing existing files; previous turns are not current reads |
| server/models/copilot-provider.ts, gateway.ts | Inner SDK limits | Abort on terminal tool rejection and observed token budget exhaustion without waiting for final answer |

All paths above are relative to the repository's `packages/` directory.
Existing dirty changes in these files must be preserved.

### Dependencies

| File | Relationship |
| --- | --- |
| execution-context, task ancestry | Authorize only the selected session and same workspace/root |
| path-policy, workspace-lease | Canonical directory, no symlink/escape, sanitized command environment |
| execution-artifact models/snapshots | Named scoped implementation evidence for reviewer contract |
| test-report, step-validator | Preserve real exit codes and test-report semantics |
| operator-action/http helpers | Role, tenant checks and explicit confirmation |
| run-state / AgentRunStopped | Preserve terminal reason across SDK boundaries |

### Tests

| Test | Coverage |
| --- | --- |
| task-test-authorization (new) | Confirmation, role/tenant isolation, exact command, expiry/revoke, package/path drift, actual pass/fail receipts |
| execution-middleware | Varying-payload rejection loop, successful read recovery, failed reads do not unlock writes |
| copilot-budget | Terminal callback abort, observed token cap, cleanup, late calls denied |
| task-continuation | Fresh-read instruction without resetting history or approvals |
| reliability-quality-gate integration | Authorized deterministic validation and independent reviewer, existing blocked path unchanged |
| original 13 independent sample tests | Agent fixes null itself; acceptance script/hash unchanged |

### Reference Patterns

- Existing scoped operator endpoints require role and `confirm: true`.
- Budget migrations use new IDs and preserve existing records.
- Quality Loop requires actual command/cwd/exitCode evidence and explicit review JSON.
- Verifier claims its own directory lease and persistent tool budget; a timeout or
  unknown child-process outcome marks the lease uncertain, not reusable.
- Copilot abort races already bound idle and wall time; reuse that path.

### Risk Assessment

- [x] Additive API/database migration; no destructive data reset.
- [x] npm test executes project code: scope and package fingerprint are required;
      host policy is not an OS sandbox and cannot guarantee zero side effects.
- [x] No model-supplied command or global permission widening.
- [x] Real provider calls bounded to the existing synthetic session.
- [x] Preserve failures; a developer response is not acceptance.

Map reviewed against current source and persisted failure ledger before changes.
WorkAgent/Chrome DevTools connectors unavailable; local tests and built-in browser
are the fallback, not remote CI or WorkAgent verification.

## Acceptance

- [x] Authorization stays within this session/path/package and can expire/revoke.
- [x] Rejections are visible and terminate bounded loops; successful reads recover.
- [x] Inner SDK observes token cap and aborts terminal tool failures.
- [x] Focused/full regression and builds pass.
- [x] Same Agent corrects null; original independent tests pass without alteration.
- [x] Actual automatic validation/review result is recorded truthfully.

## Verified delivery

Focused regression: 56 passed. Full server suite: 1,134 passed, 6 skipped;
final server build and `git diff --check`: exit 0. This stage changes server
behavior only; the earlier dashboard suite was not rerun.

Same session `task_a0ecdd42`, correction `task_e77483fa` / `exec_5e55497a`:
the Agent freshly read two files, patched the implementation and regression
assertion itself, and executed `npm test` (12/12, exit 0). No host implementation
of the sample feature or external test modification.

Host QA `task_fc49379e` executed only the granted `npm test`, recorded a real
passed receipt `tr_3d4f4f93-7f4b-4472-af70-e214584ab584`, and settled its own
budget. Reviewer `task_386516df` / `exec_aee5f43e` received immutable implementation
and test-report inputs and returned `approved: true`; quality attempt
`ql_00daff62` is approved and the correction task is done.

Original independent acceptance: 13/13 passed; script SHA256 unchanged.
Temporary grant `ta_47d3de60-36b6-4a8e-a78e-0c322e5301a4` was revoked after
completion through the normal operator API. Generic QA shell permissions remain
unchanged. No commit/push, global configuration change, or database reset.

Evidence and remaining boundaries:
`artifacts/development-e2e-20261013.F8Wdld/scoped-qa-and-correction-report.md`
(retained locally, not included in the source publication).
This is one successful low-risk local acceptance, not production or general
coding-tool replacement proof. The session UI still labels execution versus
formal task-outcome acceptance separately, and no outcome criteria were added
retroactively. Host policy is not OS isolation.
