# Development delivery correctness — 2026-10-12

Scope: fix the source-backed findings from the development/Codex comparison.
Preserve existing model-catalog/UI changes, normal-service configuration,
accounts and source directories. No real provider call, GitHub publication,
automatic Runtime V2 rollout or infrastructure installation is authorized here.

## Context Map

### Files to Modify

| File | Purpose | Changes Needed |
| --- | --- | --- |
| `agents/dev.md`, `skills/step-validator.ts` | Developer validation | Mandatory tests; missing/scopeless tests must not resolve to `true` |
| `shared/completion-protocol.ts`, server completion gate | Outcome checks | Bounded multi-language/project-scoped verification commands |
| `skills/tool-sandbox.ts` | Workspace search | Language-neutral bounded search, safe paths, exclusions |
| `github/github-fix-service.ts`, GitHub routes/shared types, Teams UI | Reviewed publication | Complete new-file preview, hash-bound selected files and test receipt, explicit human acceptance, durable publication states |
| `routes/system-introspection.ts`, shared diagnostics, Settings UI | Actual runtime capabilities | Display active V2/isolation/recovery limits without silently switching modes |

Paths above are relative to the applicable `packages/server/src`,
`packages/shared/src` or `packages/dashboard/src` root.

### Dependencies

| File | Relationship |
| --- | --- |
| `db/schema.sql`, GitHub fix records | Additive persistent verification/publication receipts |
| `workspace/path-policy.ts`, `workspace/workspace-lease.ts` | Reuse root confinement, excluded paths, writer fencing |
| `agents/completion-gate.ts`, execution artifacts | Reuse actual verifier output and retained hashes |
| `dashboard/src/lib/api.ts` | Match additive review/verification API |

### Test Files

| Test | Coverage |
| --- | --- |
| `server/tests/skill-executor.test.ts` | Mandatory failure and unavailable test discovery |
| `server/tests/completion-gate.test.ts` | Command allowlist and injection rejection |
| New workspace-search tests | Other languages, config files, exclusions, bounds and symlinks |
| `server/tests/github-fix-service.test.ts` + new delivery tests | Local Git preview, stale review rejection, selected staging, publication failure/retry; fake remote transport |
| Dashboard component tests | Review selection/confirmation, errors and stale responses |
| System/control regression | Truthful active runtime diagnostics |

### Reference Patterns

| File | Pattern |
| --- | --- |
| `workspace/workspace-reviewed-changes.ts` | Immutable review hash + explicit confirmation |
| `agents/completion-gate.ts` | Evidence-backed outcome, unavailable is not success |
| `workspace/workspace-lease.ts` | Cross-process writer exclusion; no expiry-based steal |

### Risk Assessment

- Additive review API is stricter: publication requires current reviewed files,
  a passing verifier receipt and explicit acceptance.
- Additive SQLite tables; existing history is not rewritten.
- No `.env` change, runtime-default change, account change or normal-service restart.
- Safe recovery cannot replay unknown writes; surface this boundary instead.
- A native Codex executor and live comparative benchmark are separate integrations,
  not fixes that can be honestly declared complete by offline regression tests.

The map was checked against callers, current source and existing tests before
implementation. Final outcomes and remaining gates belong in the delivery report.

## Acceptance checklist

- [x] Tests failing or unavailable cannot pass default developer validation.
- [x] Common JS/Python/Go/Rust verification and package scoping are accepted;
      arbitrary shell commands remain rejected.
- [x] Workspace search finds non-JS sources/config without traversing symlinks,
      dependencies or excluded secrets; limits are visible.
- [x] GitHub preview includes newly created files and current evidence;
      publication rejects stale/unverified/unaccepted reviews.
- [x] Only explicitly reviewed files are staged; duplicate/uncertain publication
      never silently commits or publishes again.
- [x] Runtime diagnostics distinguish active settings from implemented options.
- [x] Focused/full tests, builds and isolated browser checks are reported separately.

## Delivery

See `artifacts/development-delivery-fix-20261012.md` for final evidence and
`docs/DEVELOPMENT-DELIVERY.md` for the operator workflow. These checkmarks apply
to the bounded local correctness changes, not a live provider benchmark,
real GitHub publication, Runtime V2 deployment, or production acceptance.
