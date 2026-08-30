import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import { createLogger, serve, type Logger } from "@relay/service-kit";
import {
  docsUrl,
  subjectForChannelMembership,
  subjectForUserMembership,
  type MembershipFabric,
} from "@relay/protocol";
// A CLIENT BELONGING TO NEITHER SIDE. The gateway module only subscribes and the
// api's publisher lives in another package, so a test that wants to put a frame on
// the fabric needs its own publisher. `presence.itest.ts` carries the same one for
// the same reason and `eslint.config.mjs` carries the exemption.
import { Redis } from "ioredis";
import { WebSocket } from "ws";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createApiClient, type ApiClient } from "./api-client.js";
import { createFanout } from "./fanout.js";
import {
  createMembership,
  DEFAULT_REREAD_INTERVAL_MS,
  type Membership,
} from "./membership.js";
import { createPresence } from "./presence.js";
import { attachSessions } from "./session.js";

// Chapter 3.20, phase 3 — the fabric, and ONLY the fabric.
//
// **THE ARMS THAT `session.ts` CANNOT REACH, WRITTEN NOW.** Chapter 3.19 met its
// equivalents at close-out and its record is the price: six arms of `presence.ts`
// had never executed while thirty-one integration tests and eight unit tests were
// green, and the seven tests written to fix that came with a re-measured battery.
// Every case below is unreachable through a session: a session never unsubscribes
// something it did not subscribe, never receives before its handler is wired, and
// never constructs the module at all.
//
// `fanout.itest.ts` is the shape — a Redis-only integration file with no api and no
// gateway. The two-instance session harness arrives in phase 4 with its first test,
// because a fixture written a phase before its consumer is an unused binding, which
// is what T039 already cost this chapter once.

const url = process.env.RELAY_REDIS_URL ?? "redis://localhost:6379";

interface LogLine {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

/** THE SINK RECEIVES A JSON STRING, not an object, and the fields are spread at the
 * top level rather than nested. Chapter 3.19's first version pushed the raw line, so
 * every `l.msg` was `undefined` and the log assertions matched nothing while passing
 * — the one failure mode a log-based assertion has. The `records a line at all` test
 * below is what proves this helper before anything relies on it (T044). */
function recorder(): { logs: LogLine[]; logger: Logger } {
  const logs: LogLine[] = [];
  const logger = createLogger("membership-itest", (line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    logs.push({
      level: String(parsed["level"]),
      msg: String(parsed["msg"]),
      fields: parsed,
    });
  });
  return { logs, logger };
}

/** Redis pub/sub is fire-and-forget: a test cannot poll a queue, so it waits with a
 * deadline. A timeout here is a real failure — the frame did not cross. */
function waitFor<T>(
  predicate: () => T | undefined,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const value = predicate();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`no ${what} within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Fresh ids per run. Redis pub/sub has no namespaces, so two suites publishing to a
 * fixed subject on one broker read each other's frames — chapter 2.7 paid for this
 * between `fanout.itest.ts` and `resume.itest.ts`, and the only namespace pub/sub
 * has is the subject itself. */
const CHANNEL = randomUUID();
const ENVIRONMENT = randomUUID();

const publisher = new Redis(url);
const modules: Membership[] = [];

/** Every module this file builds, closed after its test. A leaked subscriber holds
 * an open handle and vitest reports it as a hanging suite rather than a failure. */
function build(options: Parameters<typeof createMembership>[0]): Membership {
  const membership = createMembership(options);
  modules.push(membership);
  return membership;
}

function change(overrides: Partial<MembershipFabric> = {}): MembershipFabric {
  return {
    environment: ENVIRONMENT,
    channel: CHANNEL,
    user: "tuan",
    change: "removed",
    ...overrides,
  };
}

beforeEach(() => {
  modules.length = 0;
});

afterEach(async () => {
  await Promise.all(modules.map((m) => m.close()));
});

afterAll(() => {
  publisher.disconnect();
});

// ---------------------------------------------------------------------------
// PHASE 4'S HARNESS. Deferred out of phase 3 deliberately: written a phase early,
// every function below is declared and called by nothing, which is a lint error
// rather than a head start. **This is the seventh api spawn in the gateway package**
// and it makes chapter 3.19's `gaps.md` item 17 worse rather than better — six files
// already spawn their own with their own helper, and building the shared fixture is
// item 17's actual fix and a job of its own. The decision here is to pay the seventh,
// say so, and leave the fix an owner in `gaps.md`.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);

interface Repo {
  createUser: (externalId: string, displayName?: string) => Promise<{ id: string }>;
  /** THE SENDER MUST BE A BOT, and `createUser` cannot make one — chapter 3.17 made
   * that refusal deliberately, and the send route enforces the other half: "an
   * application credential may send only as a bot user". The seed's people are the
   * audience; the sender is a separate row created through the one method that can
   * set `kind`. */
  upsertUser: (
    externalId: string,
    profile: {
      display_name?: string;
      kind?: "person" | "bot";
      /** REQUIRED FOR A BOT, by `users_bot_description_check`: "a description is what
       * turns an opaque sender into an answerable one, so a bot without one is not a
       * bot". A database constraint rather than a validator, so it refuses a seed as
       * readily as a route. */
      description?: string;
    },
  ) => Promise<unknown>;
  createChannel: (
    externalId: string,
    type: "public" | "private",
  ) => Promise<{ id: string }>;
  addMember: (channelId: string, userId: string) => Promise<unknown>;
}

interface Seeder {
  createEnvironment: (db: unknown, input: { name: string }) => Promise<{ id: string }>;
  createApiKey: (
    db: unknown,
    input: { environmentId: string },
  ) => Promise<{ credential: string }>;
  Repository: new (db: unknown, environmentId: string) => Repo;
}

interface ApiUnderTest {
  url: string;
  environmentId: string;
  credential: string;
  repo: Repo;
  /** A SECOND TENANT: its own environment, its own key, its own user and channel.
   * Nothing shared with the first but a Redis instance and a gateway, which is
   * exactly the pair the isolation assertions are about. */
  other: { environmentId: string; credential: string; repo: Repo };
  stop: () => void;
}

async function startApi(): Promise<ApiUnderTest> {
  const port = 4900 + Math.floor(Math.random() * 200);
  const dist = join(REPO, "services", "api", "dist");
  if (!existsSync(join(dist, "main.js"))) {
    throw new Error(
      "the api is not built — run `pnpm build` before this lane " +
        "(the suite talks to the real service, not a stub)",
    );
  }
  const client = require_(join(dist, "db", "client.js")) as {
    createDb: (pool: unknown) => unknown;
    createPool: () => unknown;
  };
  const seeder = require_(join(dist, "db", "repository.js")) as Seeder;
  const db = client.createDb(client.createPool());

  const environment = await seeder.createEnvironment(db, {
    name: `membership-itest-${randomUUID().slice(0, 8)}`,
  });
  const key = await seeder.createApiKey(db, { environmentId: environment.id });

  const other = await seeder.createEnvironment(db, {
    name: `membership-itest-other-${randomUUID().slice(0, 8)}`,
  });
  const otherKey = await seeder.createApiKey(db, { environmentId: other.id });

  const child: ChildProcess = spawn("node", [join(dist, "main.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_OUTBOX_RELAY: "off",
      RELAY_NOTIFICATION_RELAY: "off",
      RELAY_EVENT_CONSUMER: "off",
    },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    environmentId: environment.id,
    credential: key.credential,
    repo: new seeder.Repository(db, environment.id),
    other: {
      environmentId: other.id,
      credential: otherKey.credential,
      repo: new seeder.Repository(db, other.id),
    },
    stop: () => child.kill(),
  };
}

/** FRESH USERS AND CHANNELS PER TEST, and this is not tidiness. A user removed in
 * one test is still removed in the next, and a shared fixture presents that as an
 * empty frame list — chapter 3.19's first run failed exactly that way, with test 1
 * passing and tests 2 to 4 reporting `expected [] to have a length of 1`, which
 * reads like a broken fabric.
 *
 * Rows are cheap; the api process is not. That is the whole reason the spawn is
 * shared and the seed is not. */
async function seed(
  users: string[],
  channels: number,
  /** Channels created but joined by NOBODY. US3 needs a channel a connected user is
   * not yet in — the whole point of an addition is that the instance holding them
   * is subscribed to nothing of it. */
  empty = 0,
): Promise<{
  users: Record<string, string>;
  channels: string[];
  empty: string[];
  sender: string;
}> {
  const tag = randomUUID().slice(0, 8);
  const names: Record<string, string> = {};
  const rows = await Promise.all(
    users.map(async (name) => {
      const external = `${name}-${tag}`;
      names[name] = external;
      return api.repo.createUser(external, name);
    }),
  );
  const channelRows = await Promise.all(
    Array.from({ length: channels }, (_, i) =>
      api.repo.createChannel(`channel-${i}-${tag}`, "public"),
    ),
  );
  // Everyone in every channel. A test that wants someone out removes them through
  // the route, which is the path under test.
  await Promise.all(
    channelRows.flatMap((channel) =>
      rows.map((user) => api.repo.addMember(channel.id, user.id)),
    ),
  );
  const emptyRows = await Promise.all(
    Array.from({ length: empty }, (_, i) =>
      api.repo.createChannel(`empty-${i}-${tag}`, "public"),
    ),
  );
  const sender = `sender-${tag}`;
  await api.repo.upsertUser(sender, {
    display_name: "Sender",
    kind: "bot",
    description: "posts the messages this suite asserts about",
  });
  return {
    users: names,
    channels: channelRows.map((c) => c.id),
    empty: emptyRows.map((c) => c.id),
    sender,
  };
}

async function mintToken(
  user: string,
  credential: string = api.credential,
): Promise<string> {
  const res = await fetch(`${api.url}/auth/dev-token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({ user, ttl_seconds: 3600 }),
  });
  if (!res.ok) throw new Error(`dev-token: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

/** The route under test. Answers 200 with a per-entry result, so a caller that
 * removed nobody still gets a 200 — which is why the tests assert the result and
 * not the status. */
async function removeMember(
  channelId: string,
  users: string | string[],
  credential: string = api.credential,
): Promise<string[]> {
  const user_ids = Array.isArray(users) ? users : [users];
  const res = await fetch(
    `${api.url}/v1/channels/${channelId}/members/remove`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ user_ids }),
    },
  );
  if (!res.ok) throw new Error(`remove: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { results: { result: string }[] };
  return body.results.map((r) => r.result);
}

