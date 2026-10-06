---
title: "Myrmecia Integration Capability Matrix"
status: "In progress"
verified_on: "2026-09-16"
verified_commit: "951883c1dd455f5ed8e413f0d5d004f6e5cebc31"
audit_branch: "codex/release-readiness-e2e"
---

# Myrmecia Integration Capability Matrix

This document records what the inspected checkout can support and what was
actually verified. It is not a marketing feature list.

## Audit boundary

- Repository: `/Users/yadongzhai/MyWork/agent-factory`
- Branch: `codex/release-readiness-e2e`
- HEAD: `951883c1dd455f5ed8e413f0d5d004f6e5cebc31`
- Platform: macOS / Darwin 25.6.0 / arm64
- Node.js: `v25.9.0`
- pnpm: `9.15.9`
- Working tree at audit time: 36 modified or staged paths and 33 untracked
  paths. These changes were preserved and were not treated as part of HEAD.
- Audit type: source inspection, local CLI version checks, and targeted fixture
  tests. No real external Agent task was submitted.

The audit must be refreshed after the maintainer selects the implementation
baseline. A result below applies only to the named execution path and
verification scope.

## Verification levels

| Level | Meaning |
| --- | --- |
| `not_implemented` | The inspected execution path does not implement the capability. |
| `implemented_unverified` | Source code exists, but the behavior was not verified in the stated environment. |
| `fixture_verified` | Deterministic local tests verified the stated behavior without a real external service or real Agent task. |
| `live_verified` | The exact behavior was exercised against a real installed runtime or service in the stated environment. |

## Capability matrix

