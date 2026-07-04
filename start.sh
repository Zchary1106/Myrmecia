#!/usr/bin/env bash
#
# Agent Factory 一键启动
#
# 用法:
#   ./start.sh              # 启动前后端（API + Dashboard）
#   ./start.sh --clean-db   # 清空数据库重新开始
#   ./start.sh --server     # 只启动后端
#   ./start.sh --dashboard  # 只启动前端
#
# 访问:
#   Dashboard: http://localhost:5173
#   API:       http://localhost:3000
#

set -euo pipefail
cd "$(dirname "$0")"

# 颜色
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}🐜 Myrmecia${NC}"
echo ""

# 检查 node（需要 >= 20）
if ! command -v node >/dev/null 2>&1; then
  echo -e "${YELLOW}❌ Node.js not found. Install Node >= 20 from https://nodejs.org${NC}"
  exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "${YELLOW}❌ Node >= 20 required. Current: $(node -v)${NC}"
  exit 1
fi

# 确保 pnpm（用 corepack 自动装）
if ! command -v pnpm >/dev/null 2>&1; then
  echo -e "${BLUE}📦 Provisioning pnpm via corepack...${NC}"
  corepack enable pnpm 2>/dev/null || true
  corepack prepare pnpm@latest --activate 2>/dev/null || true
  if ! command -v pnpm >/dev/null 2>&1; then
    echo -e "${YELLOW}❌ pnpm unavailable. Run: npm install -g pnpm${NC}"
    exit 1
  fi
fi

# 检查依赖
if [ ! -d "node_modules" ]; then
  echo -e "${BLUE}📦 Installing dependencies...${NC}"
  pnpm install
fi

# 构建 shared types（确保类型定义最新）
if [ ! -d "packages/shared/dist" ] || [ "packages/shared/src/index.ts" -nt "packages/shared/dist/index.js" ]; then
  echo -e "${BLUE}🔨 Building shared types...${NC}"
  pnpm --filter @myrmecia/shared build 2>/dev/null || npx tsc --project packages/shared/tsconfig.json
fi

# 传递参数给原有脚本
exec bash scripts/start.sh "$@"
