# Development runtime: local verification — 2026-10-16

This is a publication snapshot, not a production-readiness certificate.
Implementation, deterministic regression tests, live model results, browser
acceptance, remote CI, and human acceptance are separate evidence layers.
Raw task payloads, operator state, local paths, logs, and copied trial
applications are deliberately excluded from the source publication.

## Published scope

- Host-controlled design, core/UI implementation, verification, one bounded
  repair, and read-only delivery within the same task/execution.
- Shared cumulative token/tool/turn budgets and absolute deadline; phase
  limits do not create additional task budget.
- Task-bound design/source checks, frozen design and test inputs, exact-owner
  workspace lease validation, and explicit scoped `npm test` authorization.
- Durable stage/follow-up state and conservative failed-request usage
  accounting; unknown usage is not refunded as though fully settled.
- Evidence-bound GitHub delivery review and reconciliation, explicit
  publication/fork approval, account-discovered model choices, broader
  bounded workspace search, tool-input validation, and queue/pause fixes.

The detailed operational boundaries are in
[development delivery](../DEVELOPMENT-DELIVERY.md) and
[model catalog](../MODEL-CATALOG.md).

## Automated publication checks

Run from the repository root with Node.js 25.9.0 and pnpm 9.15.9. The local
native SQLite dependency must match the Node ABI; the version here describes
the tested environment, not a new minimum Node requirement.

| Command | Local result |
| --- | --- |
| `pnpm --filter @myrmecia/shared build` | Passed |
| `pnpm --filter @myrmecia/server build` | Passed |
| `pnpm --filter @myrmecia/dashboard build` | Passed |
| `pnpm --filter @myrmecia/server exec vitest run --pool=forks --maxWorkers=1` | 1,300 passed, six skipped, zero failed |
| `pnpm --filter @myrmecia/dashboard exec vitest run` | 240 passed, zero failed |

The six backend skips comprise two real Docker isolation cases, three
Redis/BullMQ restart/continuation cases, and one public HTTPS clone case.
These are not passing integration checks. No new live model request, browser
acceptance, Docker/Redis integration run, desktop packaging/signing, or remote
CI run was performed for this publication snapshot.

The dashboard production build emitted a stale Browserslist-data warning.
It did not fail the build; dependency updates were not added to this release
operation.

## Latest bounded live development trial: failed

The preceding real trial used the existing `copilot / claude-haiku-4.5`
configuration and an unchanged 200,000-token task lifetime ceiling. It ran for
approximately 70 seconds on 2026-10-16 (Asia/Shanghai) in an isolated task
directory copied from the previous failed application's scaffold.

It stopped in design after nine read-tool calls, before either required design
JSON file existed:

```text
COPILOT_TOKEN_BUDGET: observed SDK usage exceeded execution allowance (69785/50000)
```

50,000 tokens was the design-stage allowance, not a replacement task ceiling.
SDK usage is observed after provider events; an internal request can overshoot
before interruption. At least 69,785 observed tokens remained conservatively
held with an unknown tail instead of being treated as a settled/refunded call.

No core/UI implementation write, host verification, repair, QA/review, browser
acceptance, or delivery pass occurred. The five copied business/test files
remained unchanged; operator-written application code was not presented as an
Agent result. The temporary scoped test authorization was revoked. There was
no automatic rerun, model switch, budget increase, or failed-budget reset.

The recorded task input contained 23,545 characters, versus 7,479 in the
current request. A bounded, provenance-preserving task/context packet and
tighter design exploration remain follow-up work; they have not yet been
implemented and proven by another live trial. Prior constraints must not be
silently discarded to shrink context.

## Acceptance boundary

Regression tests establish the exercised host transitions and guards, not
autonomous design quality, comprehensive test coverage, malicious-repository
safety, or full-system delivery. Runtime V2 remains opt-in and was not enabled
by this publication. Workspace directory separation does not establish
OS/process/network/credential isolation.

The source is suitable for further controlled evaluation; these results do
not establish that it can replace a primary development tool. Any commit/push
or remote CI status must be checked independently from this dated report.
