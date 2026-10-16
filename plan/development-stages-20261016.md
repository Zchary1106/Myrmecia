# Development request stages — 2026-10-16

## Goal and boundary

Make complete-system development use separate, host-owned requests for design,
implementation (core and UI when applicable), and delivery, with a host test
boundary and at most one repair. A response saying "done" is not acceptance.
Preserve the failed 2026-10-15 trial. Keep the selected Haiku model, existing
200k token ceiling and absolute execution deadline; do not enable Runtime V2,
change permissions, commit or push.

## Reviewed context map

| File | Role / intended change |
| --- | --- |
| `packages/server/src/agents/development-workflow.ts` | Existing task classification, safe design/source checks; reuse as stage gates |
| `packages/server/src/agents/development-stages.ts` (new) | Deterministic bounded phase controller, prompts, snapshots and test evidence |
| `packages/server/src/agents/ts-agent-loop.ts` | Advance within the existing execution, counters and deadline; replace bounded request context at phase boundaries |
| `packages/server/src/agents/loop-checkpoint.ts` | Persist phase and retained follow-up instructions with stable checkpoints |
| `packages/shared/src/agent-run.ts` | Expose real phase progress, not acceptance |
| `packages/server/src/testing/task-test-authorization.ts` | Reuse pinned scoped verifier under the current valid writer lease, with cancellation/deadline |
| `packages/server/src/workspace/workspace-lease.ts` | Validate ownership for an in-execution verifier without acquiring/stealing a second lease |
| `packages/server/tests/development-stages.test.ts` (new) | Phase gates, bounded repair, missing authority, context and budgets |
| `packages/server/tests/runtime-v2-baseline.test.ts` | Actual loop, both runtime modes, no early completion, cumulative accounting |
| `packages/server/tests/task-test-authorization.test.ts` | Existing authorization, lease, cancellation and timeout regressions |
| `docs/DEVELOPMENT-DELIVERY.md` | Operational behavior and unverified browser boundary |

Dependencies/patterns: `SessionHarness` journals V2 context/inbox; clear only its
compatibility-array association at a phase boundary, not its durable events.
`prepareProviderSession` keys continuity on system prompt, so phase-specific
system instructions must separate SDK sessions. `budget-service` remains the
persistent task-lifetime authority. `quality-loop` remains independent QA/review;
do not mark a development phase as human acceptance.

Risks reviewed: no database migration; additive run/checkpoint JSON fields;
existing checkpoint fingerprint must change for staged tasks; no public
permission expansion; maintain cancellation/pause fences, follow-up content,
original request and absolute deadline across requests. No automatic browser
or visual pass without real tools/evidence.

## Implementation / acceptance

1. Implement host-owned stages, design-only and delivery-readonly tool guards,
   cumulative token/turn/tool/deadline accounting, bounded stage allocations.
2. Gate final delivery on actual declared files and pinned host test receipts.
   Feed failed output into one repair request; fail closed on missing authority,
   unsafe runner state, repeated failure or changed design/source evidence.
3. Persist stage, counters and follow-ups; preserve V2 inbox/journal and use a
   fresh provider context across phases. Review independently.
4. Run focused and full regression/build. Only then launch a new bounded real
   trial in a separate workspace, with immutable independent checks. Do not
   change source during that run or manually write its application code.
5. Record tests, runtime result, browser evidence and remaining limitations
   separately. A failed real trial remains failed.

## Progress

- Implemented separate host-owned design/core/UI/verification/repair/delivery
  requests in the same governed loop. Added checkpoint journal state/revision,
  real instruction carry-forward, scoped owner verifier and frozen test inputs.
- Independent review found and drove fixes for nested lease acquisition, lost
  follow-ups, test-entry rewrite and compaction-summary provenance. Default
  Node discovery now requires reconciliation after failure rather than enabling
  inline repair.
- Final backend full regression: 1300 passed, 6 skipped, zero failures.
  Dashboard 240 passed. Backend/shared build and `git diff --check` passed.
- Real trial `task_e48a41b5` / `exec_33b32da9` FAILED in design after 9 reads:
  SDK-reported observed lower bound 69,785 / phase allowance 50,000.
  Task lifetime cap remains 200,000; unknown tail retained, not refunded.
  No implementation, host test, QA/review, browser or delivery pass occurred.
- Prior failed task/workspace preserved. New trial uses copied scaffold, not
  host business-code fixes. Temporary test authorization revoked.
- Remaining blocker: design exploration and oversized repeated conversation
  context (actual task input 23,545 chars vs current request 7,479). Do not
  solve by silently dropping prior constraints, increasing budgets, switching
  model, resetting the failed task or blindly launching another round.
- Next: bounded, provenance-preserving task packet / tighter design exploration,
  followed by a separately authorized real trial. Staged fake-provider tests
  prove host transitions, not autonomous full-system delivery quality.
