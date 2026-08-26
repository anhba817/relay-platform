# Relay — the platform

The canonical implementation of **Relay**, the chat-infrastructure platform built
chapter by chapter in the [Building Relay tutorial series](https://relay-tutorial.codewithdongly.io.vn).

## How this repository works

- **One git tag per chapter** (`part1-ch1`, `part1-ch2`, …). Every tag is a
  runnable, tested state: check it out and the toolchain checks pass. Each
  chapter's SKIP AHEAD box names the tag to check out if you get stuck.
- **The tutorial and this code cannot drift**: every command and file a chapter
  shows is verified against this repository at that chapter's tag.
- **One language, one toolchain** (ADR-01): TypeScript/Node across every
  package and service, one lint config, one test runner.

## The toolchain checks

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

All three checks pass at every chapter tag — that is the definition of a
chapter being done. Since the ADR-17 re-foundation the commands keep their
names but run through Turborepo: repeat a command and it comes back as a
cache hit; `pnpm turbo run test --force` re-earns the proof cold.

## The local infrastructure

```bash
RELAY_POSTGRES_PORT=15432 docker compose up -d --wait   # Postgres, Redis, NATS, ClickHouse
docker compose ps             # every service "(healthy)"
docker compose down           # stop; volumes survive
docker compose down -v        # stop AND reset all stored data
```

`--wait` returns only when every store's healthcheck passes — started is not
ready. The toolchain checks above never need Docker; chapter 1.2 explains the
split.

**`RELAY_POSTGRES_PORT=15432` is not decoration.** `compose.yaml` defaults every
host port to the standard one (5432/6379/4222/8123), and the code defaults
Postgres to **15432** — so a bare `docker compose up` publishes a database that
`DATABASE_URL`'s default cannot reach. On a machine already running Postgres it is
worse than a mismatch: four containers come up healthy and Postgres alone fails
with `bind: address already in use`, which reads as a compose problem rather than a
port-default one. The other three ports agree with their defaults and need nothing.

**`docker compose up` starts STORES ONLY.** `api`, `gateway` and `dispatcher` sit
behind `profiles: ["services"]`, so they need `--profile services` — and a
`--build`, or you get whatever image was last built:

```bash
RELAY_POSTGRES_PORT=15432 docker compose --profile services build
RELAY_POSTGRES_PORT=15432 docker compose --profile services up -d --wait
```

Skipping the build is a silent failure and a measured one: the sealed integration
suite ran against a stale image and reported six failures — `404` for routes that
exist and a `docs_url` from two chapters ago — none of which named the cause.

## A demo tenant

There is no public way to create an organisation or mint a key: sign-up ends at an
OAuth consent screen and key management is the dashboard's chapter. So a script
does it, and prints the credential on stdout with everything else on stderr:

```bash
RELAY_POSTGRES_PORT=15432 docker compose up -d --wait
DATABASE_URL=postgres://relay:relay@localhost:15432/relay \
  node services/api/dist/db/migrate.js          # needs `pnpm build` first
RELAY_POSTGRES_PORT=15432 docker compose --profile services build
RELAY_POSTGRES_PORT=15432 docker compose --profile services up -d --wait
export RELAY_DEMO_CREDENTIAL=$(node scripts/seed-demo-tenant.mjs)
```

That order is load-bearing: the seed writes rows the api's schema must already
accept, and the api must be serving that schema before anything asks it for
something.

**Which half of the constitution this closes.** The constitution asks that
`docker compose up` yield a working local platform "including a seeded demo
tenant". Compose starts stores rather than services, so no invocation of it can
seed anything — this closes the INTENT and not the letter. A developer who wants
the sentence to be literally true would need compose to run migrations and the
seed as one-shot services, which would put schema management inside a file whose
job is to start containers.

### Sending a message: name who is sending

Every message carries a sender (`FR-MSG-15`). A user token is attributed to its own
subject, so it names nobody; an **application key carries no user of its own**, so it must
name one — and the only sender it may name is a **bot user**: an identity that stands for
your software rather than for a person.

A bot is a user with `kind: "bot"` and a description saying what it is. The description is
required, because a message whose sender cannot be explained is the anonymous send this
requirement exists to remove.

```bash
CHANNEL=$(curl -s -X POST localhost:4000/v1/channels \
  -H "authorization: Bearer $RELAY_DEMO_CREDENTIAL" \
  -H 'content-type: application/json' \
  -d '{"external_id":"deploys","name":"Deploys"}' | jq -r .id)

# Create the bot. `kind` and `description` travel together: a bot without a
# description is refused at the boundary, and the database refuses it too.
curl -s -X POST localhost:4000/v1/users \
  -H "authorization: Bearer $RELAY_DEMO_CREDENTIAL" \
  -H 'content-type: application/json' \
  -d '{"users":[{"external_id":"deploy-bot","display_name":"Deploy Bot",
                 "kind":"bot","description":"posts when a deploy finishes"}]}'

# Send as it. The response echoes the sender it recorded.
curl -s -X POST "localhost:4000/v1/channels/$CHANNEL/messages" \
  -H "authorization: Bearer $RELAY_DEMO_CREDENTIAL" \
  -H 'content-type: application/json' \
  -d '{"text":"build 412 is green","user":"deploy-bot"}'
```

Three refusals worth knowing before you meet them:

| you did this | you get |
|---|---|
| named nobody in `user` | `400`, `field: "user"` |
| named a **person** | `403 sender_not_permitted` |
| named an identifier of another tenant, or none | `400`, and the two are byte-identical |

The last one is deliberate: a refusal that distinguished "exists elsewhere" from "exists
nowhere" would let anyone ask whether a neighbour has a given identifier.

**This section is the quickstart of record.** The constitution asks that the quickstart run
unmodified, verified by automated execution in CI against the published documentation, and
the suite below is that execution — it is sealed from workspace code and follows this file.
There is no second quickstart document; one nobody executes is the debt the requirement
exists to prevent.

Then the sealed integration, which starts nothing and talks only HTTP and
WebSocket:

```bash
export RELAY_API_URL=http://localhost:4000 RELAY_WS_URL=ws://localhost:4001
pnpm test:outsider
```

It is **not** part of `pnpm test:integration`, which is
`turbo run test:integration --filter=!@relay/outsider`. That lane spawns what it
talks to; this suite needs the api and gateway already serving, from images that
were built, with a tenant already seeded.

Re-running the seed is the ordinary case and it is idempotent on the organisation
name. It reissues a key rather than reusing one, because a key's plaintext exists
only at the moment it is minted — the row keeps a hash.

## Running the services

```bash
pnpm dev                           # both services, packages built first
curl -i localhost:4000/healthz     # api    (PORT overridable)
curl -s localhost:4001/healthz     # gateway
```

The two services are deliberately built differently (ADR-15): the **API
service is a NestJS application** — compiled by `nest build`, CommonJS,
decorators on — while the **gateway is frameworkless** and runs its
TypeScript source via `tsx`. `erasableSyntaxOnly` stays enforced everywhere
except `services/api`, where ADR-15's trade-off spends it on decorator
metadata; chapter 1.4 tells both stories. The API service's data layer is
Drizzle, confined to `services/api/src/db` (ADR-16) — migrations are
generated by drizzle-kit, reviewed against the SAD, and applied by the
hand-rolled runner (`pnpm --filter @relay/api migrate`).

## Adopted (formerly "deliberately not yet")

- **Turborepo — adopted via ADR-17** in the stack re-foundation. The
  original position, kept for the record: *plain pnpm scripts carry the gate
  for now (it runs in seconds and nothing emits a build); revisit when the
  gate is measurably slow (≈30 s+) or when a real build step lands.* The
  trigger fired early — ADR-15's NestJS build step arrived with Part 1's
  revision rather than Part 6's containers — and adoption went through the
  revised chapter 1.1, exactly as promised, since it touched files earlier
  chapters published.

## Layout

- `packages/` — shared workspace packages (`@relay/config`,
  `@relay/protocol`, `@relay/service-kit`)
- `services/` — the six Relay services (`api` and `gateway` today, as
  walking skeletons; the rest arrive with their parts)
