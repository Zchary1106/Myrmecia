FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/server packages/server
COPY tsconfig.base.json .

RUN pnpm --filter @myrmecia/shared build && pnpm --filter @myrmecia/server build

FROM node:20-slim
WORKDIR /app
RUN corepack enable pnpm
# Python is retained only for independent optional utilities (for example,
# ComfyUI); the built-in Agent runtime has no Python packages or pip dependency.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/packages/server ./packages/server
COPY --from=builder /app/package.json .
COPY agents ./agents
COPY templates ./templates

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
