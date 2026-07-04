# Contributing to Myrmecia

Thanks for your interest in improving Myrmecia! This guide covers how to set up,
develop, test, and submit changes.

By participating, you agree to keep interactions respectful and constructive.

## Prerequisites

- **Node.js ≥ 20**
- **pnpm ≥ 9** (auto-provisioned by the launcher via corepack)
- **Python 3** (optional — only needed to run live agents via the Python runtime)

## Quick setup

One command installs everything, builds shared types, and starts the API + dashboard:

```bash
# macOS / Linux
git clone https://github.com/Zchary1106/Myrmecia.git && cd Myrmecia && ./start.sh
```

```powershell
# Windows (PowerShell)
git clone https://github.com/Zchary1106/Myrmecia.git; cd Myrmecia; ./start.ps1
```

Or step by step:

```bash
pnpm install
pip install -r packages/python-runtime/requirements.txt   # optional, for live agents
pnpm dev                                                   # API :3000 + dashboard :5173
```

No model API key is needed to explore — run `pnpm demo` for a seeded, deterministic dashboard.

## Project layout

This is a **pnpm monorepo** (`"type": "module"` / ESM everywhere):

| Path | What it is |
|------|------------|
| `packages/server` | `@myrmecia/server` — Express 5 + TypeScript orchestrator (agents, memory, pipelines, graph/dynamic workflows, queue, MCP, REST + WebSocket) |
| `packages/dashboard` | `@myrmecia/dashboard` — React 19 + Vite + Tailwind control center |
| `packages/cli` | `@myrmecia/cli` — command-line client |
| `packages/shared` | `@myrmecia/shared` — TypeScript types shared across packages |
| `packages/python-runtime` | Python agent runtime (spawned as a subprocess) |
| `agents/` | Agent registry (`registry.yaml`) + skill markdown |
| `templates/` | Pipeline templates |

## Development workflow

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Dev (server + dashboard) | `pnpm dev` |
| Server only | `pnpm dev:server` |
| Dashboard only | `pnpm dev:dashboard` |
| Build all | `pnpm build` |
| Type-check / lint | `pnpm lint` (each package runs `tsc --noEmit`) |
| Server tests | `pnpm --filter @myrmecia/server test` |
| One server test file | `pnpm --filter @myrmecia/server exec vitest run tests/<file>.test.ts` |
| One test by name | `pnpm --filter @myrmecia/server exec vitest run tests/<file>.test.ts -t "<name>"` |
| Dashboard tests | `pnpm --filter @myrmecia/dashboard test` |
| Dashboard E2E | `pnpm --filter @myrmecia/dashboard test:e2e` (start the app first) |

Before opening a PR, please make sure these pass locally:

```bash
pnpm lint
pnpm build
pnpm --filter @myrmecia/server test
pnpm --filter @myrmecia/dashboard test
```

## Coding conventions

- **ESM imports** resolve local TypeScript modules with `.js` extensions, e.g.
  `import { getTask } from '../db/models/task.js'`.
- **Database is snake_case; models are camelCase** — go through the existing DB model
  helpers (`createTask`, `updateTask`, `listAgents`, …) rather than raw SQL, so JSON
  parsing and case mapping stay consistent.
- **REST errors** are shaped as `{ error: { code?, message } }`; the dashboard's
  `src/lib/api.ts` depends on that shape.
- Dashboard imports may use the `@/*` alias (maps to `src/`).
- Keep changes focused; add or update tests for behavior you change. Only comment
  code that genuinely needs clarification.

## Commit & pull-request process

1. Branch from `main` (e.g. `fix/...`, `feat/...`, `docs/...`).
2. Use clear, conventional commit messages (`fix:`, `feat:`, `docs:`, `refactor:`, `chore:`).
3. Ensure lint, build, and tests pass; add regression tests for bug fixes.
4. **Never commit secrets** — `.env` is gitignored; use `.env.example` for placeholders.
5. Open a PR against `main` describing *what* changed and *why*. CI must be green.

CI (`.github/workflows/ci.yml`) runs on every push and PR to `main`: `pnpm build`,
`pnpm lint`, server tests, and dashboard tests.

## Reporting issues

Open a GitHub issue with clear steps to reproduce, expected vs. actual behavior, and
your environment (OS, Node version). Please don't include secrets or private endpoints.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
