# Deployment & Operations Guide

Agent Factory supports multiple deployment modes from local development to production Kubernetes clusters.

---

## Quick Start (Docker Compose)

```bash
# Clone and start all services
cp .env.example .env
docker compose up -d

# Services:
#   - PostgreSQL (pgvector): localhost:5432
#   - Redis: localhost:6379
#   - Server API: localhost:3000
#   - Dashboard: localhost:5173
```

---

## Deployment Modes

| Mode | Config | Use case |
|------|--------|----------|
| **Local dev** | Default (no env vars) | Single machine, SQLite, no auth |
| **Docker Compose** | `docker compose up` | Team dev, full stack |
| **Production (single)** | `DATABASE_URL` + `REDIS_URL` | Small deployment |
| **Production (K8s)** | Helm chart + HPA | Enterprise scale |

---

## Environment Variables

See `.env.example` for the full list. Key groups:

### Core
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | `production` enables HSTS, stricter CORS |
| `DATABASE_URL` | — | PostgreSQL connection string (enables PG mode) |
| `DB_PATH` | `./data/agent-factory.db` | SQLite path (dev mode) |
| `REDIS_URL` | — | Redis connection (enables distributed features) |

### Authentication
| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_MODE` | `local` | `local` (no auth) or `oidc` (SSO) |
| `SESSION_SECRET` | `dev-secret...` | JWT signing secret (**change in production**) |
| `API_AUTH_TOKEN` | — | Static Bearer token for API access |
| `OIDC_ISSUER` | — | OpenID Connect discovery URL |
| `OIDC_CLIENT_ID` | — | OAuth2 client ID |
| `OIDC_CLIENT_SECRET` | — | OAuth2 client secret |

### Execution
| Variable | Default | Description |
|----------|---------|-------------|
| `EXECUTOR_MODE` | `local` | `local` or `docker` (sandbox isolation) |
| `AGENT_DOCKER_IMAGE` | `agent-factory/sandbox:latest` | Container image for agents |
| `CONTAINER_POOL_SIZE` | `3` | Pre-warmed container count |
| `WORKER_MODE` | `both` | `scheduler`, `worker`, or `both` |

### Observability
| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | pino log level |
| `OTEL_ENABLED` | `false` | Enable OpenTelemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP collector |

### Security
| Variable | Default | Description |
|----------|---------|-------------|
| `CORS_ORIGINS` | — | Comma-separated allowed origins |
| `SECRET_PROVIDER` | `env` | `env`, `vault`, or `aws` |
| `VAULT_ADDR` | `http://127.0.0.1:8200` | HashiCorp Vault address |

---

## Kubernetes Deployment

### Architecture
```
                    ┌─────────────┐
                    │   Ingress   │
                    │  (TLS/CORS) │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼─────┐ ┌───▼────┐ ┌────▼─────┐
        │ Dashboard  │ │  API   │ │  Worker  │
        │  (nginx)   │ │Scheduler│ │  Nodes   │
        └────────────┘ └───┬────┘ └────┬─────┘
                           │            │
                    ┌──────▼──────────▼──────┐
                    │     Redis (pub/sub     │
                    │     + BullMQ queues)    │
                    └──────────┬─────────────┘
                               │
                    ┌──────────▼─────────────┐
                    │    PostgreSQL + pgvector│
                    └────────────────────────┘
```

### Scaling Strategy

| Component | Scaling | Notes |
|-----------|---------|-------|
| API (scheduler) | HPA on CPU/requests | Stateless, scale freely |
| Workers | HPA on queue depth | Each worker picks tasks from BullMQ |
| Dashboard | Static files, CDN | No state |
| PostgreSQL | Primary + read replicas | Connection pooling via PgBouncer |
| Redis | Sentinel or Cluster | For HA |

### Resource Recommendations

| Component | CPU | Memory | Replicas |
|-----------|-----|--------|----------|
| API | 500m-2000m | 512Mi-2Gi | 2-5 |
| Worker | 1000m-4000m | 1Gi-4Gi | 2-10 |
| PostgreSQL | 2000m | 4Gi | 1 primary + 1 replica |
| Redis | 500m | 1Gi | 3 (sentinel) |

