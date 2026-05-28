FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/crew/requirements.txt packages/crew/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/crew packages/crew
COPY tsconfig.base.json .

RUN pnpm --filter @agent-factory/shared build && pnpm --filter @agent-factory/server build

FROM node:20-slim
WORKDIR /app
RUN corepack enable pnpm
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/packages/server ./packages/server
COPY --from=builder /app/packages/crew ./packages/crew
COPY --from=builder /app/package.json .

RUN pip3 install --no-cache-dir --break-system-packages -r packages/crew/requirements.txt

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