| Capability | Execution path | Implementation | Verification level | Environment and scope | Evidence | Limitations |
| --- | --- | --- | --- | --- | --- | --- |
| Built-in TypeScript Runtime selection | Internal task → `AgentRuntime` → `ts-agent-loop` | `packages/server/src/agents/agent-runtime.ts`, `runtime-adapter.ts` | `fixture_verified` | macOS; adapter selection only | `runtime-adapter.test.ts`; targeted test passed 2026-09-16 | This audit did not submit a real model task or validate final delivery quality. |
| Built-in Python Runtime fallback | Internal task → `AgentRuntime` → Python subprocess | `packages/server/src/agents/agent-runtime.ts` | `implemented_unverified` | Source inspection only | Python fallback registration and subprocess implementation exist | No real Python Runtime task, cancellation, child-process cleanup, or recovery was run in this audit. |
| External Agent configuration | Dashboard/API → external Agent registry | `ExternalAgentsPanel.tsx`, `routes/external-agents.ts`, DB model | `fixture_verified` | Workspace-scoped create/update validation | `external-agent-routes.test.ts`; targeted tests passed 2026-09-16 | Configuration success does not prove that the selected CLI is authenticated or can complete a task. |
| Local workspace allowlist | Local CLI adapter | `assertLocalWorkdir()` | `fixture_verified` | Path validation only | `external-agent-adapters.test.ts` | This is path scoping, not a container, VM, filesystem sandbox, or OS permission boundary. |
| Codex CLI availability check | Local CLI `codex --version` | Profile command plus `healthCheck()` | `live_verified` | macOS arm64; availability/version only; Codex CLI `0.146.0` | Local version command returned successfully on 2026-09-16 | Authentication, task execution, tool visibility, cancellation, and recovery were not tested. |
| Claude Code availability check | Local CLI `claude --version` | Profile command plus `healthCheck()` | `live_verified` | macOS arm64; availability/version only; Claude Code `2.1.169` | Local version command returned successfully on 2026-09-16 | Authentication, task execution, tool visibility, cancellation, and recovery were not tested. |
| Gemini CLI profile | Local CLI `gemini -p` | Profile is defined in `CLI_COMMANDS` | `implemented_unverified` | Executable was not installed on the audited machine | Source inspection and `command -v` check | No availability or execution claim may be made for this machine. |
| OpenCode profile | Local CLI `opencode run` | Profile is defined in `CLI_COMMANDS` | `implemented_unverified` | Executable was not installed on the audited machine | Source inspection and `command -v` check | No availability or execution claim may be made for this machine. |
| Custom local CLI profile | Local CLI adapter | Validation explicitly rejects `custom_profile` | `not_implemented` | All environments | `LocalCliAgentAdapter.validate()` and fixture test | Requires a server-owned profile registry before it can be enabled safely. |
| Local CLI objective execution | `LocalCliAgentAdapter.execute()` → spawned CLI | `runCommand()` and profile arguments | `implemented_unverified` | Source inspection only | CLI is spawned with `shell: false`, a fixed profile command, and an allowlisted working directory | No real task was run. Authentication, interactive prompts, output quality, and side effects remain unknown. |
| Local CLI stdout/stderr and exit status collection | Spawned CLI process | Combined bounded output and exit-code mapping in `runCommand()` | `implemented_unverified` | Source inspection only | Output is capped at 512 KiB; zero/non-zero exits are mapped | stdout and stderr are merged; truncation is silent; no targeted process fixture currently proves all exit paths. |
| Local CLI timeout signal | Spawned CLI process | 15-minute timer sends `SIGTERM` | `implemented_unverified` | POSIX source path inspected | `runCommand()` timeout branch | Sending `SIGTERM` does not prove the process or its descendants exited. Windows semantics and escalation are unverified. |
| User-requested external CLI cancellation | Existing external Agent run | Empty `LocalCliAgentAdapter.cancel()` | `not_implemented` | All environments | `external-agent-adapters.ts` | There is no run-ID-to-process handle registry and no external run cancel route. |
| HTTP Agent endpoint validation | External HTTP adapter | HTTPS and allowed-host validation | `fixture_verified` | Local deterministic tests | `external-agent-adapters.test.ts` | This does not provide DNS pinning, network isolation, callback authentication, or a real endpoint verification. |
| HTTP Agent execution | POST to configured endpoint | `HttpAgentAdapter.execute()` | `implemented_unverified` | Source inspection only | 60-second request timeout, optional bearer credential reference, bounded response parsing | No real endpoint was called. Retry, idempotency, cancellation, callback trust, and artifact retrieval are unverified. |
| HTTP Agent cancellation | Existing HTTP Agent run | `HttpAgentAdapter.cancel()` intentionally does nothing | `not_implemented` | All environments | `external-agent-adapters.ts` | Adapter-specific cancellation protocol has not been defined. |
| Manual external Agent run persistence | API → `ExternalAgentRuntime.run()` → DB run row | External run is created before adapter execution and finalized afterward | `implemented_unverified` | Source inspection only | `external-agent-runtime.ts` | No real external task was submitted during this audit; server interruption behavior is unverified. |
| Cron and one-time scheduling | Schedule API → polling worker | Route validation, timezone-aware next run, atomic claim | `fixture_verified` | Deterministic worker tests | `external-agent-scheduler.test.ts`; targeted tests passed 2026-09-16 | A fixture runtime was used. Real CLI execution, machine sleep, restart catch-up, and overlapping long runs are unverified. |
| Internal task-event scheduling | Event bus → external Agent task-event worker | Workspace- and event-scoped dispatch | `fixture_verified` | Deterministic worker tests | `external-agent-scheduler.test.ts`; targeted tests passed 2026-09-16 | In-process events can be missed while the service is down; no durable event replay was verified. |
| Webhook scheduling | Schedule API | Route rejects webhook triggers | `not_implemented` | All environments | `external-agent-schedules.ts` | UI and public documentation must not present webhook triggers as available. |
| External CLI internal tool-call audit | External CLI stdout aggregation | No protocol-level event bridge exists | `not_implemented` | All local CLI profiles | Source inspection | Myrmecia can record the external run and combined output, but cannot claim visibility into every internal CLI tool call. |
| External run checkpoint resume | External Agent runtime | No external checkpoint/resume contract exists | `not_implemented` | All external adapters | Source inspection | Re-running an objective is not checkpoint recovery and may repeat side effects. |
| Service-restart recovery for active external runs | External Agent runtime | No persisted process identity or reconciliation path exists | `not_implemented` | All local CLI profiles | Source inspection | A process may become orphaned or a DB run may remain `running`; this requires a separate runtime-hardening design. |

## Tests executed

```text
pnpm --filter @myrmecia/server test -- external-agent-adapters.test.ts external-agent-routes.test.ts
Result: 2 files passed, 7 tests passed

pnpm --filter @myrmecia/server test -- external-agent-scheduler.test.ts runtime-adapter.test.ts
Result: 2 files passed, 11 tests passed
```

These tests establish fixture behavior only. They do not upgrade any real task
execution row to `live_verified`.

## Safe first experiment path

The first positioning and onboarding experiment should use the built-in
TypeScript Runtime unless a separate live verification explicitly approves an
external adapter. This keeps the product experiment independent from unfinished
external-process cancellation and restart recovery.

## Refresh checklist

Before publishing the capability matrix:

1. Select and record the implementation commit.
2. Re-run the targeted tests on a clean checkout.
3. Run one authorized, isolated task for each externally advertised profile.
4. Record profile version, platform, authentication mode, start/end time,
   output evidence, side effects, and cleanup result.
5. Keep cancellation, internal tool visibility, and recovery as separate rows.
