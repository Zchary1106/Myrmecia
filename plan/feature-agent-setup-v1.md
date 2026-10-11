---
goal: Reliable Agent creation, read-only capability preflight and inline test-run inspection
version: 1
date_created: 2026-10-11
last_updated: 2026-10-11
owner: Myrmecia
status: Completed
tags: [agent, onboarding, verification]
---

# Agent setup batch one

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Implementation and deterministic local regression completed. Browser visual,
real-provider and real-Redis acceptance are not included in this completion.

## 1. Requirements & Constraints

- **REQ-001**: Persist actor/workspace-scoped creation and test-run idempotency. Identical retries reuse the same entity; changed payloads return 409.
- **REQ-002**: Separate creation, Skill binding and test dispatch progress. Preserve the created Agent after later-step failure.
- **REQ-003**: Preflight selected model, Skill and tool policy using local registry/connection/cache facts. Unknown authentication is not success. No model generation, login or publication during preflight.
- **REQ-004**: Show the test request, actual recipient/model, Markdown output, tool messages, lifecycle, errors and acceptance separately inside the wizard.
- **SEC-001**: Preserve current role authorization, tenant boundaries, MCP governance and runtime policy; no credentials in responses.
- **CON-001**: Preserve existing uncommitted changes. No commit, push, dependency installation, provider switch or live side-effect test.
- **PAT-001**: Reuse ToolPolicy, TaskQueue, execution messages and MarkdownMessage.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Add deterministic backend contracts and durable request deduplication.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add shared preflight type and additive request table; implement scoped transactional deduplication in server setup module. | Yes | 2026-10-11 |
| TASK-002 | Add authorized preflight and idempotent test-run endpoints; reuse existing queue dispatch for already-created tasks. | Yes | 2026-10-11 |

### Implementation Phase 2

- **GOAL-002**: Complete the creation/debugging UI without leaving the wizard.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Update dashboard API and wizard with retained creation identity, step-specific retry and save-only path; add preflight panel. Depends on TASK-002. | Yes | 2026-10-11 |
| TASK-004 | Add inline debugger with scoped polling, existing streamed content, Markdown, collapsed tool activity and truthful acceptance labels. Depends on TASK-003. | Yes | 2026-10-11 |
| TASK-005 | Test HTTP deduplication/reopen/isolation/policy and React partial failures, live-state changes and Markdown; run builds and relevant regressions. Depends on TASK-004. | Yes | 2026-10-11 |

## 3. Alternatives

- **ALT-001**: Client-only duplicate-click protection is insufficient after network response loss; use durable server records.
- **ALT-002**: Automatically probe every MCP/model would contend with live tasks and could consume quotas; use local evidence and label unverified state.

## 4. Dependencies

- **DEP-001**: Existing SQLite driver transactions, TaskQueue, model registry, tool policy, execution routes and dashboard WebSocket store.

## 5. Files

- **FILE-001**: `packages/server/src/agents/agent-setup.ts`, `routes/agents.ts`, `db/schema.sql`, `db/models/agent.ts`, `queue/task-queue.ts`.
- **FILE-002**: `packages/shared/src/agent-setup.ts` and `index.ts`; dashboard API, AgentSetupWizard, AgentSetupDebug.
- **FILE-003**: Server setup HTTP tests and dashboard setup/debug interaction tests.

## 6. Testing

- **TEST-001**: Identical concurrent/reopened requests reuse entity; conflicts and different actors/workspaces are isolated.
- **TEST-002**: Model disabled, disconnected MCP, approval, unknown login and Skill absence remain explicit; preflight cannot dispatch tools.
- **TEST-003**: Failed Skill/test steps retry without creating another Agent; stopped outputs do not animate; no false acceptance.

## 7. Risks & Assumptions

- **RISK-001**: Preflight is a point-in-time local snapshot, not real provider/MCP entitlement proof.
- **RISK-002**: Queue dispatch and database transactions are separate; retry dispatch only the same persisted task with queue/ownership guards.
- **ASSUMPTION-001**: Agent configuration remains a reusable template; no universal runtime replacement in this batch.

## 8. Related Specifications / Further Reading

See `plan/fix-pause-and-orchestration-state-20261010.md` and `docs/AGENT-RUNTIME-V2.md`.

WorkAgent submission tool discovery returned no task tools. This is a local
implementation plan, not a registered WorkAgent task or completion approval.

## Local verification report

- Server full regression: **965 passed, 5 opt-in skipped**, 143 files passed and
  one opt-in file skipped. A prior full run passed 963 tests before the two
  additional queue-scope/instant-worker cases were added.
- Dashboard full regression: **192 passed, 14 files**.
- Affected server verification: **78 passed, four files**, including 13 new
  setup HTTP/policy/queue tests. Dashboard includes 16 new setup/debug tests.
- Shared, server and dashboard builds/typechecks passed; final whitespace check
  passed. Final theme-token-only changes were followed by dashboard verification.
- Real normal-server preflight HTTP 200: an invalid model and unconfirmed
  Xiaohongshu login were blocking while a discovered MCP tool was separately
  shown as connected. No generation/login/tool execution was performed.
- Normal readiness HTTP 200, zero running executions, and Vite serves the
  updated wizard. No service restart, user test dispatch or task cancellation.
- The idempotency table is additive (`CREATE TABLE IF NOT EXISTS`); existing
  tasks, Agents, model/permission settings and unrelated source changes remain.

### Boundaries

Preflight uses local facts and at most five-minute model health records; it does
not prove current model entitlement or network access. Copilot authentication
is explicitly unknown without an actual request; Xiaohongshu missing/expired
login cache blocks testing until Home refreshes its existing login mechanism.
No automatic login, credential mutation or permission grant is added.

Client setup identity survives close/reopen while the wizard remains mounted.
Full browser reload recovery of an unfinished wizard is not implemented; the
server reuses any retry that presents the original scoped idempotency key.
A test dispatch replay never creates another task or automatically restarts a
terminal attempt. A new user-authorized task can be submitted from the full
conversation after inspecting the failure.

The inline debugger reads all execution-message pages and reuses streaming
store updates, presents scoped artifact metadata, and links to the existing
artifact viewer. It does not add a new artifact renderer or invent verification.
Close does not cancel a submitted run. Generic dynamic verification rubrics,
Agent configuration versioning and persistent wizard drafts belong to later
batches.

No native browser or real-provider/MCP run was accepted as verified. Browser
tool discovery did not expose the requested DevTools tools; no browser-policy
workaround was used. Redis timing is covered by a deterministic queue fixture,
not a live Redis restart test. PostgreSQL acceptance was not run.

No Git commit, push, PR, merge, package release or external publication.
