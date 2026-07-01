# Myrmecia examples

A guided tour of how to actually *use* Myrmecia — from a one-line request to a
full multi-agent pipeline that writes and tests real code.

Each example is copy-paste runnable. Example 01 is a **real artifact the harness
generated end-to-end** (committed verbatim); the rest are runnable recipes you
can fire against your own model endpoint.

---

## Prerequisites

Myrmecia runs agents against any OpenAI-compatible model endpoint. Set these in a
root `.env` (git-ignored) before running the live recipes:

```bash
AGENT_FACTORY_BASE_URL=https://your-openai-compatible-endpoint/v1
AGENT_FACTORY_API_KEY=your-api-key
AGENT_FACTORY_MODEL=claude-haiku-4.5      # any model your endpoint serves
AGENT_EXECUTOR=ts                          # use the built-in TypeScript agent loop
```

Then start the platform (server + dashboard):

```bash
pnpm install
pnpm dev
# API: http://localhost:3000   ·   Dashboard: http://localhost:5173
```

> No endpoint yet? Run `pnpm demo` first — it seeds a deterministic, no-API-key
> demo so you can explore the dashboard, pipelines, teams, memory, cost, and
> audit views with realistic data.

---

## Example 01 — Generated CLI (real artifact) ✅

[`01-json2csv-cli/`](01-json2csv-cli/) — a JSON→CSV CLI with 12 passing tests,
**written end-to-end by a Myrmecia `Feature` pipeline** (PM → Dev → QA → Review).

```bash
cd examples/01-json2csv-cli && npm install && npm test   # 12/12 pass
```

See [`01-json2csv-cli/README.md`](01-json2csv-cli/README.md) for the exact
command that generated it.

---

## Runnable recipes

All of these use the `myrmecia` CLI (`pnpm cli …`), which drives the same server
the dashboard uses. Add `--json` for machine-readable output, or watch it live in
the dashboard.

### A. One agent, one task (Direct)

Assign a task straight to a specialist and stream its work:

```bash
pnpm cli run dev "Write a TypeScript function that debounces an async function, with tests"
```

### B. A one-line request (Supervisor)

Let the supervisor classify the intent and route it automatically:

```bash
pnpm cli ask "Add a dark-mode toggle to the settings page, with tests"
```

### C. A full pipeline (PM → Dev → QA → Review)

Run a fixed, gated delivery flow. Each stage's output feeds the next; the dev
stage writes real files into an isolated workspace:

```bash
pnpm cli pipeline Feature "Build a URL-slug utility library with unit tests"
pnpm cli pipeline Bugfix  "Settings fail to save when the workspace name has spaces"
```

Browse the built-in templates and stages:

```bash
pnpm cli templates
```

### D. A whole squad (Agent Teams)

Address a named team; the lead splits the goal across the roster and teammates
run in parallel on a shared board:

```bash
pnpm cli @feature "Add a profile page with avatar upload"
pnpm cli teams        # list the squads
```

### E. Web research with citations

With `WEB_TOOLS_ENABLED=true`, a researcher can search/fetch/extract and cite
sources:

```bash
pnpm cli run researcher "Compare SQLite vs Postgres for a local-first app; cite sources"
```

### F. Domain specialist (Domain Packs)

Bind a persona + your own knowledge base to agents, then run tasks grounded in
*your* material with `[n]` source citations. Configure a domain on the dashboard
**Domains** page, then:

```bash
pnpm cli run pm "Summarize our refund policy for a new support agent"   # routed to the bound domain specialist
```

---

## Where the output goes

- **Streamed** live in the CLI and the dashboard (tasks, pipelines, teams).
- **Code artifacts** are written into an isolated workspace under
  `.agent-factory/workspaces/<pipelineId|taskId>/` (a git worktree of your repo).
- **Every decision** is recorded: run traces (`/api/v1/executions/:id/trace`),
  the decision ledger (`/api/v1/executions/:id/ledger`), cost, and audit.

## Honesty note

Myrmecia genuinely runs agents that write and test real code. Output quality
depends on the model you point it at, and some built-in skills (e.g. the strict
TDD "red phase" gate) can be tuned for your workflow. Treat generated code as a
strong first draft to review — exactly what the built-in Review stage is for.
