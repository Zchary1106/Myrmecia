# Agent Runtime hardening

User approved the cross-layer plan on 2026-10-06. WorkAgent submission tools
were unavailable; implementation and evidence are tracked locally instead.

## Safety boundaries

- Preserve existing workspace edits, conversations, aliases, execution history,
  and confirmed knowledge. No commit, push, PR, merge, or packaging.
- Tests use separate databases and ports. Do not start real pending tasks or
  publish content to validate an execution contract.
- Output checks, quality gates, human acceptance, and production validation are
  different states. Neither a model reply nor an operational score is acceptance.

## Implementation map

| Phase | Implemented scope | Verification state |
| --- | --- | --- |
| Run contracts | Versioned phases, stop reasons, output checks and human acceptance; additive migrations | Local implementation complete; migration/contract tests passed |
| Loop termination and scoring | Normal TS/Skill limits, truncation, empty output, Python result-event check; operational scores no longer update routing | Local implementation complete; full server regression passed |
| Recovery and retries | Stable read-only TS checkpoints, conservative budget carry-over, one retry owner, cancelled-task guard, exact-argument write journal | Unit/simulated restart tests passed; real Redis exercise pending |
| MCP governance | Classified errors, cancellation propagation, pending-request cleanup, transport-exception circuit breaker | Mock-transport tests passed; real third-party acceptance pending |
| Chat, memory and external Agents | Run state/review controls, paginated replay, WS cleanup; quarantined episodes/provenance; external conversation bridge, callback deadline, cancellation and same-Agent continuation | Local implementation complete; desktop/mobile E2E passed |
| Regression and documentation | Fixed failure scenarios, stop/evidence-aware harness, contract documentation and browser screenshots | Local verification complete; production checks remain below |

## Recovery capability boundaries

- Automatic stable-turn resume applies to the ordinary TypeScript read-only
  loop with the same input, workspace, model, system prompt, skill checksum and
  tools. It retains known token/tool/time consumption and conservatively reserves
  an in-flight model request whose actual cost is unknown.
- An in-flight read may be repeated after a crash. External writes cannot.
- Python/Skill/remote-process continuation is not fabricated. Unsupported
  boundaries restart only when safe, or require an operator to inspect the run.
- `MYRMECIA_DURABLE_RESUME=false` disables automatic TS checkpoint resume.
- Exact write arguments are hashed canonically and journaled before dispatch.
  This is not provider-side exactly-once delivery or proof of remote completion.
- CLI cancellation targets the local child; HTTP cancellation aborts the local
  request and explicitly leaves remote side effects unknown.
- Remote callback results require the existing operator/auth controls. Matching
  repeated results are idempotent; conflicting or late results cannot settle a
  completed/cancelled run.

## Validation commands

```sh
pnpm --filter @myrmecia/shared build
pnpm --filter @myrmecia/server test
pnpm --filter @myrmecia/dashboard test
pnpm --filter @myrmecia/server build
pnpm --filter @myrmecia/dashboard build
pnpm validate:contracts
pnpm validate:pipelines
pnpm validate:social-workflow
E2E_API_PORT=3300 E2E_DASHBOARD_PORT=5273 pnpm --filter @myrmecia/dashboard test:e2e
git diff --check
```

Redis recovery must run against a dedicated disposable Redis instance. The
existing test clears its queue; never point it at a user/deployment queue.

## Rollback

Disable durable resume before troubleshooting recovery. Keep the additive
columns/tables and immutable historical evidence. Restore a production database
only from a separately verified backup; do not apply destructive down-migrations
or reset the dirty workspace.

## Outstanding production checks

- Live model/MCP/CLI acceptance, remote side-effect reconciliation and credentials.
- Redis-backed restart exercise on an isolated real Redis instance.
- Signed remote integrations and provider-specific callback delivery guarantees.
- Production-database migration dry run with backup/restore verification.

## Final local evidence

- Shared build and server/dashboard type checks passed.
- Server: 119 test files passed, 731 tests passed; one Redis file/test skipped.
- Dashboard: 12 test files, 138 tests passed.
- Playwright: all 47 tests passed on isolated ports 3300/5273 with two workers.
  Includes 1280px/390px acceptance and refresh, main-composer clarification,
  Memory candidate confirm/reject, session drawers and configuration navigation.
- Server and dashboard production builds passed.
- Repository contracts, pipeline templates and social-workflow validation passed.
  Contract validation still reports 28 legacy-inferred contracts; they were not
  misrepresented as newly explicit contracts.
- `git diff --check` passed.
- Screenshots were visually inspected, not only generated.
- No user conversations were deleted, no real publish actions were executed,
  and no commit, push, PR, merge or desktop packaging was performed.
