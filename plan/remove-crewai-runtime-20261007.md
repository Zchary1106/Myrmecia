# Remove the legacy CrewAI runtime

Date: 2026-10-07

The user explicitly requested removing Myrmecia's Python CrewAI Agent runtime.
This is separate from the failed agent-control-plane task; do not modify that
task or its contract. Do not remove system Python or user data.

## Context map

| Files | Purpose | Required change |
| --- | --- | --- |
| `packages/server/src/agents/agent-runtime.ts` | Built-in adapters and Python subprocess/event bridge | Remove Python adapter, bridge, and Python-only helpers/imports; retain governance |
| `packages/server/src/agents/runtime-adapter.ts` | Adapter selection | Default all built-in Agents to TS, preserve extension priority, reject retired Python override clearly |
| `packages/server/src/tools/tool-registry.ts` | Tool implementation metadata | Point supported tools to actual TS implementations; check persisted seeding behavior |
| `packages/python-runtime/**` | Legacy CrewAI package | Remove tracked runtime sources and dependency manifests |
| `scripts/start.sh`, `start.ps1` | Local launchers | Remove mandatory Python checks/install options and CrewAI dependency setup |
| `Dockerfile`, `docker/sandbox/Dockerfile` | Container dependencies | Remove CrewAI and legacy runtime copying/installing; preserve independent sandbox boundaries |
| `packages/desktop/src/main.ts`, `packages/desktop/package.json` | Desktop resource paths, environment and diagnostics | Remove Python runtime packaging and CrewAI/Python-only checks |
| `.github/workflows/desktop-build.yml` | Build triggers | Remove deleted runtime path |
| `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `docs/ARCHITECTURE.md`, `docs/DESKTOP-ELECTRON.md`, `examples/README.md` | Current setup and architecture | Document the TS-only built-in runtime accurately |
| `packages/server/src/load-env.ts` | Environment-loading comment | Update stale executor explanation if necessary |
| `packages/server/tests/runtime-adapter.test.ts`, `packages/server/tests/agent-runtime-contract.test.ts` | Selection and lifecycle regressions | Cover tool-free, tool-enabled and MCP Agents, different providers, extensions and removed override |
| `packages/server/tests/tool-runtime.test.ts`, `packages/server/tests/tool-sandbox.test.ts`, `packages/server/tests/external-agent-adapters.test.ts` | Tools and external adapters | Reuse existing targeted regression coverage |

Dependencies: `ts-agent-loop.ts` already builds sandbox/MCP tool definitions,
executes tools, streams text and enforces Agent run limits; `gateway.ts` already
supports OpenAI-compatible and Copilot providers. External HTTP/CLI Agents use
their own adapter layer and must remain intact.

Reference patterns: TS-only tools already point to
`packages/server/src/skills/tool-sandbox.ts:executeTool`; external adapter
registration must stay ahead of the universal TS fallback.

Risks: changing the `AGENT_EXECUTOR=python` configuration is intentional and
must produce an actionable error, not silently use a different runtime. No
database migration or user-data deletion is authorized. Historical comparison
text mentioning CrewAI as another project can remain; operational instructions
must not require it. Independent Python utilities are out of scope.

Review this context map against source before implementing. Complete this
bounded removal task; do not implement the pending control-plane epic.

## Verification

1. Tests prove TS selection for every built-in tool/provider combination,
   registered adapters retain priority, `ts` override works, and removed Python
   overrides fail with a helpful message.
2. Runtime lifecycle, stop/cancellation and tool/external-adapter regressions.
3. Shared/server builds and desktop TypeScript checks where configured.
4. Shell launcher syntax, package JSON parsing, `git diff --check`, and scan
   active setup/config/packaging for legacy runtime references.
5. No real model requests, social publishing, live MCP writes, releases,
   commits, pushes, or modifications of runtime data.

## Local delivery checkpoint

Implemented in the current workspace after the independent WorkAgent dispatch
failed without delivering code. Final server regression: 805 passed, 1 skipped,
0 failed; shared/server/desktop builds or typechecks and whitespace checks
passed. Detailed boundaries are in
`artifacts/remove-crewai-verification-20261007.md`. The failed WorkAgent task and
the earlier control-plane task remain unchanged; this is local verification,
not a persisted WorkAgent Completion.