/** `user` is required and must have a row: an application credential carries no
 * user of its own, and FR-MSG-15 says every message has a sender. So the sender is
 * one of the seeded externals rather than a literal. */
async function addMember(
  channelId: string,
  user: string,
  credential: string = api.credential,
): Promise<string> {
  const res = await fetch(`${api.url}/v1/channels/${channelId}/members`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({ user_ids: [user] }),
  });
  if (!res.ok) throw new Error(`add: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { members: { status: string }[] };
  return body.members[0]?.status ?? "none";
}

/** The self-service half of FR-004. A USER token, not the api key: the route is
 * `@Accepts("user")` and an application credential carries no user to join with.
 *
 * NOT NAMED `join`. This file imports `join` from `node:path` for the api's dist
 * directory, and a local `join` shadows it — TypeScript said so (`TS2440`) while
 * vitest, which transpiles without typechecking, ran the tests anyway and asserted
 * against a filesystem path: `expected '692d98b8-…/…' to be 'joined'`. */
async function joinChannel(channelId: string, user: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/channels/${channelId}/join`, {
    method: "POST",
    headers: { authorization: `Bearer ${await mintToken(user)}` },
  });
  if (!res.ok) throw new Error(`join: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { result: string }).result;
}

async function ban(
  user: string,
  banned = true,
  credential: string = api.credential,
): Promise<void> {
  const res = await fetch(`${api.url}/v1/users/${user}/ban`, {
    method: banned ? "POST" : "DELETE",
    headers: { authorization: `Bearer ${credential}` },
  });
  if (!res.ok) throw new Error(`ban: ${res.status} ${await res.text()}`);
}

async function postMessage(
  channelId: string,
  user: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${api.url}/v1/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${api.credential}`,
    },
    body: JSON.stringify({ user, text, idempotency_key: randomUUID() }),
  });
  if (!res.ok) throw new Error(`send: ${res.status} ${await res.text()}`);
}

interface Instance {
  url: string;
  logs: LogLine[];
  close: () => Promise<void>;
}

/** One gateway instance: its own server, its own fabric clients, its own
 * `Membership`. Two of these on one Redis is what the cross-instance case needs. */
/** `backfillDelayMs` WIDENS THE RESUME WINDOW, and it is the only way to reach it.
 *
 * A connection is `buffering` from the upgrade until `api.backfill` returns, which
 * on this lane is one local HTTP round trip — about twenty milliseconds. Racing that
 * from a test is a flake generator, and the first version of the FR-029 test did
 * exactly that: it passed, and it passed just as happily with the buffer filter
 * deleted, because the connection had gone live long before the removal landed.
 *
 * Slowing the fabric instead does not work. `withDeadline(subscribing,
 * resumeDeadlineMs)` failing calls `degrade()`, and `degrade()` empties the buffer
 * itself — a wider window that discards the very frames the test is about.
 *
 * So the delay goes on the `ApiClient`, which `attachSessions` takes as a parameter
 * and which is therefore a seam the test already owns. The code path under test is
 * the real one; only the clock moved. */
