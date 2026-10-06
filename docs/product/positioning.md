---
title: "Myrmecia Product Positioning"
status: "In progress"
created_on: "2026-09-16"
evidence_status: "Static repository audit complete; project acceptance pending"
---

# Myrmecia Product Positioning

This positioning is the current product direction. It must be supported by
repository behavior, a reproducible Demo, one isolated real task, and browser
acceptance. External user interviews are not a current completion gate, and no
market-demand claim is made.

## Positioning statement

Myrmecia is a self-hosted task and delivery workspace for developers who use
AI Agents on real software projects and need to see who owns the work, what was
actually produced, and which verification evidence is available before
accepting the result.

## Primary target user

Developers and small technical teams who:

- already use at least one coding Agent;
- run multi-step tasks or hand work between specialist roles;
- need persistent task history, ownership, artifacts, tests, or review;
- prefer a local or self-hosted control plane.

The first validation cohort is not “everyone using AI” and is not primarily
social-content creators, enterprise compliance buyers, or teams that only need
a single chat window.

## Job to be done

> When an AI-assisted software task spans several steps or Agents, help me
> assign the work, follow ownership and execution, inspect the actual delivery,
> and decide whether to accept or continue it without reconstructing the run
> from multiple terminals.

## Core product promise

1. **Coordinate the work** — assign a task and see the responsible Agent or
   workflow.
2. **Inspect the run** — follow execution history and available operational
   evidence.
3. **Review the result** — inspect artifacts, file changes, and verification
   results before accepting delivery.

The product must say “available evidence” rather than imply that every external
CLI exposes every internal tool call.

## Proposed public copy

### README H1

> Myrmecia — Run AI agent teams from one dashboard

### Supporting line

> Assign tasks, coordinate specialist agents, inspect execution history, and
> review results in a self-hosted workspace.

### Differentiation line

> Coordinate the agents. Inspect the work they deliver.

### Chinese

> Myrmecia：在一个自托管工作台里分配任务、组织专业 Agent
> 协作、查看执行记录并审查交付结果。

## Why install another workspace

The current installation reasons must be demonstrated by project acceptance:

- one place to see task ownership across built-in and supported external
  Agents;
- persistent run history after individual terminal sessions end;
- delivery views that connect Agent output with artifacts and verification;
- scheduled or event-triggered external Agent work;
- local-first operation without a mandatory hosted control plane.

Myrmecia should not lead with “more Agents”. It must demonstrate less ambiguity
and better delivery verification than the user's existing workflow.

## Alternatives

| Alternative | What it already does well | Myrmecia must prove |
| --- | --- | --- |
| A single coding Agent terminal | Fast direct interaction and strong coding ability | Persistent coordination and delivery review justify the extra service |
| Several terminal tabs | Flexible and familiar | Ownership, history, scheduling, and evidence are easier to understand |
| GitHub issues and pull requests | Durable work and code review | Agent execution and intermediate handoffs are visible before the final PR |
| CI dashboards | Reliable automated verification | Task intent, Agent ownership, artifacts, and CI evidence are connected |
| General task trackers | Human planning and assignment | Agent-native execution and output inspection reduce manual reconstruction |

## Explicit boundaries

Until separately verified, public copy must not claim:

- complete internal tool-call visibility for external CLIs;
- reliable user-requested cancellation of external CLI or HTTP Agents;
- checkpoint resume for external Agents;
- service-restart recovery for active external processes;
- container- or OS-level isolation from a workspace path allowlist;
- lower cost, faster completion, higher success rate, or automatic continuous
  improvement.

The built-in Runtime and the external Agent manager are distinct execution
paths and must be described separately.

## First real-case selection criteria

The first published case should:

- start from a frozen public commit without the answer;
- require at least two responsibility boundaries, such as diagnosis,
  implementation, and verification;
- produce inspectable file changes or artifacts;
- include a failing-before and passing-after regression check;
- include at least one human acceptance decision;
- fit within an authorized 30–90 minute execution budget;
- avoid private data, credentials, irreversible side effects, and artificial
  failures created only for marketing.

A server-side validation defect plus a corresponding UI error-state change and
regression tests is a stronger candidate than a one-file formatting exercise.
The JSON-to-CSV example remains an engineering smoke test rather than the
primary differentiation case.

## Validation gates

This document can move to `Project validated` only when:

1. the capability matrix is refreshed on the selected implementation commit;
2. the isolated Demo path passes without a model request;
3. at least one isolated real task produces reviewable delivery evidence;
4. the advertised execution path matches the capability matrix;
5. the README and in-product onboarding do not confuse Demo data with live
   execution;
6. `docs/product/onboarding-acceptance.md` passes with browser and E2E
   evidence.

This status means the product behavior was verified in the recorded
environment. It does not claim market validation, adoption, or retention.
