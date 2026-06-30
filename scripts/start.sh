#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OPEN_BROWSER=1
FORCE_INSTALL=0
INSTALL_PYTHON=0
CLEAN_DB=0
MODE="all"
CUSTOM_DB_PATH=""

usage() {
  cat <<'EOF'
Myrmecia one-click launcher

Usage:
  ./scripts/start.sh [options]
  pnpm start:local -- [options]

Options:
  --clean-db          Remove the default local SQLite database before startup.
  --db <path>         Use a custom SQLite DB_PATH for this run.
  --install           Force pnpm install before startup.
  --install-python    Install Agent Factory Python runtime dependencies.
  --server-only       Start only the Express API server.
  --dashboard-only    Start only the Vite dashboard.
  --no-open           Do not open the browser automatically.
  -h, --help          Show this help message.

Environment:
  AGENT_FACTORY_BASE_URL  OpenAI-compatible model endpoint.
  AGENT_FACTORY_API_KEY   API key for the model endpoint.
  AGENT_FACTORY_MODEL     Optional global fallback model, e.g. gpt-5.4-mini.
  API_AUTH_TOKEN      Optional API bearer token for dashboard/server auth.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean-db)
      CLEAN_DB=1
      shift
      ;;
    --db)
      CUSTOM_DB_PATH="${2:-}"
      if [[ -z "$CUSTOM_DB_PATH" ]]; then
        echo "Missing value for --db" >&2
        exit 1
      fi
      shift 2
      ;;
    --install)
      FORCE_INSTALL=1
      shift
      ;;
    --install-python)
      INSTALL_PYTHON=1
      shift
      ;;
    --server-only)
      MODE="server"
      shift
      ;;
    --dashboard-only)
      MODE="dashboard"
      shift
      ;;
    --no-open)
      OPEN_BROWSER=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd node
require_cmd pnpm

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node >=20 is required. Current: $(node -v)" >&2
  exit 1
fi

if [[ "$MODE" != "dashboard" ]]; then
  require_cmd python3
fi

if [[ -f ".env" ]]; then
  echo "Loading .env"
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

if [[ "$CLEAN_DB" -eq 1 ]]; then
  echo "Cleaning default local database..."
  rm -f packages/server/data/agent-factory.db \
        packages/server/data/agent-factory.db-wal \
        packages/server/data/agent-factory.db-shm
fi

if [[ -n "$CUSTOM_DB_PATH" ]]; then
  export DB_PATH="$CUSTOM_DB_PATH"
  mkdir -p "$(dirname "$DB_PATH")"
fi

if [[ "$FORCE_INSTALL" -eq 1 || ! -d "node_modules" ]]; then
  echo "Installing JavaScript dependencies..."
  pnpm install
fi

if [[ "$MODE" != "dashboard" ]]; then
  if [[ "$INSTALL_PYTHON" -eq 1 ]]; then
    echo "Installing Agent Factory Python runtime dependencies..."
    python3 -m pip install -r packages/python-runtime/requirements.txt
  else
    if ! python3 - <<'PY' >/dev/null 2>&1
import importlib, litellm, yaml
importlib.import_module("cre" + "wai")
PY
    then
      cat <<'EOF'
Warning: Agent Factory Python runtime dependencies are not installed.
Agent execution may fail until you run:
  ./scripts/start.sh --install-python
or:
  pip install -r packages/python-runtime/requirements.txt
EOF
    fi
  fi
fi

echo ""
echo "Starting Myrmecia..."
echo "  API server:  http://localhost:${PORT:-3000}"
echo "  Dashboard:   http://localhost:5173"
if [[ -n "${DB_PATH:-}" ]]; then
  echo "  DB_PATH:     ${DB_PATH}"
fi
echo ""

if [[ "$OPEN_BROWSER" -eq 1 && "$MODE" != "server" ]]; then
  if command -v open >/dev/null 2>&1; then
    (sleep 3 && open "http://localhost:5173") >/dev/null 2>&1 &
  fi
fi

case "$MODE" in
  server)
    exec pnpm dev:server
    ;;
  dashboard)
    exec pnpm dev:dashboard
    ;;
  all)
    exec pnpm dev
    ;;
esac