---

## Monitoring & Alerting

### Health Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health/live` | No | K8s liveness probe |
| `GET /health/ready` | No | K8s readiness probe (checks DB, Redis, Docker) |
| `GET /health/circuit` | No | Circuit breaker state |
| `GET /metrics` | No | Prometheus-compatible metrics |

### Key Metrics to Alert On

| Metric | Threshold | Action |
|--------|-----------|--------|
| `http.duration_ms` P99 | > 5000ms | Scale API pods |
| `task.executions{status=failed}` rate | > 10% | Check agent logs |
| `llm.cost_microdollars` daily | > budget | Budget alert fires |
| Queue depth | > 100 pending | Scale workers |
| Circuit breaker OPEN | Any | LLM provider down, check fallback |

### Logging

Production logs are structured JSON (pino). Ship to your log aggregator:

```yaml
# Fluentd/Fluent Bit config snippet
[FILTER]
    Name   parser
    Match  agent-factory.*
    Key_Name log
    Parser json
```

---

## Backup & Restore

### PostgreSQL
```bash
# Backup
pg_dump -Fc agent_factory > backup_$(date +%Y%m%d).dump

# Restore
pg_restore -d agent_factory backup_20260514.dump
```

### SQLite (development)
```bash
cp packages/server/data/agent-factory.db agent-factory.db.bak
```

### Workspace Snapshots
```bash
# Export via API
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/workspace-snapshot > snapshot.json

# Restore preview
curl -X POST -H "Content-Type: application/json" \
  -d @snapshot.json http://localhost:3000/api/v1/workspace-snapshot/preview
```

---

## Upgrade Procedure

### Standard Upgrade
```bash
# 1. Backup
pg_dump -Fc agent_factory > pre_upgrade_backup.dump

# 2. Pull new image
docker compose pull

# 3. Rolling restart (zero downtime with multiple replicas)
docker compose up -d --no-deps server

# 4. Verify health
curl http://localhost:3000/health/ready

# 5. Verify migrations applied
curl http://localhost:3000/api/v1/diagnostics | jq .database.migrations
```

### Breaking Changes
- Check release notes for migration instructions
- Use `GET /api/v1/releases` to track deployed versions
- Feature flags allow gradual rollout of breaking features

### Rollback
```bash
# Quick rollback to previous image
docker compose down server
docker compose up -d --no-deps server  # with previous image tag

# Or use release manager
curl -X POST http://localhost:3000/api/v1/releases/{id}/rollback
```

---

## Security Hardening Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set strong `SESSION_SECRET` (64+ random bytes)
- [ ] Configure `CORS_ORIGINS` (no wildcard)
- [ ] Enable `AUTH_MODE=oidc` with real IdP
- [ ] Set `EXECUTOR_MODE=docker` for agent isolation
- [ ] Configure `SECRET_PROVIDER=vault` or `aws`
- [ ] Enable TLS at ingress/proxy level
- [ ] Set `API_AUTH_TOKEN` for service-to-service calls
- [ ] Review DLP rules per workspace
- [ ] Enable audit log export to immutable storage
- [ ] Rotate API keys on schedule (90 days max)
- [ ] Set budget limits per workspace
- [ ] Run `GET /audit/verify` weekly to check hash chain integrity

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `503` on all requests | DB connection failed | Check `DATABASE_URL`, run `/health/ready` |
| Tasks stuck in `running` | Worker crashed | Tasks auto-recover on restart; check logs |
| Circuit breaker OPEN | LLM API timeout/errors | Wait for auto-reset (30s) or check provider status |
| High memory usage | Large vector store in memory | Switch to `VECTOR_BACKEND=pgvector` |
| WebSocket disconnects | No Redis in multi-instance | Set `REDIS_URL` for pub/sub |
| Auth failures after upgrade | Session secret changed | Keep `SESSION_SECRET` constant across deploys |
