# The api (chapter 3.5). The repository's containers arrive with the dispatcher:
# adding one image for the new service alone would have made the newest
# deployable the only packaged one, which is a distinction nothing justifies.
#
# Multi-stage, and the stages are doing real work rather than ceremony: the
# build stage needs the whole workspace because `@relay/api` depends on
# `@relay/protocol` and `@relay/service-kit` by `workspace:*`, and the runtime
# stage needs none of that — only the compiled output and the production
# dependency tree.
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
# TURBO, not `pnpm --filter`. `@relay/api` compiles against `@relay/protocol`'s
# and `@relay/service-kit`'s emitted types, and pnpm's filter runs one package's
# script without building what it depends on. Turbo's `dependsOn: ["^build"]` is
# the thing that knows the order.
RUN pnpm exec turbo run build --filter=@relay/api

# `pnpm deploy` resolves the workspace links into a self-contained directory, so
# the runtime image carries no symlinks into a repo that will not be there.
# `--legacy` because pnpm 10 otherwise expects `inject-workspace-packages`, and
# turning that on would change how every install in this workspace resolves
# `workspace:*` — a repository-wide change to serve one build step.
RUN pnpm --filter @relay/api --prod deploy --legacy /app

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
# Migrations travel with the service that owns them (ADR-04): this image is the
# only thing that may apply them.
COPY --from=build /repo/services/api/migrations ./migrations
USER node
CMD ["node", "dist/main.js"]
