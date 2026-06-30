#!/usr/bin/env bash
set -euo pipefail

# Boot the seeded Myrmecia demo (API + dashboard), capture dashboard screenshots
# with Playwright, then tear everything down. Render the video separately with
# `npm run render`.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEMO_DB="$HERE/demo.db"

SERVER_TSX="$ROOT/packages/server/node_modules/.bin/tsx"
DASH_VITE="$ROOT/packages/dashboard/node_modules/.bin/vite"

SERVER_PID=""
DASH_PID=""

cleanup() {
  echo "[run] tearing down..."
  [ -n "$DASH_PID" ] && kill "$DASH_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[run] seeding demo database -> $DEMO_DB"
rm -f "$DEMO_DB" "$DEMO_DB-wal" "$DEMO_DB-shm"
( cd "$ROOT/packages/server" && AGENT_FACTORY_DEMO_MODE=true DB_PATH="$DEMO_DB" EMBEDDING_BACKEND=pseudo MEMORY_KNOWLEDGE_BRIDGE=false "$SERVER_TSX" src/demo/seed-demo.ts )

echo "[run] starting API server on :3000"
( cd "$ROOT/packages/server" && AGENT_FACTORY_DEMO_MODE=true DB_PATH="$DEMO_DB" EMBEDDING_BACKEND=pseudo MEMORY_KNOWLEDGE_BRIDGE=false PORT=3000 "$SERVER_TSX" src/index.ts ) > "$HERE/server.log" 2>&1 &
SERVER_PID=$!

echo "[run] starting dashboard on :5173"
( cd "$ROOT/packages/dashboard" && "$DASH_VITE" --port 5173 --strictPort ) > "$HERE/dashboard.log" 2>&1 &
DASH_PID=$!

echo "[run] waiting for API health..."
for i in $(seq 1 60); do
  if curl -fsS --noproxy '*' http://localhost:3000/api/v1/health >/dev/null 2>&1; then echo "[run] API ready"; break; fi
  sleep 1
  if [ "$i" -eq 60 ]; then echo "[run] API did not become ready"; tail -n 40 "$HERE/server.log"; exit 1; fi
done

echo "[run] waiting for dashboard..."
for i in $(seq 1 60); do
  if curl -fsS --noproxy '*' http://localhost:5173 >/dev/null 2>&1; then echo "[run] dashboard ready"; break; fi
  sleep 1
  if [ "$i" -eq 60 ]; then echo "[run] dashboard did not become ready"; tail -n 40 "$HERE/dashboard.log"; exit 1; fi
done

# Give the dashboard a moment to finish first data loads.
sleep 3

echo "[run] capturing screenshots..."
( cd "$HERE" && node capture.mjs )

echo "[run] capture complete. Frames in $HERE/public/frames"
