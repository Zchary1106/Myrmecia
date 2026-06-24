# Reviews — sample pipeline run artifacts

This folder collects the **stage outputs of a sample pipeline run** (the
`full-product` flow), kept as reference examples. Each subfolder is one stage and
holds that stage's `output.md` (plus a `test-report.json` where the stage runs tests).

These are **generated artifacts**, not source — the application does not read from
here. They illustrate what an end-to-end run produces, stage by stage:

| Order | Folder | Stage |
| --- | --- | --- |
| 0 | [`stage-0-spec`](stage-0-spec/) | Product spec / clarification |
| 0 | [`stage-0-triage`](stage-0-triage/) | Triage |
| 1 | [`stage-1-code`](stage-1-code/) | Implementation |
| 1 | [`stage-1-fix`](stage-1-fix/) | Fixes |
| 2 | [`stage-2-qa-loop`](stage-2-qa-loop/) | QA loop (with test report) |
| 2 | [`stage-2-test`](stage-2-test/) | Test (with test report) |
| 3 | [`stage-3-review`](stage-3-review/) | Review |

> Live runs write to ephemeral workspaces under `.agent-factory/workspaces/`
> (git-ignored); the files here are a committed snapshot for reference.
