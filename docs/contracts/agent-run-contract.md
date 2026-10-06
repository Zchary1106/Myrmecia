# Agent Run contract

`TaskExecution.runState` is a versioned execution contract. Absence means an
unverified historical run, not a successful validation or human acceptance.

## State and completion

- Task status remains compatible with existing consumers.
- Run phase explains what the executor is doing: starting, deciding, acting,
  observing, validating, waiting for a tool/user, completed, failed, cancelled,
  or interrupted.
- A terminal Run cannot re-enter execution. Follow-up creates a new Task/Run.
- `stopReason` distinguishes normal completion from max-turn limits, token/cost
  budgets, deadlines, unavailable tools, truncation, empty output, cancellation
  and interruption.
- `validation.scope = output` describes deterministic output integrity only.
  It is not proof of factual correctness, file tests or a Workflow quality gate.
- Human `acceptance` begins pending. The acceptance endpoint requires operator
  authority and cannot accept an incomplete/invalid run. Conflicting reviews
  require a new revision, not mutation of prior evidence.

## Clarification protocol

A direct Agent can return:

```json
{"kind":"myrmecia.request_input","question":"Please provide the target document."}
```

The runtime displays the question normally, puts the Task in review and the Run
in waiting-for-user, and does not mark the goal complete. The main composer
creates a fresh continuation. Pipeline approval gates remain separate.

## Execution recovery and tools

Ordinary read-only TS loops may recover a compatible stable-turn snapshot.
Tool messages/results and budgets are retained. A model request interrupted
before reporting usage is charged a conservative token reservation.

The queue owns retries for queued dispatches; standalone self-healing cannot
start another execution simultaneously. Cancelled tasks stay cancelled.

Write-capable or unknown tools are journaled before TS dispatch, using canonical
arguments. Repeating the same Task/tool/input is blocked, including after
timeout. A new task is a new user action, not reuse of an old approval.

Python and external runtimes expose capability limits honestly. A missing Python
final result event is not success. Local HTTP cancellation is not remote undo.

Tool errors include a machine-readable code, retryability and whether the
external outcome may be unknown. Remote requests receive cancellation
notifications where supported; late responses cannot commit a cancelled Run.

## Chat and knowledge

- Messages have persisted numeric IDs and replay in sorted, deduplicated pages.
  REST cursors are separate from live arrivals to avoid skipping missing messages.
- Socket reconnection replays durable state; intentional disconnect does not
  schedule reconnection or accept stale socket events.
- Generated episodes enter knowledge as unverified candidates. They do not
  automatically overwrite confirmed facts or enter Agent recall.
- Recall respects workspace, validity, expiry and revocation, includes source
  IDs, and explicitly treats memory as reference rather than authorization.
- Cache keys include workspace to prevent cross-workspace response reuse.

## External Agents

HTTP/CLI Runs bridge into normal Task/Execution conversations and carry the
external Agent name, stop reason, output validation and pending acceptance.

`POST /api/v1/external-agents/:id/runs/:runId/result` accepts an authenticated
operator's terminal callback result. A recorded remote run ID must match.
Duplicate identical terminal results are idempotent; conflicting late results
are rejected. Remote artifact IDs alone are not verified deliverables.

Callback waiting has a persisted deadline (15 minutes by default, configurable
with `MYRMECIA_EXTERNAL_CALLBACK_TIMEOUT_MS`, capped at one day). Server restart
re-arms the deadline without repeating dispatch. A timed-out remote write has an
unknown outcome and requires inspection; it is never automatically replayed.

For attached local executions, normal chat cancellation forwards to the
external runtime. Detached callback jobs report cancellation unsupported rather
than claiming the remote operation stopped.

CLI workdir checks use real filesystem paths to reject symlink escapes. Native
CLI prompts include invocation constraints; these are advisory to that external
runtime, not equivalent to the built-in sandbox's tool policy. Child environments
retain CLI/provider essentials rather than copying server/database/MCP secrets.

External adapters do not accept live mailbox instructions unless they implement
that capability. After settlement, the main composer creates a new invocation
of the same external Agent with bounded reference history and fresh user input;
it does not silently switch the conversation to Master or reopen the old run.
Manual external calls cannot attach themselves to a Pipeline stage or Master
coordination task to bypass its governed dispatcher.