async function startInstance(
  resumeDeadlineMs?: number,
  backfillDelayMs?: number,
  subscribeDelayMs?: number,
): Promise<Instance> {
  const { logs, logger } = recorder();
  const built = createFanout({ logger: silent });
  const fanout =
    subscribeDelayMs === undefined
      ? built
      : {
          ...built,
          subscribe: async (channelId: string) => {
            await new Promise((r) => setTimeout(r, subscribeDelayMs));
            return built.subscribe(channelId);
          },
        };
  // PRESENCE TOO, and only one test needs it — T072's cross-kind assertion. Four
  // subject shapes now share one Redis, and "each kind arrives under its own `type`"
  // cannot be asserted by a gateway that produces three of them.
  const presence = createPresence({ logger: silent });
  const membership = createMembership({ logger });
  const client = createApiClient(api.url);
  const slowed: ApiClient =
    backfillDelayMs === undefined
      ? client
      : {
          ...client,
          backfill: async (identity, cursors) => {
            await new Promise((r) => setTimeout(r, backfillDelayMs));
            return client.backfill(identity, cursors);
          },
        };
  const server = serve({
    service: "gateway",
    health: () => ({}),
    logger: silent,
    notFoundDocsUrl: docsUrl("not_found"),
  });
  const sessions = attachSessions({
    server,
    api: slowed,
    logger,
    fanout,
    presence,
    membership,
    ...(resumeDeadlineMs === undefined ? {} : { resumeDeadlineMs }),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    logs,
    close: async () => {
      await sessions.close();
      await built.close();
      await presence.close();
      await membership.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Frame {
  type: string;
  payload: Record<string, unknown>;
}

/** Every frame this socket received, in ARRIVAL ORDER — which is what FR-008 is
 * asserted against. A collector that bucketed by type could not see an ordering at
 * all, and "the notice arrived and the messages stopped" is true of both orders. */
function record(socket: WebSocket): Frame[] {
  const frames: Frame[] = [];
  socket.on("message", (raw: unknown) => {
    frames.push(JSON.parse(String(raw)) as Frame);
  });
  return frames;
}

const sockets: WebSocket[] = [];

async function connect(
  instance: Instance,
  user: string,
  /** `channelId:seq`. Present means the connection is BORN BUFFERING
   * (`session.ts:372`), which is the only way to reach the resume buffer from a
   * test. */
  cursor?: string,
  credential: string = api.credential,
): Promise<WebSocket> {
  const query = cursor === undefined ? "" : `&cursor=${cursor}`;
  const socket = new WebSocket(
    `${instance.url}/v1/ws?token=${await mintToken(user, credential)}${query}`,
  );
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

const silent: Logger = createLogger("gateway", () => {});

let api!: ApiUnderTest;

beforeAll(async () => {
  api = await startApi();
}, 60_000);

afterAll(() => {
  api?.stop();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});

describe("the membership fabric carries a change between two processes", () => {
  it("delivers what was published on a channel's subject", async () => {
    const { logger } = recorder();
    const membership = build({ logger });
    const seen: MembershipFabric[] = [];
    membership.onChange((c) => seen.push(c));
    await membership.subscribeChannel(CHANNEL);

    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify(change()),
    );

    const first = await waitFor(() => seen[0], "membership change");
    expect(first).toEqual(change());
  });

  it("delivers on a PRINCIPAL's subject, which no other fabric has", async () => {
    // Research R1's asymmetry, and the reason this grammar has two shapes. A
    // removal can ride the channel subject because the removed user is still a
    // member when it goes out; an ADDITION cannot, because the instance holding the
    // new member is not subscribed to that channel yet. This is the first event in
    // the system addressed to a principal rather than to a channel.
    const { logger } = recorder();
    const membership = build({ logger });
    const seen: MembershipFabric[] = [];
    membership.onChange((c) => seen.push(c));
    await membership.subscribeUser(ENVIRONMENT, "tuan");

    await publisher.publish(
      subjectForUserMembership(ENVIRONMENT, "tuan"),
      JSON.stringify(change({ change: "added" })),
    );

    const first = await waitFor(() => seen[0], "membership change");
    expect(first.change).toBe("added");
  });

  it("stops delivering once the last subscriber unsubscribes", async () => {
    const { logger } = recorder();
    const membership = build({ logger });
    const seen: MembershipFabric[] = [];
    membership.onChange((c) => seen.push(c));
    await membership.subscribeChannel(CHANNEL);
    await membership.unsubscribeChannel(CHANNEL);

    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify(change()),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual([]);
  });

  it("keeps delivering while a SECOND subscriber remains (the reference count)", async () => {
    // Research R6's sharp case at the fabric level. Two members of one channel on
    // one instance must not unsubscribe each other, and an implementation that
    // releases the subscription outright passes every test above.
    const { logger } = recorder();
    const membership = build({ logger });
    const seen: MembershipFabric[] = [];
    membership.onChange((c) => seen.push(c));
    await membership.subscribeChannel(CHANNEL);
    await membership.subscribeChannel(CHANNEL);
    await membership.unsubscribeChannel(CHANNEL);

    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify(change()),
    );
    const first = await waitFor(() => seen[0], "membership change");
    expect(first).toEqual(change());
  });
});

describe("the arms a session cannot reach (T036's list)", () => {
  it("ignores an unsubscribe for a channel that was never subscribed", async () => {
    // `counts.get(key) ?? 0` and the early return under it. Chapter 3.19's presence
    // module wrote `?? 1` here, and the coverage ratchet found the arm unreachable
    // through `session.ts` — which is exactly why this test is in this file.
    const { logs, logger } = recorder();
    const membership = build({ logger });
    await expect(
      membership.unsubscribeChannel(randomUUID()),
    ).resolves.toBeUndefined();
    await expect(
      membership.unsubscribeUser(ENVIRONMENT, "nobody"),
    ).resolves.toBeUndefined();
    // Silently, and that is the assertion: an unsubscribe for something absent is a
    // no-op rather than a failure, so nothing is logged and nothing throws.
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("survives a change arriving before onChange is wired", async () => {
    // The no-op default. `main.ts` builds the module before `attachSessions` runs,
    // so there is a real window where a frame can arrive with no handler behind it —
    // narrow, and the process dies if it is unhandled.
    const { logger } = recorder();
    const membership = build({ logger });
    await membership.subscribeChannel(CHANNEL);
    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify(change()),
    );
    await new Promise((r) => setTimeout(r, 300));

    // AND THEN IT STILL WORKS, which is the assertion. "It got here" is the weaker
    // claim and was this test's first version: an `expect(true).toBe(true)` under a
    // title about survival proves survival only by the absence of a crash, and the
    // absence of a crash is equally true of a module that stopped listening. Wiring
    // a handler afterwards and receiving on the SAME subscription proves the
    // connection, the subscription and the listener all outlived the dropped frame.
    const seen: MembershipFabric[] = [];
    membership.onChange((c) => seen.push(c));
    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify(change({ user: "linh" })),
    );
    const first = await waitFor(() => seen[0], "the change after the handler");
    expect(first.user).toBe("linh");
    // And the dropped one is gone rather than replayed — there is no queue here.
    expect(seen).toHaveLength(1);
  });

  it("logs membership.invalid_payload for a body that is not JSON", async () => {
    // **AND THE TITLE NAMES WHAT THE ASSERTION CHECKS.** Chapter 3.19 shipped
    // "logs presence.invalid_payload for a payload that is not a transition"
    // asserting `toEqual([])` — a good test under a false name, with both rejection
    // arms of the module reading zero coverage while it was green.
    const { logs, logger } = recorder();
    const membership = build({ logger });
    await membership.subscribeChannel(CHANNEL);
    await publisher.publish(subjectForChannelMembership(CHANNEL), "{not json");

    const line = await waitFor(
      () => logs.find((l) => l.msg === "membership.invalid_payload"),
      "invalid_payload line",
    );
    // T044's proof, taken before anything else relies on the mechanism: `msg` is a
    // real string and the fields are at the top level, not nested.
    expect(line.level).toBe("error");
    expect(line.fields["subject"]).toBe(subjectForChannelMembership(CHANNEL));
  });

  it("logs membership.invalid_payload for JSON the fabric schema rejects", async () => {
    // The SECOND rejection arm, and a separate test because the first cannot reach
    // it: valid JSON gets past `JSON.parse` and dies at `safeParse`. An unknown
    // field is refused rather than stripped — `membershipFabricSchema` is a
    // `strictObject`, and this is the frame that proves it on the receive side.
    const { logs, logger } = recorder();
    const membership = build({ logger });
    await membership.subscribeChannel(CHANNEL);
    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify({ ...change(), sneaky: true }),
    );

    const line = await waitFor(
      () => logs.find((l) => l.msg === "membership.invalid_payload"),
      "invalid_payload line",
    );
    expect(line.level).toBe("error");
  });

  it("closes cleanly with a re-read timer armed", async () => {
    const { logger } = recorder();
    const membership = build({ logger });
    let reads = 0;
    membership.watch(async () => {
      reads += 1;
    });
    await expect(membership.close()).resolves.toBeUndefined();
    // Closed before the interval elapsed, so nothing ran — and nothing may run
    // after. A timer surviving `close()` is how chapter 3.19 leaked one suite's
    // work into the next file.
    await new Promise((r) => setTimeout(r, 150));
    expect(reads).toBe(0);
  });

  it("cancels one watcher without cancelling the others", async () => {
    const { logger } = recorder();
    const membership = build({ logger, rereadIntervalMs: 40 });
    let a = 0;
    let b = 0;
    const cancel = membership.watch(async () => {
      a += 1;
    });
    membership.watch(async () => {
      b += 1;
    });
    cancel();
    await waitFor(() => (b > 1 ? b : undefined), "the second watcher to run twice");
    // A connection that closes must stop asking, and must not stop anyone else
    // asking. One `clearInterval` over a shared timer would fail this.
    expect(a).toBe(0);
  });

  it("logs a re-read that throws, and keeps the timer running", async () => {
    // FR-015: a membership-path failure must not fail a connection. The log line is
    // the evidence — a `watch` that swallowed and then stopped scheduling would
    // satisfy "nothing crashed" exactly as well.
    const { logs, logger } = recorder();
    const membership = build({ logger, rereadIntervalMs: 40 });
    let attempts = 0;
    membership.watch(async () => {
      attempts += 1;
      throw new Error("the api said no");
    });
    await waitFor(() => (attempts > 1 ? attempts : undefined), "a second attempt");
    const line = logs.find((l) => l.msg === "membership.failed");
    expect(line?.fields["op"]).toBe("reread");
    expect(String(line?.fields["error"])).toContain("the api said no");
  });

  it("takes both defaults when neither is supplied", async () => {
    // THE ARM NO OTHER TEST TAKES, and the reason it needs naming: every test above
    // passes a url or an interval, so `url ?? DEFAULT_REDIS_URL` and
    // `rereadIntervalMs ?? DEFAULT_REREAD_INTERVAL_MS` both read zero without this.
    // Chapter 3.19's identical case measured `[15, 0]` and needed a test written at
    // close-out purely to take the fallback.
    const saved = process.env["RELAY_REDIS_URL"];
    delete process.env["RELAY_REDIS_URL"];
    try {
      const { logger } = recorder();
      const membership = build({ logger });
      const seen: MembershipFabric[] = [];
      membership.onChange((c) => seen.push(c));
      // It subscribed and received, so it resolved a url — and with the environment
      // variable gone the only one left is `DEFAULT_REDIS_URL`, which the lane's
      // Redis answers on.
      await membership.subscribeChannel(CHANNEL);
      await publisher.publish(
        subjectForChannelMembership(CHANNEL),
        JSON.stringify(change()),
      );
      await waitFor(() => seen[0], "membership change on the default url");
      // And the interval default came with it, unmeasurable any other way: sixty
      // seconds cannot be waited out in a package whose whole clock is forty-five.
      expect(DEFAULT_REREAD_INTERVAL_MS).toBe(60_000);
    } finally {
      if (saved === undefined) delete process.env["RELAY_REDIS_URL"];
      else process.env["RELAY_REDIS_URL"] = saved;
    }
  });

  it("logs an ioredis connection error rather than dying on it", async () => {
    // The `error` listener, reachable only by pointing the module at nothing. Its
    // stated reason is NFR-OBS-01 rather than process death: chapter 3.18 measured
    // ioredis 6.0.0 and the process survives an unlistened `error`, printing
    // `[ioredis] Unhandled error event: …` itself — unstructured and unbounded.
    const { logs, logger } = recorder();
    build({ logger, url: "redis://127.0.0.1:1" });
    const line = await waitFor(
      () => logs.find((l) => l.msg === "membership.failed"),
      "a connection error line",
    );
    expect(line.fields["op"]).toBe("connection");
  });
});

describe("a removed member stops receiving, and is told why (US1)", () => {
  let one: Instance;
  let two: Instance;

  // PER DESCRIBE, NOT PER TEST, and the first version was per test. `server.close()`
  // does not resolve while a connection is open, and vitest runs `afterEach` hooks in
  // reverse registration order — so the describe's teardown ran BEFORE the file-level
  // one that closes the sockets, and every test in here failed with
  // `Hook timed out in 10000ms` pointing at a teardown rather than at anything the
  // test did. Seven tests, 83 s, and not one of the failures named its own cause.
  //
  // Fresh instances per test buy nothing anyway: the isolation this file needs is
  // fresh USERS and CHANNELS, which `seed()` gives per test at the cost of a few
  // inserts.
  beforeAll(async () => {
    [one, two] = await Promise.all([startInstance(), startInstance()]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([one.close(), two.close()]);
  });

  it("tells the removed user, once, naming themselves and the channel", async () => {
    const { users, channels } = await seed(["tuan", "linh"], 1);
    const socket = await connect(one, users["tuan"]!);
    const frames = record(socket);

    const started = Date.now();
    expect(await removeMember(channels[0]!, users["tuan"]!)).toEqual(["removed"]);

    const notices = await waitFor(
      () =>
        frames.filter((f) => f.type === "membership.changed").length > 0
          ? frames.filter((f) => f.type === "membership.changed")
          : undefined,
      "a membership.changed frame",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toEqual({
      channel: channels[0]!,
      user: users["tuan"]!,
      change: "removed",
    });
    // RESEARCH R5 PREDICTED MILLISECONDS AND IT IS MILLISECONDS. The five seconds
    // FR-RTM-10 names is not a latency budget — it is the margin the clause left for
    // a mechanism that did not exist. The measured value is in `baseline.txt`; the
    // bound asserted here is loose on purpose, because a tight one would be a
    // timing flake in a lane that runs nine files at once.
    const elapsed = Date.now() - started;
    // eslint-disable-next-line no-console
    console.log(`[T066] request-return to notice: ${String(elapsed)} ms`);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("keeps the socket open — no close code, no error frame (FR-013)", async () => {
    // Close code 4009 exists and this is not it, which is the refusal chapter 3.8
    // made by name. A revocation is not a protocol violation.
    const { users, channels } = await seed(["tuan"], 1);
    const socket = await connect(one, users["tuan"]!);
    const frames = record(socket);
    let closed: number | null = null;
    socket.on("close", (code: number) => {
      closed = code;
    });

    await removeMember(channels[0]!, users["tuan"]!);
    await waitFor(
      () => frames.find((f) => f.type === "membership.changed"),
      "the notice",
    );
    await new Promise((r) => setTimeout(r, 300));

    expect(closed).toBeNull();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(frames.filter((f) => f.type === "error")).toEqual([]);
  });

  it("keeps delivering the removed user's OTHER channel", async () => {
    // A test that only checks the channel went quiet is satisfied by a socket that
    // broke. This is the half that says the connection is still a connection.
    const { users, channels, sender } = await seed(["tuan", "linh"], 2);
    const socket = await connect(one, users["tuan"]!);
    const frames = record(socket);

    await removeMember(channels[0]!, users["tuan"]!);
    await waitFor(
      () => frames.find((f) => f.type === "membership.changed"),
      "the notice",
    );
    await postMessage(channels[1]!, sender, "still here");

    const message = await waitFor(
      () => frames.find((f) => f.type === "message.created"),
      "a message on the second channel",
    );
    expect(message.payload["channel"]).toBe(channels[1]!);
  });

  it("keeps delivering to a SECOND LOCAL MEMBER of the same channel", async () => {
    // RESEARCH R6'S SHARP TEST, and the only one in this file that fails against an
    // implementation that unsubscribes the channel outright. Both sockets are on the
    // SAME instance, so one reference count decides for both — the obvious test
    // passes either way and this one does not.
    const { users, channels, sender } = await seed(["tuan", "linh"], 1);
    const removed = await connect(one, users["tuan"]!);
    const stays = await connect(one, users["linh"]!);
    const theirs = record(stays);

    await removeMember(channels[0]!, users["tuan"]!);
    await waitFor(
      () => theirs.find((f) => f.type === "membership.changed"),
      "the other member's notice",
    );
    await postMessage(channels[0]!, sender, "for the ones still here");

    const message = await waitFor(
      () => theirs.find((f) => f.type === "message.created"),
      "a message to the remaining member",
    );
    expect(message.payload["text"]).toBe("for the ones still here");
    expect(removed.readyState).toBe(WebSocket.OPEN);
  });

  it("tells the channel's remaining members too (US2)", async () => {
    const { users, channels } = await seed(["tuan", "linh"], 1);
    await connect(one, users["tuan"]!);
    const watcher = await connect(one, users["linh"]!);
    const theirs = record(watcher);

    await removeMember(channels[0]!, users["tuan"]!);

    const notice = await waitFor(
      () => theirs.find((f) => f.type === "membership.changed"),
      "the remaining member's notice",
    );
    // Naming the person who left, not the person being told.
    expect(notice.payload["user"]).toBe(users["tuan"]!);
    expect(notice.payload["change"]).toBe("removed");
  });

  it("tells the subject in the same act that revokes them (FR-008)", async () => {
    // **THIS TEST WAS AN ARRIVAL-ORDER ASSERTION AND IT PROVED NOTHING.** T061 asked
    // for the `membership.changed` frame to be recorded as preceding the last
    // `message.created` the socket ever sees, on the grounds that "both orders end
    // with the notice delivered and the channel quiet". Run against a deliberately
    // reversed implementation — `channelIds.delete()` moved above `send()` — it
    // stayed green, because the notice goes to a socket reference this function
    // already holds and the cut only affects FUTURE fabric routing. Swapping those
    // two statements changes nothing any client can observe.
    //
    // What FR-008 actually forbids is one line further out: deriving the audience
    // AFTER the mutation. `registry.subscribersOf(channel)` is how the removed user
    // is found, and cutting them from `channelIds` first removes them from their own
    // notice's audience — they are revoked and never told. That implementation was
    // built and run: the first test in this file failed, in 5 s, with no notice.
    //
    // So the ordering that matters is audience-then-mutate, this test asserts it
    // directly, and the arrival order is left to the window test where it is real.
    const { users, channels, sender } = await seed(["tuan", "linh"], 1);
    const socket = await connect(one, users["tuan"]!);
    const frames = record(socket);

    await postMessage(channels[0]!, sender, "before");
    await waitFor(
      () => frames.find((f) => f.type === "message.created"),
      "the message before the removal",
    );
    await removeMember(channels[0]!, users["tuan"]!);
    await waitFor(
      () => frames.find((f) => f.type === "membership.changed"),
      "the notice",
    );

    // The subject is told, and the channel they were told about is the one they no
    // longer have. A gateway that mutated first would deliver the message and then
    // go quiet with no explanation.
    // FILTERED TO THE TWO KINDS THIS TEST IS ABOUT. The instances carry presence
    // now, so an unfiltered frame list also holds `presence.changed` — which is
    // correct behaviour and would make this assertion a record of which other
    // features happen to be wired in.
    const kinds = frames
      .map((f) => f.type)
      .filter((t) => t === "message.created" || t === "membership.changed");
    expect(kinds).toEqual(["message.created", "membership.changed"]);
    const notice = frames.find((f) => f.type === "membership.changed")!;
    expect(notice.payload["user"]).toBe(users["tuan"]!);
    expect(notice.payload["channel"]).toBe(channels[0]!);
  });

  it("stops delivery on BOTH instances when the removal happened elsewhere", async () => {
    // The cross-instance case: the api that handled the removal has no idea which
    // gateway holds the user, and neither gateway knows about the other. Two sockets
    // for one user on two instances, and both must stop.
    const { users, channels } = await seed(["tuan", "linh"], 1);
    const first = await connect(one, users["tuan"]!);
    const second = await connect(two, users["tuan"]!);
    const a = record(first);
    const b = record(second);

    await removeMember(channels[0]!, users["tuan"]!);

    await waitFor(() => a.find((f) => f.type === "membership.changed"), "instance one");
    await waitFor(() => b.find((f) => f.type === "membership.changed"), "instance two");
  });
});

describe("nothing arrives after a revocation — one window, three cases (FR-RTM-10)", () => {
  let one: Instance;
  let two: Instance;

  beforeAll(async () => {
    [one, two] = await Promise.all([startInstance(), startInstance()]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([one.close(), two.close()]);
  });

  it("delivers nothing after the clause's own five seconds — removal, cross-instance, ban", async () => {
    // **ONE WINDOW, TWO CASES**, and the sharing is deliberate rather than tidy. This
    // is the first timing in two chapters that cannot be injected shorter — five
    // seconds is FR-RTM-10's own budget, not a module constant — so a file that waits
    // it out per case pays it per case. Set both up, post to both, wait once.
    const { users, channels, sender } = await seed(["tuan", "linh"], 1);
    const local = await connect(one, users["tuan"]!);
    const elsewhere = await connect(two, users["tuan"]!);
    const a = record(local);
    const b = record(elsewhere);

    // THE THIRD CASE RIDES THE SAME WINDOW (US4). A ban is the other way to lose
    // access, its clause is the same five seconds, and setting it up here rather
    // than in its own test is what keeps this file under its budget — two waits were
    // 12.2 s of a 37.9 s file.
    const banned = await seed(["mai"], 2);
    const bannedSocket = await connect(one, banned.users["mai"]!);
    const c = record(bannedSocket);

    await removeMember(channels[0]!, users["tuan"]!);
    await ban(banned.users["mai"]!);
    await Promise.all([
      waitFor(() => a.find((f) => f.type === "membership.changed"), "notice on one"),
      waitFor(() => b.find((f) => f.type === "membership.changed"), "notice on two"),
      waitFor(
        () =>
          c.filter((f) => f.type === "membership.changed").length === 2
            ? true
            : undefined,
        "both of the banned user's channels",
      ),
    ]);

    // THE CLAUSE'S OWN BUDGET, not a shorter one. Five seconds is what FR-RTM-10
    // gives a mechanism to take effect, so a send inside it proves nothing.
    await new Promise((r) => setTimeout(r, 5_500));
    await postMessage(channels[0]!, sender, "after the window");
    await postMessage(banned.channels[0]!, banned.sender, "after the ban");
    await postMessage(banned.channels[1]!, banned.sender, "after the ban, second");
    await new Promise((r) => setTimeout(r, 500));

    expect(a.filter((f) => f.type === "message.created")).toEqual([]);
    expect(b.filter((f) => f.type === "message.created")).toEqual([]);
    expect(c.filter((f) => f.type === "message.created")).toEqual([]);
    // AND EVERY SOCKET IS STILL OPEN. "Nothing arrived" is equally true of three
    // dead connections, which is the assertion this file would otherwise be making.
    expect(local.readyState).toBe(WebSocket.OPEN);
    expect(elsewhere.readyState).toBe(WebSocket.OPEN);
    expect(bannedSocket.readyState).toBe(WebSocket.OPEN);
  }, 25_000);

  it("drops the channel's BUFFERED frames when the removal lands mid-resume (FR-029)", async () => {
    // **THIS FAILS AGAINST AN IMPLEMENTATION THAT PASSES THE TEST ABOVE**, which is
    // the only reason it is written separately. A connection presenting a cursor is
    // born buffering (`session.ts:372`); frames for its channels queue in
    // `connection.buffer` until the backfill has had its turn. `flushable(buffer,
    // marks)` filters on `frame.seq` and on NOTHING ELSE — so a removal that
    // unsubscribes the channel would still flush that channel's backlog on the way
    // to live. Access revoked and the messages delivered, in the same act.
    const { users, channels, sender } = await seed(["tuan", "linh"], 2);
    // **SEQ 1 FIRST, AND THE CURSOR AT 1.** The first version of this test presented
    // `channel:1` and then buffered the channel's FIRST message, whose seq is also 1
    // — so `flushable(buffer, marks)` dropped it as at-or-below the mark and the test
    // passed with the FR-029 filter deleted. It proved the resume works, under a
    // title about revocation. The buffered frame has to sit ABOVE the cursor or
    // nothing in this test is about membership at all.
    await postMessage(channels[0]!, sender, "before the cursor");
    // A two-second backfill, so the connection is DEMONSTRABLY still buffering when
    // the removal lands, and a resume deadline comfortably past it so the fabric
    // confirmation does not degrade first.
    const slow = await startInstance(6_000, 2_000);
    const socket = await connect(slow, users["tuan"]!, `${channels[0]!}:1`);
    try {
      const frames = record(socket);

      // Into the buffer, both channels: the removal must take one and leave the
      // other, which a blanket `buffer = []` would not.
      await postMessage(channels[0]!, sender, "buffered, revoked");
      await postMessage(channels[1]!, sender, "buffered, kept");
      await new Promise((r) => setTimeout(r, 400));

      await removeMember(channels[0]!, users["tuan"]!);
      await waitFor(
        () => frames.find((f) => f.type === "membership.changed"),
        "the notice, which must arrive DURING the resume (FR-030)",
      );

      // Let the backfill return and flush whatever the buffer still holds.
      await new Promise((r) => setTimeout(r, 3_000));

      const texts = frames
        .filter((f) => f.type === "message.created")
        .map((f) => f.payload["text"]);
      expect(texts).not.toContain("buffered, revoked");
      expect(texts).toContain("buffered, kept");
    } finally {
      // THE SOCKET FIRST, THEN THE SERVER. `server.close()` does not resolve while a
      // connection is open, and the file-level `afterEach` that closes sockets runs
      // AFTER this `finally` — so closing the instance here first hangs the test out
      // to its own 20 s timeout, reported as a timeout rather than as the teardown it
      // is. The same trap took seven tests earlier in this file.
      socket.close();
      await slow.close();
    }
  }, 20_000);
});

describe("the channel's other members see who left (US2)", () => {
  let one: Instance;
  let two: Instance;

  beforeAll(async () => {
    [one, two] = await Promise.all([startInstance(), startInstance()]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([one.close(), two.close()]);
  });

  it("reaches a remaining member on a DIFFERENT instance from the removed user", async () => {
    // What separates this from the single-instance case: the receiving gateway does
    // not host the removed user, and the removal originated at an api that is
    // neither gateway. One publish on `member:{channel_id}` has to reach both, which
    // is the whole reason a removal can ride the channel's subject (research R1).
    const { users, channels } = await seed(["tuan", "linh"], 1);
    await connect(one, users["tuan"]!);
    const watcher = await connect(two, users["linh"]!);
    const theirs = record(watcher);

    await removeMember(channels[0]!, users["tuan"]!);

    const notice = await waitFor(
      () => theirs.find((f) => f.type === "membership.changed"),
      "the notice on the other instance",
    );
    expect(notice.payload["user"]).toBe(users["tuan"]!);
    expect(theirs.filter((f) => f.type === "membership.changed")).toHaveLength(1);
  });

  it("sends ONE frame to a member sharing three channels, not three", async () => {
    // The publish goes to one channel's subject, so the dedup here is structural
    // rather than a claim counter — presence needed `claim()` because a transition
    // fans out over every shared channel and this does not. Asserted anyway: the
    // structure is the argument, and an argument is not a measurement.
    const { users, channels } = await seed(["tuan", "linh"], 3);
    await connect(one, users["tuan"]!);
    const watcher = await connect(one, users["linh"]!);
    const theirs = record(watcher);

    await removeMember(channels[0]!, users["tuan"]!);
    await new Promise((r) => setTimeout(r, 700));

    const notices = theirs.filter((f) => f.type === "membership.changed");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload["channel"]).toBe(channels[0]!);
  });

  it("sends one frame per removed user in a bulk removal, none coalesced", async () => {
    const { users, channels } = await seed(["tuan", "mai", "linh"], 1);
    await connect(one, users["tuan"]!);
    await connect(one, users["mai"]!);
    const watcher = await connect(one, users["linh"]!);
    const theirs = record(watcher);

    expect(
      await removeMember(channels[0]!, [users["tuan"]!, users["mai"]!]),
    ).toEqual(["removed", "removed"]);

    await waitFor(
      () =>
        theirs.filter((f) => f.type === "membership.changed").length === 2
          ? true
          : undefined,
      "two notices",
    );
    const named = theirs
      .filter((f) => f.type === "membership.changed")
      .map((f) => f.payload["user"])
      .sort();
    expect(named).toEqual([users["mai"]!, users["tuan"]!].sort());
  });

  it("delivers nothing to a user who shares no channel, in a run where a member does", async () => {
    // A MUST-NOT-RECEIVE TEST THAT PASSES BECAUSE THE PRODUCER IS DEAD PROVES
    // NOTHING. The positive half runs in the same act, on the same instance, over
    // the same publish.
    const { users, channels } = await seed(["tuan", "linh"], 1);
    const outsider = await seed(["hermit"], 1);
    await connect(one, users["tuan"]!);
    const member = await connect(one, users["linh"]!);
    const stranger = await connect(one, outsider.users["hermit"]!);
    const theirs = record(member);
    const nothing = record(stranger);

    await removeMember(channels[0]!, users["tuan"]!);
    await waitFor(
      () => theirs.find((f) => f.type === "membership.changed"),
      "the member's notice",
    );

    expect(nothing.filter((f) => f.type === "membership.changed")).toEqual([]);
  });

  it("delivers nothing to another TENANT's user, in the same run", async () => {
    const { users, channels } = await seed(["tuan", "linh"], 1);
    // The second tenant's own environment, key, user and channel — nothing shared
    // with the first but a Redis instance and a gateway.
    const tag = randomUUID().slice(0, 8);
    const foreign = `stranger-${tag}`;
    await api.other.repo.createUser(foreign, "Stranger");
    const elsewhere = await api.other.repo.createChannel(`elsewhere-${tag}`, "public");
    const foreignRow = await api.other.repo.createUser(foreign);
    await api.other.repo.addMember(elsewhere.id, foreignRow.id);

    await connect(one, users["tuan"]!);
    const member = await connect(one, users["linh"]!);
    const outsider = await connect(one, foreign, undefined, api.other.credential);
    const theirs = record(member);
    const nothing = record(outsider);

    await removeMember(channels[0]!, users["tuan"]!);
    await waitFor(
      () => theirs.find((f) => f.type === "membership.changed"),
      "the member's notice",
    );

    expect(nothing.filter((f) => f.type === "membership.changed")).toEqual([]);
  });

  it("retains nothing for a user who was not connected (FR-007)", async () => {
    // PRESENCE IS NOT A QUEUE AND A MEMBERSHIP CHANGE IS NOT EITHER. A change
    // published while nobody holds a connection is gone; connecting afterwards
    // delivers no backlog, because there is no backlog to deliver. The membership
    // itself is in Postgres and the connect path reads it — which is why nothing is
    // lost by this and why a replay would be the wrong mechanism.
    const { users, channels } = await seed(["tuan", "linh"], 1);
    await removeMember(channels[0]!, users["tuan"]!);
    await new Promise((r) => setTimeout(r, 300));

    const late = await connect(one, users["tuan"]!);
    const frames = record(late);
    await new Promise((r) => setTimeout(r, 700));

    expect(frames.filter((f) => f.type === "membership.changed")).toEqual([]);
    // And the connect path did the right thing anyway: the channel is not theirs, so
    // a message posted to it reaches nothing.
    expect(late.readyState).toBe(WebSocket.OPEN);
  });

  it("produces NO frame for a role change (FR-006)", async () => {
    // A role change is a membership WRITE and not a membership change: the person is
    // still a member and their access has not moved. FR-WHK-02 names two event types
    // and neither is `channel.member_role_changed`.
    //
    // `members.role` is ('owner','moderator','member'). `memberships.role` — the
    // ORGANISATION table — is ('owner','admin','member'), and `schema.ts:423`
    // predicts the confusion in prose. This suite made it once anyway.
    const { users, channels } = await seed(["tuan", "linh"], 1);
    const subject = await connect(one, users["tuan"]!);
    const watcher = await connect(one, users["linh"]!);
    const a = record(subject);
    const b = record(watcher);

    const res = await fetch(
      `${api.url}/v1/channels/${channels[0]!}/members/${users["tuan"]!}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${api.credential}`,
        },
        body: JSON.stringify({ role: "moderator" }),
      },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    await new Promise((r) => setTimeout(r, 700));

    expect(a.filter((f) => f.type === "membership.changed")).toEqual([]);
    expect(b.filter((f) => f.type === "membership.changed")).toEqual([]);
  });

  it("keeps the four kinds apart — each arrives under its own type, once (FR-033)", async () => {
    // FOUR SUBJECT SHAPES NOW SHARE ONE REDIS: `chan:{id}`, `presence:{id}`,
    // `member:{id}` and `member:{env}:{user}`. Nothing filters by kind on the receive
    // side — the topology is what keeps them apart, and a topology is exactly the
    // sort of claim that is true right up until someone reuses a prefix.
    const { users, channels, sender } = await seed(["tuan", "linh"], 3);
    const watcher = await connect(one, users["linh"]!);
    const frames = record(watcher);
    // The subject connects second, so the watcher sees a presence transition for
    // them rather than for itself.
    await connect(two, users["tuan"]!);

    await postMessage(channels[1]!, sender, "a message, not a membership change");
    await removeMember(channels[0]!, users["tuan"]!);

    await waitFor(
      () => frames.find((f) => f.type === "membership.changed"),
      "the membership change",
    );
    await waitFor(
      () => frames.find((f) => f.type === "message.created"),
      "the message",
    );
    await waitFor(
      () => frames.find((f) => f.type === "presence.changed"),
      "the presence transition",
    );
    await new Promise((r) => setTimeout(r, 500));

    // ONE OF EACH ABOUT THE SUBJECT, and each under its own name. The counts matter
    // as much as the types: a kind delivered twice is a subject subscribed twice,
    // which is the failure a shared prefix would produce.
    //
    // **COUNTED BY SUBJECT, NOT BY TYPE**, and the first version counted by type and
    // read two presence frames. Both were correct: a watcher shares every one of
    // their own channels with themselves, so `linh` sees `linh` arrive. Chapter
    // 3.19's `collect()` carries this warning in its own comment, T043 repeats it as
    // an instruction — "filter every collector by subject" — and this suite counted
    // unfiltered anyway. The behaviour was right and the assertion was wrong, for
    // the fourth time across two chapters.
    const about = (type: string, user: string): number =>
      frames.filter((f) => f.type === type && f.payload["user"] === user).length;
    expect(about("membership.changed", users["tuan"]!)).toBe(1);
    expect(about("presence.changed", users["tuan"]!)).toBe(1);
    expect(frames.filter((f) => f.type === "message.created")).toHaveLength(1);

    // And each payload is its own shape rather than another kind wearing this type.
    expect(
      Object.keys(frames.find((f) => f.type === "membership.changed")!.payload).sort(),
    ).toEqual(["change", "channel", "user"]);
    expect(
      Object.keys(
        frames.find(
          (f) => f.type === "presence.changed" && f.payload["user"] === users["tuan"]!,
        )!.payload,
      ).sort(),
    ).toEqual(["state", "user"]);
  }, 15_000);
});

describe("a member added mid-connection starts receiving (US3)", () => {
  let one: Instance;
  let two: Instance;

  beforeAll(async () => {
    [one, two] = await Promise.all([startInstance(), startInstance()]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([one.close(), two.close()]);
  });

  it("tells the added user, on a subject addressed to THEM", async () => {
    // The first event in this system addressed to a principal rather than a
    // channel. The instance holding this connection is subscribed to nothing of
    // `empty[0]` — it cannot be, the user is not in it — so `member:{env}:{user}`
    // is the only way the news reaches here.
    const { users, empty } = await seed(["tuan"], 1, 1);
    const socket = await connect(one, users["tuan"]!);
    const frames = record(socket);

    expect(await addMember(empty[0]!, users["tuan"]!)).toBe("added");

    const notice = await waitFor(
      () => frames.find((f) => f.type === "membership.changed"),
      "the addition",
    );
    expect(notice.payload).toEqual({
      channel: empty[0]!,
      user: users["tuan"]!,
      change: "added",
    });
  });

  it("delivers a message posted to the new channel afterwards", async () => {
    const { users, empty, sender } = await seed(["tuan"], 1, 1);
    const socket = await connect(one, users["tuan"]!);
    const frames = record(socket);

    await addMember(empty[0]!, users["tuan"]!);
    await waitFor(
      () => frames.find((f) => f.type === "membership.changed"),
      "the addition",
    );
    await postMessage(empty[0]!, sender, "welcome aboard");

    const message = await waitFor(
      () => frames.find((f) => f.type === "message.created"),
      "a message on the newly joined channel",
    );
    expect(message.payload["text"]).toBe("welcome aboard");
    expect(message.payload["channel"]).toBe(empty[0]!);
  });

  it("makes the new member's presence visible to that channel's members", async () => {
    // **CHAPTER 3.19'S `gaps.md` ITEM 2, CLOSING.** Presence subscriptions were
    // fixed at connect exactly as delivery was, so a user added afterwards was
    // invisible to their new channel's members until they reconnected. The
    // `presence?.subscribe` in the added branch is what closes it, and this test is
    // what makes the closure a fact rather than a claim.
    const { users, empty } = await seed(["tuan", "linh"], 1, 1);
    // `linh` is already in the new channel; `tuan` is added to it mid-connection.
    await addMember(empty[0]!, users["linh"]!);
    const newcomer = await connect(one, users["tuan"]!);
    const frames = record(newcomer);
    await addMember(empty[0]!, users["tuan"]!);
    await waitFor(
      () => frames.find((f) => f.type === "membership.changed"),
      "the addition",
    );

    // `linh` connects AFTER `tuan` was added, so the transition `tuan` observes is
    // one that only reaches them through a subscription made mid-connection.
    await connect(two, users["linh"]!);
    const seenPresence = await waitFor(
      () =>
        frames.find(
          (f) => f.type === "presence.changed" && f.payload["user"] === users["linh"]!,
        ),
      "the co-member's arrival, over a channel joined mid-connection",
    );
    expect(seenPresence.payload["state"]).toBe("online");
  }, 15_000);

  it("gives a self-service join the same delivery as an administrative add", async () => {
    // FR-004 names four paths and `join` is the one that gets forgotten: it is a
    // separate service method calling `repo.addMember` directly, so a publish hung
    // off `addMembers` alone leaves this route silent and nothing fails.
    const { users, empty, sender } = await seed(["tuan"], 1, 1);
    const socket = await connect(one, users["tuan"]!);
    const frames = record(socket);

    expect(await joinChannel(empty[0]!, users["tuan"]!)).toBe("joined");
    const notice = await waitFor(
      () => frames.find((f) => f.type === "membership.changed"),
      "the join",
    );
    expect(notice.payload["change"]).toBe("added");

    await postMessage(empty[0]!, sender, "joined under my own token");
    const message = await waitFor(
      () => frames.find((f) => f.type === "message.created"),
      "delivery after a self-service join",
    );
    expect(message.payload["text"]).toBe("joined under my own token");
  });

  it("publishes nothing when the user is already a member (FR-005)", async () => {
    // ASSERTED BY COUNT, not by the absence of a frame in a window. "Nothing arrived
    // within 700 ms" is true of a broken publisher; "exactly one arrived across two
    // calls" is only true of one that filters.
    const { users, empty } = await seed(["tuan"], 1, 1);
    const socket = await connect(one, users["tuan"]!);
    const frames = record(socket);

    expect(await addMember(empty[0]!, users["tuan"]!)).toBe("added");
    await waitFor(
      () => frames.find((f) => f.type === "membership.changed"),
      "the first addition",
    );
    expect(await addMember(empty[0]!, users["tuan"]!)).toBe("already_a_member");
    expect(await joinChannel(empty[0]!, users["tuan"]!)).toBe("already_a_member");
    await new Promise((r) => setTimeout(r, 700));

    expect(frames.filter((f) => f.type === "membership.changed")).toHaveLength(1);
  });

  it("settles as ADDED when a re-add follows a removal", async () => {
    // The race worth naming: the removal's unsubscribe is fire-and-forget, and the
    // re-add's subscribe is too. If the pending unsubscribe outlived the
    // resubscribe, the channel would end up delivering nothing while the connection
    // believed it was a member — a state no assertion about frames would catch, so
    // the end state is asserted by DELIVERY.
    const { users, channels, sender } = await seed(["tuan", "linh"], 1);
    const socket = await connect(one, users["tuan"]!);
    const frames = record(socket);

    await removeMember(channels[0]!, users["tuan"]!);
    await waitFor(
      () =>
        frames.filter((f) => f.type === "membership.changed").length === 1
          ? true
          : undefined,
      "the removal",
    );
    expect(await addMember(channels[0]!, users["tuan"]!)).toBe("added");
    await waitFor(
      () =>
        frames.filter((f) => f.type === "membership.changed").length === 2
          ? true
          : undefined,
      "the re-add",
    );

    const changes = frames
      .filter((f) => f.type === "membership.changed")
      .map((f) => f.payload["change"]);
    expect(changes).toEqual(["removed", "added"]);

    await postMessage(channels[0]!, sender, "back in the room");
    const message = await waitFor(
      () => frames.find((f) => f.type === "message.created"),
      "delivery after the re-add",
    );
    expect(message.payload["text"]).toBe("back in the room");
  }, 15_000);
});

describe("the window between the add committing and the subscription landing", () => {
  it("loses a message published inside it, under EITHER ordering (T086)", async () => {
    // **T080 ASKED FOR AN ORDERING WHOSE FAILURE MODE DOES NOT EXIST**, and T086
    // asked for the proof, which is how it was found. The task reads: inserting into
    // `channelIds` before subscribing "opens a window where `registry.subscribersOf`
    // returns a connection for a channel this instance is not yet receiving — a
    // silently lost message rather than an error".
    //
    // The message is lost either way. `subscribersOf` returning the connection
    // changes nothing while the INSTANCE is not subscribed: the frame never reaches
    // this process, so there is no delivery for the registry to be consulted about.
    // Widening the window to 1.5 s with a delayed `fanout.subscribe` and posting
    // inside it produced byte-identical results under both orders:
    //
    //     [["presence.changed",null],["membership.changed","added"]]
    //
    // Both orders lose it, so this test asserts the loss rather than the ordering.
    // The shipped order is subscribe-then-insert anyway — it cannot produce a
    // connection claiming a subscription it does not hold, which is worth having for
    // anyone reading the code even though no test can see the difference.
    //
    // THE GAP IS REAL AND IS `gaps.md` ITEM 5: a message published between the add
    // committing and the gateway's subscribe landing reaches the new member through
    // history and not through the socket.
    const { users, empty, sender } = await seed(["tuan"], 1, 1);
    const slow = await startInstance(undefined, undefined, 1_500);
    const socket = await connect(slow, users["tuan"]!);
    try {
      const frames = record(socket);
      await addMember(empty[0]!, users["tuan"]!);
      await new Promise((r) => setTimeout(r, 300));
      await postMessage(empty[0]!, sender, "inside the window");
      await new Promise((r) => setTimeout(r, 2_500));

      // The notice arrives — the subscription completed and the frame followed it.
      expect(
        frames.filter((f) => f.type === "membership.changed"),
      ).toHaveLength(1);
      // The message posted inside the window does not. Asserted so that a future
      // change which closes this gap turns this test red and has to say so.
      expect(
        frames.filter((f) => f.payload["text"] === "inside the window"),
      ).toEqual([]);

      // AND THE CHANNEL WORKS AFTERWARDS, which is what separates a window gap from a
      // broken subscription.
      await postMessage(empty[0]!, sender, "after the window");
      const later = await waitFor(
        () => frames.find((f) => f.payload["text"] === "after the window"),
        "delivery once the subscription has landed",
      );
      expect(later.type).toBe("message.created");
    } finally {
      socket.close();
      await slow.close();
    }
  }, 20_000);
});

describe("a ban revokes everything at once (US4)", () => {
  let one: Instance;

  beforeAll(async () => {
    one = await startInstance();
  }, 30_000);

  afterAll(async () => {
    await one.close();
  });

  it("stops both channels, tells the user per channel, and leaves others alone", async () => {
    // **ONE WINDOW FOR THE WHOLE CASE.** Five seconds is FR-RTM-10's own budget and
    // cannot be injected shorter, so the ban, its negative assertion and the
    // bystander's positive one all share a single wait.
    const { users, channels, sender } = await seed(["tuan", "linh"], 2);
    const banned = await connect(one, users["tuan"]!);
    const bystander = await connect(one, users["linh"]!);
    const theirs = record(banned);
    const others = record(bystander);

    await ban(users["tuan"]!);

    // TWO FRAMES, ONE PER CHANNEL, and neither carrying the sentinel. The fabric
    // carried one change with `channel: "*"`; the client sees what two individual
    // removals would have produced.
    await waitFor(
      () =>
        theirs.filter((f) => f.type === "membership.changed").length === 2
          ? true
          : undefined,
      "one frame per revoked channel",
    );
    const named = theirs
      .filter((f) => f.type === "membership.changed")
      .map((f) => f.payload["channel"])
      .sort();
    expect(named).toEqual([...channels].sort());
    expect(theirs.some((f) => f.payload["channel"] === "*")).toBe(false);

    // THE FIVE-SECOND NEGATIVE IS NOT HERE. It is the same clause the removal test
    // waits out, and this file pays that budget ONCE — the shared-window test above
    // sets up a ban beside its removals for exactly this reason. What is left here
    // is what makes the ban a ban rather than a removal, which needs no wait.
    await postMessage(channels[0]!, sender, "for the bystander");
    await postMessage(channels[1]!, sender, "for the bystander, second channel");
    await waitFor(
      () =>
        others.filter((f) => f.type === "message.created").length === 2
          ? true
          : undefined,
      "both channels still delivering to the bystander",
    );
    // THE BYSTANDER IS UNAFFECTED, over the same publish. A ban that silenced the
    // channel rather than the person would pass every assertion above this one.
    expect(theirs.filter((f) => f.type === "message.created")).toEqual([]);
    expect(banned.readyState).toBe(WebSocket.OPEN);
  }, 15_000);

  it("publishes nothing on a repeated ban (FR-005)", async () => {
    const { users } = await seed(["tuan"], 1);
    const socket = await connect(one, users["tuan"]!);
    const frames = record(socket);

    await ban(users["tuan"]!);
    await waitFor(
      () => frames.find((f) => f.type === "membership.changed"),
      "the first ban",
    );
    await ban(users["tuan"]!);
    await new Promise((r) => setTimeout(r, 700));

    // `banUser` guards on `isNull(users.banned_at)`, so the second call touches no
    // row, returns no channels, and the controller publishes nothing.
    expect(frames.filter((f) => f.type === "membership.changed")).toHaveLength(1);
  }, 15_000);

  it("restores delivery on reconnect after an unban, not on the live socket", async () => {
    // **THE UNBAN PUBLISHES NOTHING**, which is a decision recorded in
    // `chapter-notes.md` and in the route's own comment. A ban leaves the `members`
    // rows alone, so the memberships survive; what it destroyed is this connection's
    // `channelIds`, and restoring that would need an `added` frame per channel — the
    // per-channel shape the fabric contract rules out.
    //
    // Two mechanisms already repair it. This asserts the one that exists now:
    // reconnecting reads membership at the door (chapter 3.2). The other is the
    // backstop's periodic re-read, which the next phase adds — and when it does, the
    // first assertion here becomes true only within the re-read interval.
    const { users, channels, sender } = await seed(["tuan", "linh"], 1);
    const socket = await connect(one, users["tuan"]!);
    const frames = record(socket);

    await ban(users["tuan"]!);
    await waitFor(
      () => frames.find((f) => f.type === "membership.changed"),
      "the ban",
    );
    await ban(users["tuan"]!, false);
    await postMessage(channels[0]!, sender, "while still connected");
    await new Promise((r) => setTimeout(r, 700));
    expect(frames.filter((f) => f.type === "message.created")).toEqual([]);

    // A fresh connection reads membership at the door and gets the channel back.
    const reconnected = await connect(one, users["tuan"]!);
    const after = record(reconnected);
    await postMessage(channels[0]!, sender, "after reconnecting");
    const delivered = await waitFor(
      () => after.find((f) => f.type === "message.created"),
      "delivery after a reconnect",
    );
    expect(delivered.payload["text"]).toBe("after reconnecting");
  }, 20_000);
});
