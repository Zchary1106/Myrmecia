---
title: "Myrmecia Onboarding Discovery and Feedback"
status: "On Hold"
created_on: "2026-09-16"
---

# Myrmecia Onboarding Discovery and Feedback

External interviews are not part of the current implementation scope. This
template is retained for a possible future validation round and must not block
project work. It contains no participant results; empty results remain unknown
rather than being recorded as zero or inferred from repository traffic.

## Target participant

A participant is in scope when all of the following are true:

- they use a coding Agent such as Codex, Claude Code, Gemini CLI, OpenCode, or
  an internal Agent on a real software project;
- they have needed to inspect, hand off, resume, or verify Agent work;
- they are willing to discuss one recent workflow or try one small,
  non-sensitive task;
- they consent to anonymous notes and, separately, to any follow-up.

People who only viewed an AI demo but have not used an Agent on a real project
may provide general feedback, but they are not counted in the first target-user
cohort.

## Consent script

> We are evaluating whether Myrmecia helps developers coordinate and verify AI
> Agent work. I will record anonymous workflow notes, not your task text,
> source code, credentials, company name, or environment variables. You may
> skip any question or stop at any time. May I record anonymous notes? May I
> contact you once for a follow-up?

Record the two answers separately. Do not publish participant-level notes.

## Interview questions

### Current workflow

1. Which coding Agents do you use on real projects?
2. Describe the most recent task that involved more than one step or handoff.
3. How do you know which Agent currently owns the next step?
4. Where do you look for changed files, generated artifacts, logs, and tests?
5. What happens when the Agent says the task is complete but the result is not
   acceptable?
6. How do you continue a task after a failed run, terminal closure, or service
   restart?

### Alternatives and installation reason

7. Which current tools already solve parts of this problem?
8. What would Myrmecia need to do better than a terminal, GitHub, or a task
   tracker to justify another local service?
9. Which is more valuable: coordinating several Agents, seeing one Agent's
   execution evidence, scheduling work, or reviewing delivery?
10. What would make you refuse to install or connect it?

### Comprehension check

After showing only the proposed title and one-sentence description, ask:

11. In your own words, what does Myrmecia do?
12. Is the shown experience sample data, a real task, or unclear?
13. What would you click first?
14. What output would you expect before accepting a task as complete?

Do not correct the participant before recording their first answer.

## Optional task trial

Use only a participant-approved, non-sensitive task. Record:

- whether the participant opened the zero-install preview;
- whether they started the local Demo;
- whether they started a real task themselves;
- whether they identified the assigned Agent or workflow;
- whether they found the changed files or artifacts;
- whether they found the test or verification evidence;
- whether they accepted, rejected, or requested changes;
- the first blocking step;
- how much operator assistance was required.

Opening the page is not task completion. An operator rerun is not participant
reuse.

## Participant record

| Participant | In-scope target user | Anonymous notes consent | Follow-up consent | Existing Agent workflow | Understood purpose | Understood Demo boundary | Started real task | Verified delivery | Started a different second task | First blocker | Assistance level | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | — | — | — | — | — | — | No participants recruited |

Allowed values:

- consent: `yes`, `no`, `not_asked`;
- result fields: `yes`, `no`, `unknown`, `not_attempted`;
- assistance: `none`, `prompt_only`, `guided`, `operator_completed`;
- status: `invited`, `interviewed`, `trial_started`, `follow_up_due`,
  `complete`, `declined`.

## Aggregate report

Report actual denominators:

| Metric | Numerator | Denominator | Result |
| --- | ---: | ---: | --- |
| Accurately understood the purpose | unknown | 0 | unknown |
| Correctly identified Demo versus live execution | unknown | 0 | unknown |
| Started a real task | unknown | 0 | unknown |
| Verified a delivery | unknown | 0 | unknown |
| Proactively started a different second task | unknown | 0 | unknown |

## Decision rules

- If fewer than three in-scope users are interviewed, keep positioning marked
  as a hypothesis and continue recruitment without expanding product scope.
- If fewer than half can explain the product after seeing the title and
  description, revise positioning before rebuilding the full README.
- If users understand the product but cannot start a task, prioritize
  onboarding and configuration.
- If users start tasks but cannot identify ownership or evidence, prioritize
  Task Session and delivery presentation.
- If users complete one task but do not return, investigate installation value,
  task fit, and replacement by existing tools before adding more Agent types.
- Use the first 14 days for comprehension and first-delivery activation. Check
  proactive second use again by day 30; do not force a second task to satisfy
  the metric.
