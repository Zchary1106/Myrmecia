# Deployment and Security

Agent Factory defaults to local development mode. Remote access should be treated as an operator console: protect it with a token, TLS, and network controls.

## Runtime modes

| Mode | Server config | Dashboard config | Use case |
|------|---------------|------------------|----------|
| Local | no `API_AUTH_TOKEN` | no token needed | Development on `localhost`. |
| Remote/private | `API_AUTH_TOKEN=<strong-token>` | `VITE_API_AUTH_TOKEN=<same-token>` or runtime localStorage token | Access behind VPN, Tailscale, SSH tunnel, or a private reverse proxy. |

## API authentication

Set `API_AUTH_TOKEN` on the server to enable Bearer-token protection for `/api/*` routes. `/api/health` remains public for health checks.

```bash
API_AUTH_TOKEN="$(openssl rand -hex 32)" pnpm --filter @agent-factory/server start
```

Clients must send:

```http
Authorization: Bearer <token>
```

The dashboard sends this header when either `VITE_API_AUTH_TOKEN` is set or `localStorage["agentFactory.apiToken"]` contains a token. WebSocket connections also include the token as a `?token=` query parameter, so remote deployments should use HTTPS/WSS.

You can enter or rotate the runtime dashboard token from the dashboard Settings page. This writes `localStorage["agentFactory.apiToken"]`, runs a health check, and attempts to load sanitized diagnostics. Use this for remote/private deployments where you do not want to bake the token into the dashboard bundle.

## Settings and diagnostics

The dashboard Settings page provides:

- API token save/clear controls;
- a public `/api/health` reachability check;
- authenticated `/api/diagnostics` loading;
- deployment checks for API reachability, auth configuration, queue backend, and recorded migrations.

`GET /api/diagnostics` intentionally returns only sanitized information:

| Field | Contents |
|-------|----------|
| `auth` | whether token auth is enabled and whether the server is in `local` or `token` mode |
| `operator` | current sanitized actor id/role/source plus runtime-control and task-delete permissions |
| `queue` | `memory` or `redis`, plus whether Redis is configured |
| `database` | DB path source (`default` or `env`), file-name hint, and applied migration IDs |
| `runtime` | Node version, platform, pid, uptime, and environment |

It does not expose `API_AUTH_TOKEN`, Redis URLs, full database paths, or other secrets. The dashboard uses the `operator` diagnostics to display the active identity and disable known-unavailable runtime controls for read-only viewers.

## Reverse proxy guidance

- Terminate TLS before exposing the dashboard/API outside localhost.
- Prefer private networks or VPNs over public internet exposure.
- Do not log full WebSocket URLs if auth is enabled, because the token appears in the query string.
- Keep `API_AUTH_TOKEN` out of source control and commit history.
- If the proxy authenticates individual users, pass `X-Operator-Id` and `X-Operator-Role` (`admin`, `operator`, or `viewer`) so control actions are attributed to the real operator.
- Strip inbound `X-Operator-*` headers from clients before setting trusted proxy values.

Without proxy identity headers, audit records use `local-admin` for local mode or `token-admin` for token-authenticated requests.

Operator roles are enforced on control routes:

| Role | Permission |
|------|------------|
| `admin` | Full launch/runtime control, including task deletion. |
| `operator` | Launch and runtime control such as task create/cancel/retry, pipeline create/approve/skip/cancel, and inbox responses. |
| `viewer` | Read-only access; launch/control actions return `403 OPERATOR_FORBIDDEN`. |

## SQLite persistence and migrations

SQLite schema changes are tracked in `schema_migrations`. On startup the server:

1. creates base tables from `schema.sql`;
2. reads structured migration blocks after `-- Migrations`;
3. skips migrations already recorded in `schema_migrations`;
4. records successfully applied migrations.

Legacy databases that already contain a column from an older untracked migration are recorded after a duplicate-column warning, avoiding repeated startup failures while preserving visibility.

Back up the database file before production upgrades:

```bash
cp packages/server/data/agent-factory.db packages/server/data/agent-factory.db.bak
```

## Recovery and observability

On startup, interrupted tasks are re-queued, blocked pipelines recreate retry timers, running pipelines inspect their current stage task, and interrupted quality-loop attempts are marked explicitly as `failed` or `skipped`.

Use these endpoints for operations:

- `GET /api/events` for durable platform event history;
- `GET /api/operator-actions` for durable operator control audit history;
- `GET /api/observability` for failure hotspots, retry hotspots, and pipeline health;
- `GET /api/diagnostics` for sanitized runtime/deployment diagnostics;
- `GET /api/tasks/:id/quality-attempts` for review/fix loop history.
