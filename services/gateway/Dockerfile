# The gateway (chapter 3.5). Containerised alongside the api and the dispatcher
# rather than left as the one service you start by hand.
#
# It gained a `build` script for this: it ran under `tsx` until now, and `tsx` is
# a development tool. Shipping it in a production image would mean deploying a
# TypeScript compiler to serve WebSocket frames.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo

# The manifests first, so a source-only change does not re-run the install. The
# lockfile is copied with them and `--frozen-lockfile` makes the build fail
# rather than silently resolve something new.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/service-kit/package.json packages/service-kit/
COPY packages/config/package.json packages/config/
COPY packages/e2e/package.json packages/e2e/
COPY services/api/package.json services/api/
COPY services/gateway/package.json services/gateway/
COPY services/dispatcher/package.json services/dispatcher/
RUN pnpm install --frozen-lockfile

COPY . .
# TURBO, not `pnpm --filter`. `@relay/gateway` compiles against `@relay/protocol`'s
# and `@relay/service-kit`'s emitted types, and pnpm's filter runs one package's
# script without building what it depends on. Turbo's `dependsOn: ["^build"]` is
# the thing that knows the order.
RUN pnpm exec turbo run build --filter=@relay/gateway

# `pnpm deploy` resolves the workspace links into a self-contained directory, so
# the runtime image carries no symlinks into a repo that will not be there.
# `--legacy` because pnpm 10 otherwise expects `inject-workspace-packages`, and
# turning that on would change how every install in this workspace resolves
# `workspace:*` — a repository-wide change to serve one build step.
RUN pnpm --filter @relay/gateway --prod deploy --legacy /app

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
CMD ["node", "dist/main.js"]
