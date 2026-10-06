---
title: "Myrmecia Product Onboarding Acceptance"
status: "In progress"
created_on: "2026-09-16"
---

# Myrmecia Product Onboarding Acceptance

This document replaces external user interviews as the current completion
gate. The active goal is to make the repository, Demo, Home, Task Session, and
delivery evidence internally coherent and reproducibly testable.

Passing this document proves project behavior in the tested environment. It
does not prove market demand or user retention.

## Acceptance environments

| Environment | Required state | Purpose |
| --- | --- | --- |
| Fresh local | Empty isolated database, no existing browser storage | Verify the true first-run experience |
| Demo | `pnpm demo` with the dedicated Demo database | Verify zero-model exploration and sample-data labeling |
| Live ready | Valid configured model route and built-in TypeScript Runtime | Verify a real task path without unfinished external process control |
| Live unavailable | API available but model or required Runtime unavailable | Verify truthful readiness and recovery guidance |
| Refresh/restart | Existing task and execution persisted across browser refresh; service restart tested where supported | Verify that the user can return to work |

Never point acceptance runs at an existing user database. Record the database
path, commit, browser URL, platform, and model route without recording secrets.

## A. Fresh Home

- [ ] Home renders without an uncaught exception or endless loading state.
- [ ] The page identifies the current mode as `Demo`, `Live ready`, or
  `Configuration required`.
- [ ] API health is not presented as proof that a model, MCP server, or
  external CLI is ready.
- [ ] The primary composer states who will receive the request before submit.
- [ ] Team/Agent selection uses the primary composer rather than requiring a
  second task-description popover.
- [ ] Existing sessions are discoverable and switchable.

Evidence: desktop screenshot at 1280 px, narrow screenshot at 390 px, browser
console result, and the exact URL.

## B. Demo path

- [ ] `pnpm demo` starts with the isolated Demo database.
- [ ] No model credential is required.
- [ ] No model request is emitted while browsing seeded data.
- [ ] Every seeded task/result surface displays a visible `Demo data` label.
- [ ] Home links to at least one completed sample session with Agent ownership,
  result, artifacts, and verification visible.
- [ ] Demo cleanup cannot remove the normal user database.

## C. Live readiness

- [ ] Home shows the selected model route and built-in Runtime independently
  from API health.
- [ ] Missing model configuration produces one actionable recovery path.
- [ ] Unavailable MCP or external Agent connections do not block an unrelated
  built-in task.
- [ ] External Agent profiles display their verified capability scope rather
  than a generic `Connected` claim.

## D. First task

- [ ] The request is created exactly once.
- [ ] Before execution, the UI identifies the receiving Agent, Team, or
  Workflow.
- [ ] Queued, routing, running, waiting, failed, cancelled, and done states are
  visually distinguishable.
- [ ] The user can open the Task Session directly from Home.
- [ ] Refreshing the browser does not create a duplicate task.

The initial real acceptance task must use the built-in TypeScript Runtime until
an external execution path has separate live cancellation and cleanup
verification.

## E. Task Session conversation

- [ ] User requests and Agent responses use distinct chat presentation.
- [ ] The responsible Agent is named on every substantive response or grouped
  response section.
- [ ] Streaming text remains readable while incomplete.
- [ ] Markdown headings, lists, links, tables, code blocks, and inline code
  render correctly.
- [ ] Tool calls are collapsed by default and can be expanded.
- [ ] Raw internal JSON is transformed into a user-facing result when a known
  result schema exists.
- [ ] The primary composer remains available for a follow-up after success or
  recoverable failure.
- [ ] A follow-up continues the selected session instead of silently creating
  an unrelated session.

## F. Delivery evidence

- [ ] The final result is visible without opening the technical timeline.
- [ ] Changed files or generated artifacts are listed and can be opened.
- [ ] Verification commands and their actual exit results are visible.
- [ ] Missing evidence is labeled `Not available` or `Not verified`, never
  implied by an Agent success message.
- [ ] Human acceptance, request-changes, and retry actions are distinct.
- [ ] The accepted result links back to its task, execution, Agent, model, and
  Runtime.

## G. Failure and recovery

- [ ] Model failure, tool failure, timeout, concurrency limit, and external
  service failure have different messages.
- [ ] The message explains whether work can be retried, continued, or requires
  configuration.
- [ ] Retrying does not duplicate an already completed side effect in the
  tested scenario.
- [ ] A failed external integration does not leave the entire Home page
  blocked.
- [ ] Unsupported external cancellation is not shown as a working button.

## H. Persistence

- [ ] Browser refresh preserves the selected session and current task.
- [ ] Server restart reconciles persisted internal tasks according to the
  documented recovery behavior.
- [ ] External runs that cannot be reconciled are labeled unknown or orphaned,
  not completed.
- [ ] Demo and live databases cannot be confused after restart.

## Automated checks

The implementation must add or extend tests so each automated assertion maps
to one acceptance item above.

```bash
pnpm --filter @myrmecia/dashboard test
pnpm --filter @myrmecia/dashboard test:e2e
pnpm --filter @myrmecia/server test
pnpm lint
pnpm build
```

The completion report must record actual commands, exit codes, test counts,
screenshots, and residual unverified items. A build pass alone does not complete
this acceptance.

## Completion rule

Project onboarding is complete only when:

1. all A–G required items pass in their applicable environment;
2. H passes for internal tasks and truthfully labels unsupported external
   recovery;
3. Demo and one isolated real task are both verified;
4. browser screenshots and E2E evidence match the implementation commit;
5. remaining external Runtime gaps stay explicit in the capability matrix.
