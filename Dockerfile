FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/python-runtime/requirements.txt packages/python-runtime/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/python-runtime packages/python-runtime
COPY tsconfig.base.json .

RUN pnpm --filter @myrmecia/shared build && pnpm --filter @myrmecia/server build

FROM node:20-slim
WORKDIR /app
RUN corepack enable pnpm
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/packages/server ./packages/server
COPY --from=builder /app/packages/python-runtime ./packages/python-runtime
COPY --from=builder /app/package.json .

RUN pip3 install --no-cache-dir --break-system-packages -r packages/python-runtime/requirements.txt

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
