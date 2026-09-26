# The media worker (chapter 4.13) — the only service in this platform that reads the
# bytes a customer uploaded.
#
# Its own image for the reason SAD §4.2 asks about: it opens a datastore no other
# process touches, shares no transaction with the api, and does CPU-bound work off the
# request path. ADR-31 carries the argument. It holds no database credential — the
# verdict travels over the internal seam (ADR-04) — so a program that has just streamed
# an untrusted file through a parser cannot read anything.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo

# The manifests first, so a source-only change does not re-run the install.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/service-kit/package.json packages/service-kit/
COPY packages/config/package.json packages/config/
COPY packages/e2e/package.json packages/e2e/
COPY services/api/package.json services/api/
COPY services/gateway/package.json services/gateway/
COPY services/dispatcher/package.json services/dispatcher/
COPY services/media-worker/package.json services/media-worker/
RUN pnpm install --frozen-lockfile

COPY . .
# TURBO, not `pnpm --filter`: this package compiles against `@relay/protocol`'s and
# `@relay/service-kit`'s emitted types, and pnpm's filter runs one package's script
# without building what it depends on.
RUN pnpm exec turbo run build --filter=@relay/media-worker

RUN pnpm --filter @relay/media-worker --prod deploy --legacy /app

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
CMD ["node", "dist/main.js"]
