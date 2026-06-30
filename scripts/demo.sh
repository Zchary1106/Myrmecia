#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEMO_DB_PATH="${DB_PATH:-$ROOT_DIR/packages/server/data/demo.db}"
mkdir -p "$(dirname "$DEMO_DB_PATH")"

rm -f "$DEMO_DB_PATH" "$DEMO_DB_PATH-wal" "$DEMO_DB_PATH-shm"

export DB_PATH="$DEMO_DB_PATH"
export AGENT_FACTORY_DEMO_MODE=true
export EMBEDDING_BACKEND="${EMBEDDING_BACKEND:-pseudo}"
export MEMORY_KNOWLEDGE_BRIDGE="${MEMORY_KNOWLEDGE_BRIDGE:-false}"

if [[ ! -d "node_modules" ]]; then
  echo "Installing JavaScript dependencies..."
  pnpm install
fi

echo "Seeding deterministic demo data..."
pnpm --filter @myrmecia/server exec tsx src/demo/seed-demo.ts

cat <<EOF

Demo database ready:
  DB_PATH: $DB_PATH

Starting Myrmecia with seeded demo data.
Open http://localhost:5173 and inspect:
  - Command Center / Tasks: completed feature delivery flow
  - Pipelines: PM -> Design -> Dev -> QA -> Review demo
  - Teams: parallel feature team board
  - Memory / Knowledge: demo product brief
  - Audit / Observe / Costs: seeded traces and governance events

EOF

exec ./scripts/start.sh --db "$DB_PATH" "$@"
