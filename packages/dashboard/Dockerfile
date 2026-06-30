FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/dashboard/package.json packages/dashboard/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/dashboard packages/dashboard

RUN pnpm --filter @myrmecia/shared build \
  && pnpm --filter @myrmecia/dashboard build

FROM nginx:1.27-alpine
COPY packages/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/packages/dashboard/dist /usr/share/nginx/html
