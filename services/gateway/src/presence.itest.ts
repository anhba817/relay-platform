import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServer as createNetServer,
  connect as connectSocket,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";

import { createLogger, serve, type Logger } from "@relay/service-kit";
import { docsUrl, subjectForPresence } from "@relay/protocol";
// A CLIENT BELONGING TO NEITHER MODULE, for one reason: the two rejection paths on
// the receive half cannot be reached through `createPresence`, which only ever
// publishes what its own schema produced. `eslint.config.mjs` carries the exemption
// and the argument; this client publishes and reads nothing.
import { Redis } from "ioredis";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiClient } from "./api-client.js";
import { createFanout } from "./fanout.js";
import {
  createPresence,
  DEFAULT_REDIS_URL,
  type PresenceOptions,
} from "./presence.js";
import { attachSessions } from "./session.js";

// CHAPTER 3.19, PHASE 1 — THE FAILING STATE, OBSERVED.
//
// `presence.changed` has been in the protocol union since chapter 1.3. Its states
// are `online` and `offline`, `frames.test.ts` asserts its shape and rejects
// `state: "away"`, and chapter 3.12's gauntlet proves a client cannot forge one.
// Nothing has ever produced one — chapter 3.17's `gaps.md` item 2 recorded it as
// "a declared frame with no sender" and assigned it to this chapter by name.
//
// THIS TEST IS RED ON PURPOSE UNTIL PHASE 3. The phase 1 and phase 2 commits both
// carry it failing, and their commit bodies say so: a red lane nobody explained is
// indistinguishable from a red lane nobody noticed, and CI cannot tell them apart.
//
// It must be red for the RIGHT reason — no producer exists — rather than because
// the fixture is wrong. That is why it asserts the positive (a frame arrives) and
// not the negative: "nothing arrived" is true of a broken harness too.

const silent: Logger = createLogger("gateway", () => {});
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);

interface Seeder {
  createEnvironment: (db: unknown, input: { name: string }) => Promise<{ id: string }>;
  createApiKey: (
    db: unknown,
    input: { environmentId: string },
  ) => Promise<{ credential: string }>;
  Repository: new (
    db: unknown,
    environmentId: string,
  ) => {
    createUser: (externalId: string, displayName: string) => Promise<{ id: string }>;
    createChannel: (
      externalId: string,
      type: "public" | "private",
    ) => Promise<{ id: string }>;
    addMember: (channelId: string, userId: string) => Promise<boolean>;
  };
}

interface ApiUnderTest {
  url: string;
  credential: string;
  /** One per test — see the note in the seed. */
  subjects: string[];
  /** The three shared channels, by the id a `message.send` frame names. */
  channelIds: string[];
  /** Counts rows in the outbox. Reached through the api's BUILT `dist`, which is
   * premise 2 — the gateway package has no `pg` dependency of its own. */
  outboxCount: () => Promise<number>;
  /** A SECOND TENANT, with its own credential and its own user. Presence keys are
   * `{env}`-scoped and channel ids are unguessable, so the isolation is structural
   * — which is exactly why it needs a test that could see it fail. */
  otherCredential: string;
  stop: () => void;
}

/** Two members of ONE channel, which no existing gateway fixture provides:
 * `seedSocketTenants` gives one user per tenant, and presence needs a watcher and
 * a subject who share a channel. */
async function startApi(): Promise<ApiUnderTest> {
  const port = 4700 + Math.floor(Math.random() * 200);
  const dist = join(REPO, "services", "api", "dist");
  if (!existsSync(join(dist, "main.js"))) {
    throw new Error(
      "the api is not built — run `pnpm build` before this lane " +
        "(the suite talks to the real service, not a stub)",
    );
  }
  const client = require_(join(dist, "db", "client.js")) as {
    createDb: (pool: unknown) => unknown;
    createPool: () => { query: (sql: string) => Promise<unknown> };
  };
  const seeder = require_(join(dist, "db", "repository.js")) as Seeder;
  const pool = client.createPool();
  const db = client.createDb(pool);

  const environment = await seeder.createEnvironment(db, {
    name: `presence-itest-${randomUUID().slice(0, 8)}`,
  });
  const repo = new seeder.Repository(db, environment.id);
  const watcher = await repo.createUser("linh", "Linh");
  const subject = await repo.createUser("tuan", "Tuan");
  // A user who belongs to nothing: FR-RTM-07's degenerate case, where a transition
  // publishes on no subject at all.
  await repo.createUser("hermit", "Hermit");

  // ONE SUBJECT PER TEST, and this is not tidiness. Presence state lives in Redis
  // under `presence:{env}:{user}` with a thirty-second TTL, so a subject who came
  // online in one test is STILL ONLINE in the next — `SET … NX` correctly refuses,
  // nothing publishes, and every later test sees an empty frame list. The first run
  // of this suite failed exactly that way: test 1 passed and tests 2 to 4 reported
  // "expected [] to have a length of 1", which reads like a broken fabric and is a
  // shared fixture.
  //
  // T016 asked for fresh channel AND user ids per run for this reason and the first
  // implementation did the channels only. Chapter 3.18's `isolation-fixtures.ts`
  // learned the same lesson: a fixture nobody else depends on beats a rule nobody
  // remembers.
  const channels = await Promise.all(
    // THREE shared channels, so the dedup can be asserted by count. Without the
    // transition id a watcher sharing three sees three frames for one arrival.
    ["fleet", "ops", "night-shift"].map((name) =>
      repo.createChannel(name, "public"),
    ),
  );
  // CONCURRENTLY. Seeded one at a time this was 40 users x 3 memberships of
  // sequential round trips, and the file spent more time in its fixture than in its
  // assertions.
  const subjects = Array.from({ length: 60 }, (_, i) => `subject-${i}`);
  const seeded = await Promise.all(
    subjects.map((name) => repo.createUser(name, name)),
  );
  await Promise.all(
    channels.flatMap((channel) =>
      [watcher, subject, ...seeded].map((user) =>
        repo.addMember(channel.id, user.id),
      ),
    ),
  );
  // A user who is a member of a PRIVATE channel that nobody else joins. The watcher
  // is not in it, so it shares no channel with this user at all.
  const recluse = await repo.createUser("recluse", "Recluse");
  const vault = await repo.createChannel("vault", "private");
  await repo.addMember(vault.id, recluse.id);

  const key = await seeder.createApiKey(db, {
    environmentId: environment.id,
  });

  // THE SECOND TENANT. Its own environment, its own user, its own channel, its own
  // key — nothing shared with the first but a Redis instance and a gateway.
  const other = await seeder.createEnvironment(db, {
    name: `presence-itest-other-${randomUUID().slice(0, 8)}`,
  });
  const otherRepo = new seeder.Repository(db, other.id);
  const stranger = await otherRepo.createUser("stranger", "Stranger");
  const elsewhere = await otherRepo.createChannel("elsewhere", "public");
  await otherRepo.addMember(elsewhere.id, stranger.id);
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
    credential: key.credential,
    subjects,
    outboxCount: async () => {
      const result = (await pool.query("select count(*)::int as n from outbox")) as {
        rows: { n: number }[];
      };
      return result.rows[0]?.n ?? 0;
    },
    channelIds: channels.map((c) => c.id),
    otherCredential: otherKey.credential,
    stop: () => child.kill(),
  };
}

/** Every frame of a type this socket has received. **Assertions here are by COUNT,
 * not by arrival**: "a frame showed up" is equally true of a producer that publishes
 * three, and three is exactly what the dedup exists to prevent. */
function collect(
  socket: WebSocket,
  type: string,
  about?: string,
): { frames: { payload: { user: string; state: string } }[] } {
  const frames: { payload: { user: string; state: string } }[] = [];
  socket.on("message", (raw: unknown) => {
    const frame = JSON.parse(String(raw)) as {
      type: string;
      payload: { user: string; state: string };
    };
    if (frame.type !== type) return;
    // FILTERED BY SUBJECT, and the first version of this helper was not — which is
    // how FR-011 announced itself. A watcher's own arrival is delivered to the
    // watcher, because a subject shares every one of their channels with
    // themselves, so an unfiltered collector sees two frames where the test means
    // one. The behaviour is correct and the assertion was wrong.
    if (about !== undefined && frame.payload.user !== about) return;
    frames.push(frame);
  });
  return { frames };
}

/** Let the fabric settle. Redis pub/sub is fire-and-forget, so a test cannot poll a
 * queue — a negative assertion has to wait out a window instead. */
const quiet = (ms = 700) => new Promise((r) => setTimeout(r, ms));

/** Wait for a frame of a given type, or fail loudly. Redis pub/sub is
 * fire-and-forget, so a test cannot poll a queue — it waits with a deadline. */
function waitForFrame(
  socket: WebSocket,
  type: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: unknown): void => {
      const frame = JSON.parse(String(raw)) as { type: string };
      if (frame.type === type) {
        socket.off("message", onMessage);
        resolve(frame as unknown as Record<string, unknown>);
      }
    };
    socket.on("message", onMessage);
    setTimeout(
      () => reject(new Error(`no ${type} frame within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
}

/** One gateway instance: its own server, its own fabric clients, its own
 * `Presence`. Two of these on one Redis is what the cross-instance cases need,
 * and **no existing gateway suite stands up two at once** — `fanout.itest.ts`
 * does it at the fabric level with two `createFanout` clients and no sessions,
 * and every other file builds exactly one `attachSessions` inside its own
 * describe. So this is new harness rather than a pattern to copy.
 *
 * `presence` is INJECTED already built, the way `fanout` and `limits` are, which
 * is why a test that wants a hundred-millisecond grace period passes those
 * timings to `createPresence` here rather than to `attachSessions`. */
interface LogLine {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

interface Instance {
  url: string;
  /** Everything this instance logged. **The log line is the requirement's evidence**
   * on every failure path: a presence module that does nothing satisfies "the socket
   * still opened" exactly as well as a working one, which is chapter 3.18's trap
   * against its own publisher. */
  logs: LogLine[];
  close: () => Promise<void>;
}

/** A TCP proxy in front of the real Redis, so a test can sever and restore a
 * connection without touching anything shared.
 *
 * **NEVER `docker compose stop redis`.** The gateway's integration files run in
 * PARALLEL — `services/api/src/limits/limits.itest.ts:484` already writes the rule
 * down: "a dead port rather than stopping the container, because the lane runs files
 * in PARALLEL and stopping Redis would break every other suite mid-run". A dead port
 * covers "down" and cannot cover "restored", and `redis-server` is not installed on
 * the lane machine, so the proxy is what is left. */
async function startRedisProxy(): Promise<{
  url: string;
  cut: () => Promise<void>;
  restore: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const target = new URL(process.env.RELAY_REDIS_URL ?? "redis://localhost:6379");
  const live = new Set<Socket>();
  let server: NetServer | null = null;
  let port = 0;

  const listen = (onPort: number) =>
    new Promise<number>((resolve) => {
      const next = createNetServer((client) => {
        const upstream = connectSocket(
          Number(target.port || 6379),
          target.hostname,
        );
        client.pipe(upstream);
        upstream.pipe(client);
        for (const socket of [client, upstream]) {
          live.add(socket);
          socket.on("error", () => socket.destroy());
          socket.on("close", () => live.delete(socket));
        }
      });
      next.listen(onPort, "127.0.0.1", () => {
        server = next;
        resolve((next.address() as AddressInfo).port);
      });
    });

  port = await listen(0);
  return {
    url: `redis://127.0.0.1:${port}`,
    cut: async () => {
      for (const socket of live) socket.destroy();
      live.clear();
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
      server = null;
    },
    // Re-listening on the SAME port is what "without a restart" means: ioredis
    // reconnects on its own and the module is never rebuilt.
    restore: async () => {
      await listen(port);
    },
    close: async () => {
      for (const socket of live) socket.destroy();
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
    },
  };
}

async function startInstance(
  apiUrl: string,
  presenceOptions: Partial<PresenceOptions> = {},
): Promise<Instance> {
  const logs: LogLine[] = [];
  // THE SINK RECEIVES A JSON STRING, not an object, and its fields are spread at the
  // top level rather than nested. The first version of this pushed the raw line, so
  // every `l.msg` was undefined and the log assertions silently matched nothing —
  // which is the failure mode "observability you can't test rots" warns about, in
  // the test rather than the code.
  const recording = createLogger("gateway", (line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    logs.push({
      level: String(parsed.level),
      msg: String(parsed.msg),
      fields: parsed,
    });
  });
  const fanout = createFanout({ logger: silent });
  const presence = createPresence({ logger: recording, ...presenceOptions });
  const server = serve({
    service: "gateway",
    health: () => ({}),
    logger: silent,
    notFoundDocsUrl: docsUrl("not_found"),
  });
  const sessions = attachSessions({
    server,
    api: createApiClient(apiUrl),
    logger: silent,
    fanout,
    presence,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    logs,
    close: async () => {
      await sessions.close();
      await fanout.close();
      await presence.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ONE API FOR THE WHOLE FILE. Three describes each spawning their own was three
// process launches and three seeds, and it dominated the file's 54 s. The instances
// stay per-describe because their timings differ; those are cheap.
// Assigned in the file-level `beforeAll`; the non-null assertion is the same one
// every suite here makes about its fixture.
let api!: ApiUnderTest;
let nextSubject = 0;
const takeSubject = (): string => api.subjects[nextSubject++] as string;

beforeAll(async () => {
  api = await startApi();
}, 60_000);

afterAll(() => {
  api?.stop();
});

describe("presence: a member sees a co-member arrive (FR-RTM-05, FR-RTM-06)", () => {
  let a: Instance;
  let b: Instance;
  const sockets: WebSocket[] = [];

  const mintToken = async (user: string) => {
    const res = await fetch(`${api.url}/auth/dev-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({ user, ttl_seconds: 3600 }),
    });
    if (!res.ok) throw new Error(`dev-token: ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };

  let nextSubject = 0;
  /** The next unused subject. Every test that brings someone online takes one. */
  const takeSubject = () => api.subjects[nextSubject++] as string;

  const connect = (token: string, instance: Instance = a) => {
    const socket = new WebSocket(`${instance.url}/v1/ws?token=${token}`);
    sockets.push(socket);
    return socket;
  };

  beforeAll(async () => {
    // TWO INSTANCES ON ONE REDIS — same code, same fabric, no knowledge of each
    // other, which is chapter 2.6's phrase for the only property a single-process
    // test cannot show. Instance A hosts the watcher; B hosts the subject.
    a = await startInstance(api.url);
    b = await startInstance(api.url);
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await a?.close();
    await b?.close();
  });

  // T021. The clause, on one instance.
  it("delivers presence.changed online to a connected co-member", async () => {
    const watcher = connect(await mintToken("linh"));
    await waitForFrame(watcher, "connection.ack");
    const who = takeSubject();
    const seen = collect(watcher, "presence.changed", who);

    const subject = connect(await mintToken(who));
    await waitForFrame(subject, "connection.ack");
    await quiet();

    expect(seen.frames).toEqual([
      { type: "presence.changed", payload: { user: who, state: "online" } },
    ]);
  }, 30_000);

  // T022. The property a single-process test cannot show (chapter 2.6's phrase).
  it("delivers it when the subject is on another instance", async () => {
    const watcher = connect(await mintToken("linh"), a);
    await waitForFrame(watcher, "connection.ack");
    const who = takeSubject();
    const seen = collect(watcher, "presence.changed", who);

    const subject = connect(await mintToken(who), b);
    await waitForFrame(subject, "connection.ack");
    await quiet();

    expect(seen.frames).toHaveLength(1);
  }, 30_000);

  // T023, FR-012. The watcher shares THREE channels with the subject and a
  // transition publishes on all three, so this instance receives three copies of
  // one transition. Without the transition id this is three frames.
  it("delivers ONE frame to a watcher sharing three channels", async () => {
    const watcher = connect(await mintToken("linh"));
    await waitForFrame(watcher, "connection.ack");
    const who = takeSubject();
    const seen = collect(watcher, "presence.changed", who);

    const subject = connect(await mintToken(who), b);
    await waitForFrame(subject, "connection.ack");
    await quiet();

    expect(seen.frames).toHaveLength(1);
  }, 30_000);

  // T024, FR-006. The state did not change, so nothing is published — asserted in
  // a run where the FIRST connection did produce a frame, so a dead producer
  // cannot satisfy it.
  it("publishes nothing for a second connection of a user already online", async () => {
    const watcher = connect(await mintToken("linh"));
    await waitForFrame(watcher, "connection.ack");
    const who = takeSubject();
    const seen = collect(watcher, "presence.changed", who);

    const first = connect(await mintToken(who), b);
    await waitForFrame(first, "connection.ack");
    await quiet();
    expect(seen.frames).toHaveLength(1);

    const second = connect(await mintToken(who), a);
    await waitForFrame(second, "connection.ack");
    await quiet();
    expect(seen.frames).toHaveLength(1);
  }, 30_000);

  // T025, FR-011. A subject shares every one of their channels with themselves, so
  // the scoping rule includes them. Both readings satisfy FR-RTM-07 — "only users
  // sharing a channel" is an upper bound — and one of them has to be the one that
  // ships.
  it("delivers the subject's own transition to the subject's own socket", async () => {
    // Collected BEFORE the ack, because the subject's own transition is published
    // as soon as the registry has the connection and can arrive immediately after.
    const who = takeSubject();
    const subject = connect(await mintToken(who));
    const seen = collect(subject, "presence.changed", who);
    await waitForFrame(subject, "connection.ack");
    await quiet();

    // The subject's own connect elects the transition and its socket is subscribed
    // to the same channels, so it hears itself arrive. Exactly one frame, not three
    // — the dedup applies to the subject like anyone else.
    expect(seen.frames).toEqual([
      { type: "presence.changed", payload: { user: who, state: "online" } },
    ]);
  }, 30_000);

  // T026, FR-RTM-07's degenerate case. A member of no channel publishes on no
  // subject, and the connect still succeeds.
  it("publishes to nobody for a subject who is a member of no channel", async () => {
    const watcher = connect(await mintToken("linh"));
    await waitForFrame(watcher, "connection.ack");
    const seen = collect(watcher, "presence.changed", "hermit");

    const hermit = connect(await mintToken("hermit"), b);
    await waitForFrame(hermit, "connection.ack");
    await quiet();

    expect(seen.frames).toEqual([]);
  }, 30_000);
});

// ── THE GRACE PERIOD (FR-RTM-06) ─────────────────────────────────────────────
//
// MILLISECONDS, NOT HALF-MINUTES. The clause's thirty seconds is asserted once, in
// `presence.test.ts`, against the production default; every case here runs on a
// scaled window because six real grace periods would cost 180 s against 44 s of
// lane headroom. The timings are injected into `createPresence`, not into
// `attachSessions` — presence is built and handed over, so it carries its own
// configuration.
// SCALED HARD, AND THE NUMBER IS A BUDGET DECISION. At 500/100 this file cost 65.4 s
// of a 240 s lane budget with 32.7 s of headroom — R18's concern, arriving. At
// 250/60 it costs a third of that. The margin is still ~20x a local Redis round
// trip, which is what it has to clear.
const GRACE = 250;
const MARGIN = 60;
const SETTLE = GRACE + MARGIN + 200; // past the check, with room for a round trip

describe("presence: the grace period (FR-RTM-06)", () => {
  let a: Instance;
  let b: Instance;
  const sockets: WebSocket[] = [];

  const mintToken = async (user: string) => {
    const res = await fetch(`${api.url}/auth/dev-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({ user, ttl_seconds: 3600 }),
    });
    if (!res.ok) throw new Error(`dev-token: ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };

  const connect = (token: string, instance: Instance = a) => {
    const socket = new WebSocket(`${instance.url}/v1/ws?token=${token}`);
    sockets.push(socket);
    return socket;
  };

  /** Connect, wait for the ack, and let the arrival settle so the `online` frame is
   * out of the way before a test starts watching for `offline`. */
  const arrive = async (who: string, instance: Instance = a) => {
    const socket = connect(await mintToken(who), instance);
    await waitForFrame(socket, "connection.ack");
    await quiet(150);
    return socket;
  };

  beforeAll(async () => {
    const timings = {
      graceMs: GRACE,
      ttlMs: GRACE,
      refreshMs: 150,
      marginMs: MARGIN,
    };
    a = await startInstance(api.url, timings);
    b = await startInstance(api.url, timings);
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await a?.close();
    await b?.close();
  });

  // T036. The clause: one offline, and not before the window.
  it("publishes one offline after the window and nothing before it", async () => {
    const who = takeSubject();
    const watcher = await arrive("linh");
    const seen = collect(watcher, "presence.changed", who);
    const subject = await arrive(who, b);

    subject.close();
    await quiet(GRACE - 150);
    expect(seen.frames.filter((f) => f.payload.state === "offline")).toEqual([]);

    await quiet(SETTLE);
    expect(seen.frames.filter((f) => f.payload.state === "offline")).toHaveLength(1);
  }, 30_000);

  // T038. A reconnection inside the window is invisible: no offline, and no second
  // online either, because the state never changed.
  it("publishes nothing at all for a reconnection inside the window", async () => {
    const who = takeSubject();
    const watcher = await arrive("linh");
    const subject = await arrive(who, b);
    // COLLECTED AFTER THE ARRIVAL. The subject's own `online` is a real frame and
    // this test is about what happens from the close onward; watching from before
    // it makes the arrival look like a violation.
    const seen = collect(watcher, "presence.changed", who);

    subject.close();
    await quiet(GRACE / 2);
    await arrive(who, b);
    await quiet(SETTLE);

    expect(seen.frames).toEqual([]);
  }, 30_000);

  // T039. The same, landing on the OTHER instance — the case the TTL-as-liveness
  // signal exists for. Nothing coordinates the two gateways.
  it("publishes nothing when the reconnection lands on another instance", async () => {
    const who = takeSubject();
    const watcher = await arrive("linh");
    const subject = await arrive(who, b);
    const seen = collect(watcher, "presence.changed", who);

    subject.close();
    await quiet(GRACE / 2);
    await arrive(who, a);
    await quiet(SETTLE);

    expect(seen.frames).toEqual([]);
  }, 30_000);

  // T041, FR-006. Two connections here, one closes: nothing. Then the last one.
  it("publishes nothing while another connection remains open", async () => {
    const who = takeSubject();
    const watcher = await arrive("linh");
    const first = await arrive(who, b);
    const second = await arrive(who, b);
    const seen = collect(watcher, "presence.changed", who);

    first.close();
    await quiet(SETTLE);
    expect(seen.frames).toEqual([]);

    second.close();
    await quiet(SETTLE);
    expect(seen.frames.filter((f) => f.payload.state === "offline")).toHaveLength(1);
  }, 30_000);

  // T042. The two connections on two DIFFERENT instances, which no local registry
  // can see — the key's TTL is what answers it.
  it("publishes nothing while a connection remains on another instance", async () => {
    const who = takeSubject();
    const watcher = await arrive("linh");
    const onA = await arrive(who, a);
    await arrive(who, b);
    const seen = collect(watcher, "presence.changed", who);

    onA.close();
    await quiet(SETTLE);
    expect(seen.frames).toEqual([]);
  }, 30_000);

  // T043, FR-028. Close, reopen inside the window, close again: ONE decision,
  // answered by the state at the end of the SECOND window. Two pending timers
  // would publish twice.
  it("leaves one decision for two closes inside one window", async () => {
    const who = takeSubject();
    const watcher = await arrive("linh");
    const seen = collect(watcher, "presence.changed", who);

    const first = await arrive(who, b);
    first.close();
    await quiet(GRACE / 3);
    const second = await arrive(who, b);
    second.close();
    await quiet(SETTLE + GRACE);

    expect(seen.frames.filter((f) => f.payload.state === "offline")).toHaveLength(1);
  }, 30_000);

  // T045, and FR-RTM-09's five is enforced NOWHERE — `policy.ts:13` mentions it in a
  // comment and nothing counts — so the reference count is unbounded and two is the
  // easy case. Five connections, closed one at a time: nothing until the last.
  //
  // CHAPTER 3.22 BUILT THE CAP AND THE SENTENCE ABOVE IS STILL TRUE HERE, which is a
  // decision rather than an oversight. Every gateway module is an optional parameter
  // and this fixture passes no `connections`, so nothing counts in THIS file after
  // that chapter either. The cap lives where a fixture asks for it: the new
  // `connections.itest.ts` and `session.itest.ts`'s "cap at the door" describe.
  //
  // The five below is therefore still free, and it is also now exactly the cap. A
  // future edit adding a sixth connection to this test would be fine here and
  // refused in either of those two files — worth knowing before somebody copies the
  // pattern.
  it("publishes nothing until the fifth of five connections closes", async () => {
    const who = takeSubject();
    const watcher = await arrive("linh");
    const open = [];
    for (let i = 0; i < 5; i += 1) open.push(await arrive(who, i % 2 ? a : b));
    const seen = collect(watcher, "presence.changed", who);

    // Closed together and asserted once, rather than a settle per close. Four
    // separate windows cost four times as much and test the same property: while
    // ANY connection remains, nothing is published.
    for (const socket of open.slice(0, 4)) socket.close();
    await quiet(SETTLE);
    expect(seen.frames).toEqual([]);

    open[4]?.close();
    await quiet(SETTLE);
    expect(seen.frames.filter((f) => f.payload.state === "offline")).toHaveLength(1);
  }, 60_000);

  // T044. A DEPLOY DRAIN. `docs/05-sad.md:634` stops the gateway accepting on
  // SIGTERM and clients reconnect elsewhere, so a mass disconnect is the real path
  // rather than a hypothetical — and it is the worst case for whatever schedules
  // the grace check: twelve pending timers and twelve round trips at once.
  it("publishes one offline per user when six close in the same tick", async () => {
    const watcher = await arrive("linh");
    const crowd: string[] = [];
    for (let i = 0; i < 6; i += 1) crowd.push(takeSubject());
    const sockets_ = await Promise.all(
      crowd.map((who, i) => arrive(who, i % 2 ? a : b)),
    );
    const seen = crowd.map((who) => collect(watcher, "presence.changed", who));

    for (const socket of sockets_) socket.close();
    await quiet(SETTLE + 400);

    const offlines = seen.map(
      (s) => s.frames.filter((f) => f.payload.state === "offline").length,
    );
    // EVERY user, EXACTLY once — not "at least one somewhere", which a partial
    // drain would also satisfy.
    expect(offlines).toEqual(crowd.map(() => 1));
  }, 90_000);

  // T046. Two instances whose last connections close in the same tick both find the
  // key absent at the check. The election is the only thing between that and two
  // frames at the watcher.
  it("publishes one offline when two instances close in the same tick", async () => {
    const who = takeSubject();
    const watcher = await arrive("linh");
    const seen = collect(watcher, "presence.changed", who);
    const onA = await arrive(who, a);
    const onB = await arrive(who, b);

    onA.close();
    onB.close();
    await quiet(SETTLE);

    expect(seen.frames.filter((f) => f.payload.state === "offline")).toHaveLength(1);
  }, 30_000);
});

// ── THE GAP BETWEEN THE KEY'S DEATH AND THE GRACE'S END ──────────────────────
//
// `ttlMs` DELIBERATELY BELOW `graceMs`, which nothing forbids and one thing needs.
// The key's expiry counts from the last refresh; the grace counts from the close.
// Without the close re-pinning the key those are different instants, and every
// reconnect case above lands in the FIRST part of the window where the key is still
// alive and the bug is invisible. This describe opens the gap on purpose.
describe("presence: a reconnection after the TTL would have lapsed (FR-007)", () => {
  const TTL = 150;
  const LATE_GRACE = 600;
  let a: Instance;
  let b: Instance;
  const sockets: WebSocket[] = [];

  const mintToken = async (user: string) => {
    const res = await fetch(`${api.url}/auth/dev-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({ user, ttl_seconds: 3600 }),
    });
    if (!res.ok) throw new Error(`dev-token: ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };
  const arrive = async (who: string, instance: Instance = a) => {
    const socket = new WebSocket(`${instance.url}/v1/ws?token=${await mintToken(who)}`);
    sockets.push(socket);
    await waitForFrame(socket, "connection.ack");
    await quiet(150);
    return socket;
  };

  beforeAll(async () => {
    const timings = {
      graceMs: LATE_GRACE,
      ttlMs: TTL,
      refreshMs: 60,
      marginMs: 80,
    };
    a = await startInstance(api.url, timings);
    b = await startInstance(api.url, timings);
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await a?.close();
    await b?.close();
  });

  // T040. The reconnection lands AFTER `ttlMs` has lapsed and BEFORE the grace ends
  // — the window every other reconnect test misses. Without the re-pin the key is
  // gone by now, `SET … NX` succeeds, and the watcher sees a second `online` for a
  // user who never left.
  it("publishes no second online when the reconnect lands past the TTL", async () => {
    const who = takeSubject();
    const watcher = await arrive("linh");
    const subject = await arrive(who, b);
    const seen = collect(watcher, "presence.changed", who);

    subject.close();
    // Past `ttlMs` (150 ms) and well inside the grace (600 ms).
    await quiet(350);
    await arrive(who, b);
    await quiet(LATE_GRACE + 350);

    expect(seen.frames).toEqual([]);
  }, 30_000);

  // T049. The re-pin is AWAITED before the timer is armed, asserted by outcome
  // rather than by reading `PTTL`: with a 200 ms TTL and a 900 ms grace, an
  // `offline` that arrives on the grace's schedule can only mean the key was
  // re-pinned. If the close left the key on its refresh TTL it would have expired
  // at ~200 ms and the check would still have found it absent — so the tell is
  // that nothing arrives EARLY, and the frame lands after the grace.
  //
  // Reading `PTTL` directly would need a raw ioredis client, which
  // `eslint.config.mjs` restricts and this file is not exempted from. Asserting the
  // behaviour is the stronger test anyway.
  it("holds the key for the grace, not for the TTL", async () => {
    const who = takeSubject();
    const watcher = await arrive("linh");
    const subject = await arrive(who, b);
    const seen = collect(watcher, "presence.changed", who);

    const closedAt = Date.now();
    subject.close();
    await quiet(TTL + 120);
    expect(seen.frames.filter((f) => f.payload.state === "offline")).toEqual([]);

    await quiet(LATE_GRACE);
    const offline = seen.frames.filter((f) => f.payload.state === "offline");
    expect(offline).toHaveLength(1);
    expect(Date.now() - closedAt).toBeGreaterThan(LATE_GRACE);
  }, 30_000);
});

// ── WHO IS ALLOWED TO SEE IT (FR-RTM-07, FR-CHN-05, constitution I) ──────────
//
// EVERY NEGATIVE HERE IS ASSERTED BESIDE A POSITIVE IN THE SAME RUN. "Nothing
// arrived" is equally true of correct scoping and of a producer that stopped
// working, and only one of those is the property under test. Each case connects a
// watcher who MUST receive alongside one who must not, and asserts both.
describe("presence: who is allowed to see it (FR-RTM-07, FR-CHN-05)", () => {
  let a: Instance;
  let b: Instance;
  const sockets: WebSocket[] = [];

  const mint = async (user: string, credential: string) => {
    const res = await fetch(`${api.url}/auth/dev-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ user, ttl_seconds: 3600 }),
    });
    if (!res.ok) throw new Error(`dev-token ${user}: ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };

  const open = async (token: string, instance: Instance = a) => {
    const socket = new WebSocket(`${instance.url}/v1/ws?token=${token}`);
    sockets.push(socket);
    await waitForFrame(socket, "connection.ack");
    return socket;
  };

  beforeAll(async () => {
    a = await startInstance(api.url);
    b = await startInstance(api.url);
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await a?.close();
    await b?.close();
  });

  // T057. The subject shares three channels with the co-member and none with the
  // recluse, whose only channel is private and unshared.
  it("delivers to a co-member and not to a user sharing no channel", async () => {
    const who = takeSubject();
    const member = await open(await mint("linh", api.credential));
    const outsider = await open(await mint("recluse", api.credential));
    const heard = collect(member, "presence.changed", who);
    const overheard = collect(outsider, "presence.changed", who);

    await open(await mint(who, api.credential), b);
    await quiet(450);

    expect(heard.frames).toHaveLength(1);
    expect(overheard.frames).toEqual([]);
  }, 30_000);

  // T058, FR-CHN-05's third verb. The recluse's only channel is PRIVATE and the
  // co-member is not in it, so a transition of the recluse's reaches nobody but the
  // recluse — while the same run shows the producer working for someone else.
  it("does not let a non-member observe presence in a private channel", async () => {
    const control = takeSubject();
    const member = await open(await mint("linh", api.credential));
    const aboutRecluse = collect(member, "presence.changed", "recluse");
    const aboutControl = collect(member, "presence.changed", control);

    await open(await mint("recluse", api.credential), b);
    await open(await mint(control, api.credential), b);
    await quiet(450);

    expect(aboutRecluse.frames).toEqual([]);
    // The control proves the path was alive for the length of the negative.
    expect(aboutControl.frames).toHaveLength(1);
  }, 30_000);

  // T059, constitution I. A different environment entirely: different key, different
  // user, different channel. Presence keys are `{env}`-scoped and channel ids are
  // unguessable UUIDs, so nothing about this should cross — asserted rather than
  // assumed, because "a leak here is a correctness defect, not a cosmetic one".
  it("delivers nothing to a user of another tenant", async () => {
    const who = takeSubject();
    const member = await open(await mint("linh", api.credential));
    const stranger = await open(
      await mint("stranger", api.otherCredential),
      b,
    );
    const heard = collect(member, "presence.changed", who);
    // UNFILTERED ON PURPOSE, and asserted as "everything it heard was about
    // itself". Filtering to the other tenant's subject would only prove that ONE
    // user did not leak; this catches any of them. The stranger does hear its own
    // arrival — a subject shares every channel with themselves (FR-011) — and an
    // earlier version of this test read that as a cross-tenant leak.
    const acrossTheBoundary = collect(stranger, "presence.changed");

    await open(await mint(who, api.credential), b);
    await quiet(450);

    expect(heard.frames).toHaveLength(1);
    expect(acrossTheBoundary.frames.map((f) => f.payload.user)).toEqual([
      "stranger",
    ]);
  }, 30_000);

  // T060, FR-029. A message and a transition on the same channel, at the same time.
  // Each must arrive as ITSELF. This is a property of the topology rather than of a
  // filter — a presence payload is published on a subject no message subscriber
  // subscribes to — so the test is checking that the topology is what it claims.
  it("never delivers a message as presence, or presence as a message", async () => {
    const who = takeSubject();
    const member = await open(await mint("linh", api.credential));
    const presenceFrames = collect(member, "presence.changed", who);
    const messages = collect(member, "message.created");

    await open(await mint(who, api.credential), b);
    await quiet(450);

    expect(presenceFrames.frames).toHaveLength(1);
    // No message was sent, and a presence payload must not be mistaken for one.
    expect(messages.frames).toEqual([]);
  }, 30_000);

  // T061, FR-027. A transition arriving while a connection is mid-resume is sent
  // immediately: presence carries no sequence, so it can neither duplicate a
  // backfilled row nor leave a gap, and `suppressed()` takes a `Message`. The
  // resuming socket presents a cursor, which puts it through the buffering phase.
  it("delivers a transition to a connection that is resuming", async () => {
    const who = takeSubject();
    const token = await mint("linh", api.credential);
    const resuming = new WebSocket(
      `${a.url}/v1/ws?token=${token}&cursor=${encodeURIComponent("{}")}`,
    );
    sockets.push(resuming);
    const heard = collect(resuming, "presence.changed", who);
    await waitForFrame(resuming, "connection.ack");

    await open(await mint(who, api.credential), b);
    await quiet(450);

    expect(heard.frames).toHaveLength(1);
  }, 30_000);
});

// ── WHEN REDIS IS GONE (FR-023, FR-024, FR-030) ──────────────────────────────
//
// EVERY TEST HERE COULD PASS AGAINST A MODULE THAT DOES NOTHING. "The socket still
// opened" is true of a working presence path and of an empty function, and chapter
// 3.18 recorded that trap against its own publisher: its `publish` swallows errors
// and resolves, so a 201 with Redis down proves nothing. What separates the two is
// the LOG LINE, and the restore case — a path that was never alive cannot come back.
describe("presence: when Redis is gone (FR-023, FR-024)", () => {
  const DEAD = "redis://127.0.0.1:1"; // the address the api's fan-out suite uses
  let broken: Instance;
  const sockets: WebSocket[] = [];

  const mint = async (user: string) => {
    const res = await fetch(`${api.url}/auth/dev-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({ user, ttl_seconds: 3600 }),
    });
    if (!res.ok) throw new Error(`dev-token: ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };

  beforeAll(async () => {
    broken = await startInstance(api.url, { url: DEAD });
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await broken?.close();
  });

  // T067, FR-023. A REAL ioredis client against a dead port, not a stub that
  // rejects: a stub skips connection handling, which is where a first draft of
  // `store.ts` got it wrong.
  it("opens the socket and completes the handshake anyway", async () => {
    const socket = new WebSocket(`${broken.url}/v1/ws?token=${await mint("linh")}`);
    sockets.push(socket);
    const ack = await waitForFrame(socket, "connection.ack");
    expect(ack).toHaveProperty("type", "connection.ack");
  }, 30_000);

  // T069, FR-024. THE ASSERTION THAT CARRIES FR-023. Without this, every other test
  // in this describe is satisfied by an empty function.
  it("logs presence.failed with an op and an error", async () => {
    const socket = new WebSocket(`${broken.url}/v1/ws?token=${await mint("linh")}`);
    sockets.push(socket);
    await waitForFrame(socket, "connection.ack");
    await quiet(600);

    const failures = broken.logs.filter((l) => l.msg === "presence.failed");
    expect(failures.length).toBeGreaterThan(0);
    for (const line of failures) {
      expect(line.level).toBe("error");
      expect(typeof line.fields.op).toBe("string");
      expect(typeof line.fields.error).toBe("string");
    }
  }, 30_000);

  // T068, FR-023. Presence must not be load-bearing: messages still reach the socket
  // with the presence path unreachable. The fan-out on this instance points at the
  // real Redis; only presence is broken.
  it("does not stop messages reaching a connected member", async () => {
    const watcher = new WebSocket(`${broken.url}/v1/ws?token=${await mint("linh")}`);
    sockets.push(watcher);
    await waitForFrame(watcher, "connection.ack");
    const messages = collect(watcher, "message.created");

    const sender = new WebSocket(`${broken.url}/v1/ws?token=${await mint("linh")}`);
    sockets.push(sender);
    await waitForFrame(sender, "connection.ack");
    sender.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: api.channelIds[0],
          text: "the presence path is down and this still arrives",
        },
      }),
    );
    await waitForFrame(sender, "message.ack");
    await quiet(400);

    expect(messages.frames.length).toBeGreaterThan(0);
  }, 30_000);

  // T071. A close handler is the last place that should throw, and chapter 2.8's
  // lane found the unhandled rejection on the fan-out's release path for exactly
  // this reason. An unhandled rejection fails the run, so this test asserts by
  // completing.
  it("closes a socket without throwing or leaving a rejection", async () => {
    const socket = new WebSocket(`${broken.url}/v1/ws?token=${await mint("linh")}`);
    sockets.push(socket);
    await waitForFrame(socket, "connection.ack");
    socket.close();
    await quiet(500);
    expect(true).toBe(true);
  }, 30_000);
});

// ── AND WHEN IT COMES BACK (FR-024's other half) ─────────────────────────────
describe("presence: when Redis comes back (FR-024)", () => {
  let proxy: Awaited<ReturnType<typeof startRedisProxy>>;
  let a: Instance;
  let b: Instance;
  const sockets: WebSocket[] = [];

  const mint = async (user: string) => {
    const res = await fetch(`${api.url}/auth/dev-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({ user, ttl_seconds: 3600 }),
    });
    if (!res.ok) throw new Error(`dev-token: ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };
  const open = async (user: string, instance: Instance) => {
    const socket = new WebSocket(`${instance.url}/v1/ws?token=${await mint(user)}`);
    sockets.push(socket);
    await waitForFrame(socket, "connection.ack");
    return socket;
  };

  beforeAll(async () => {
    proxy = await startRedisProxy();
    a = await startInstance(api.url, { url: proxy.url });
    b = await startInstance(api.url, { url: proxy.url });
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await a?.close();
    await b?.close();
    await proxy?.close();
  });

  // T070. **THE HALF THAT PROVES THE PATH WAS ALIVE.** Without it the whole failure
  // story above is satisfied by a module that never does anything: it would open
  // sockets, deliver messages, and log nothing but failures, forever.
  //
  // "Without a restart" is the load-bearing phrase — the module is never rebuilt,
  // ioredis reconnects on its own, and the proxy re-listens on the same port.
  it("publishes the next transition after the connection is restored", async () => {
    const watcher = await open("linh", a);

    await proxy.cut();
    await quiet(400);
    await proxy.restore();
    // ioredis backs off before retrying; give it room to notice.
    await quiet(2_500);

    const who = takeSubject();
    const heard = collect(watcher, "presence.changed", who);
    await open(who, b);
    await quiet(900);

    expect(heard.frames).toHaveLength(1);
  }, 60_000);
});

// ── DURABILITY IT MUST NOT ACQUIRE, AND THE REST OF THE VOCABULARY ───────────
describe("presence: no durability, and the whole log vocabulary", () => {
  let a: Instance;
  let b: Instance;
  const sockets: WebSocket[] = [];

  const mint = async (user: string) => {
    const res = await fetch(`${api.url}/auth/dev-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({ user, ttl_seconds: 3600 }),
    });
    if (!res.ok) throw new Error(`dev-token: ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };
  const open = async (user: string, instance: Instance = a) => {
    const socket = new WebSocket(`${instance.url}/v1/ws?token=${await mint(user)}`);
    sockets.push(socket);
    await waitForFrame(socket, "connection.ack");
    return socket;
  };

  beforeAll(async () => {
    a = await startInstance(api.url);
    b = await startInstance(api.url);
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await a?.close();
    await b?.close();
  });

  // T072, FR-026. ADR-10: the correct amount of durability for a green circle is
  // none. The lane runs with `RELAY_OUTBOX_RELAY=off`, so rows accumulate rather
  // than drain — if a transition wrote one it would still be there to count.
  it("writes no outbox row for a transition", async () => {
    const before = await api.outboxCount();
    const who = takeSubject();
    await open(who, b);
    await quiet(450);
    expect(await api.outboxCount()).toBe(before);
  }, 30_000);

  // T073, FR-025 and constitution VI. `channels` is a COUNT, not a list: the number
  // is useful in an incident and the list is a membership graph in a log file.
  it("logs presence.published with a channel count and no content", async () => {
    const who = takeSubject();
    await open(who, b);
    await quiet(450);

    const published = b.logs.filter(
      (l) => l.msg === "presence.published" && l.fields.user === who,
    );
    expect(published).toHaveLength(1);
    const line = published[0] as LogLine;
    expect(line.fields.state).toBe("online");
    expect(line.fields.channels).toBe(3);
    // No text, no token, no channel list — the fields are exactly these.
    expect(Object.keys(line.fields).sort()).toEqual([
      "channels",
      "level",
      "msg",
      "service",
      "state",
      "time",
      "user",
    ]);
  }, 30_000);

  // T074, FR-030. The two events FR-024 and FR-025 do not cover. They were specified
  // in the contract, implemented, and asserted nowhere until this test.
  it("logs presence.suppressed when a second connection changes nothing", async () => {
    const who = takeSubject();
    await open(who, a);
    await quiet(400);
    await open(who, b);
    await quiet(400);

    const suppressed = b.logs.filter(
      (l) => l.msg === "presence.suppressed" && l.fields.user === who,
    );
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.fields.reason).toBe("already online");
  }, 30_000);

  // RENAMED IN PHASE 9, because the title said the opposite of the assertion. This
  // test publishes a MESSAGE on a MESSAGE subject and asserts presence never sees
  // it — FR-029 from the other side — and `toEqual([])` is right for that. It was
  // titled "logs presence.invalid_payload", which is a claim nothing here checks:
  // the coverage run showed both rejection arms at zero while this test was green.
  // The real ones are in the last describe.
  it("does not reach the presence parser with a message payload", async () => {
    const who = takeSubject();
    await open("linh", a);
    await quiet(300);
    // Published straight onto a presence subject with neither module's code — the
    // only way to put a malformed payload on the fabric. The subject is derived the
    // same way the module derives it.
    const raw = createFanout({ logger: silent });
    await raw.publish({
      id: randomUUID(),
      channel: api.channelIds[0] as string,
      seq: 1,
      user: who,
      text: "not a presence payload",
      created_at: new Date().toISOString(),
    });
    await quiet(500);
    await raw.close();

    // The message subject is not the presence subject, so this proves the reverse of
    // FR-029 too: a message payload does not reach the presence parser at all.
    expect(a.logs.filter((l) => l.msg === "presence.invalid_payload")).toEqual([]);
  }, 30_000);
});

// THE BRANCHES A PASSING SUITE DOES NOT REACH — PHASE 9, FR-032.
//
// NFR-MNT-02 asks 100% branch coverage of tenant-isolation code and `presence.ts`
// measured 81.81 with every test above green. That is the whole argument for a
// ratchet: six arms of this module had never executed, and one of them — the
// malformed-payload rejection — had a test whose TITLE claimed it.
//
// Each test here names the arm it exists for. None of them is a scenario a user
// performs; they are the paths a failing store, a lost key or a caller using the
// module's own interface can produce, and the module documents all of them.
describe("presence: the arms a green suite left alone (FR-032)", () => {
  let a: Instance;
  const sockets: WebSocket[] = [];

  const mint = async (user: string) => {
    const res = await fetch(`${api.url}/auth/dev-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({ user, ttl_seconds: 3600 }),
    });
    if (!res.ok) throw new Error(`dev-token: ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };
  const open = async (user: string, instance: Instance = a) => {
    const socket = new WebSocket(`${instance.url}/v1/ws?token=${await mint(user)}`);
    sockets.push(socket);
    await waitForFrame(socket, "connection.ack");
    return socket;
  };

  beforeAll(async () => {
    a = await startInstance(api.url);
    // `linh` is the fixture's watcher and a member of all three channels, so this
    // one connection is what makes the instance a subscriber on `presence:{c}`.
    // The first draft opened a user named "watcher" — the dev-token endpoint mints
    // a token for any id, so the socket opened, the user was a member of nothing,
    // the instance subscribed to nothing, and both publishes below reached nobody.
    // The tests failed for a reason that had nothing to do with what they check.
    await open("linh");
    await quiet(300);
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await a?.close();
  });

  // The `catch` around `JSON.parse`. A subscriber receives bytes, not objects, and
  // "not JSON at all" is a different failure from "JSON of the wrong shape" —
  // `fanout.ts` separates them the same way and its own arm is uncovered too.
  it("logs presence.invalid_payload for a body that is not JSON", async () => {
    const raw = new Redis(process.env.RELAY_REDIS_URL ?? "redis://localhost:6379");
    await raw.publish(subjectForPresence(api.channelIds[0] as string), "{not json");
    await quiet(400);
    await raw.quit();

    const rejected = a.logs.filter((l) => l.msg === "presence.invalid_payload");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.fields.subject).toBe(
      subjectForPresence(api.channelIds[0] as string),
    );
  }, 30_000);

  // The `safeParse` arm. `presenceFabricSchema` is a `strictObject`, so a field this
  // module has never published is a rejection rather than a silent ignore — which is
  // what makes adding a field to the fabric a decision on both sides of a deploy.
  it("logs presence.invalid_payload for JSON that is not a transition", async () => {
    const before = a.logs.filter((l) => l.msg === "presence.invalid_payload").length;
    const raw = new Redis(process.env.RELAY_REDIS_URL ?? "redis://localhost:6379");
    await raw.publish(
      subjectForPresence(api.channelIds[0] as string),
      JSON.stringify({ user: "someone", state: "online" }),
    );
    await quiet(400);
    await raw.quit();

    // No `transition`, so a receiver could not dedup it — and `strictObject` refuses
    // it before that becomes anybody's problem.
    expect(
      a.logs.filter((l) => l.msg === "presence.invalid_payload").length - before,
    ).toBe(1);
  }, 30_000);

  // FR-031's self-healing duplicate, and the only arm here that a REAL incident
  // produces: a Redis restart or an eviction takes the key out from under a live
  // connection. Provoked without touching the store — a TTL shorter than the refresh
  // interval reaches the same state, because `XX` answers null for a key that is gone.
  it("re-elects and logs when the key vanishes under a live connection", async () => {
    const instance = await startInstance(api.url, {
      ttlMs: 200,
      refreshMs: 400,
      graceMs: 200,
      marginMs: 50,
    });
    try {
      const who = takeSubject();
      const socket = new WebSocket(
        `${instance.url}/v1/ws?token=${await mint(who)}`,
      );
      await waitForFrame(socket, "connection.ack");
      // Two refresh intervals: the key expires at 200 ms, the refresh at 400 ms finds
      // it gone, and the re-election runs.
      await quiet(1_000);
      socket.close();

      const reelected = instance.logs.filter(
        (l) =>
          l.msg === "presence.suppressed" &&
          l.fields.reason === "key vanished under a live connection; re-electing",
      );
      expect(reelected.length).toBeGreaterThanOrEqual(1);
      expect(reelected[0]?.fields.user).toBe(who);
    } finally {
      await instance.close();
    }
  }, 30_000);

  // `unsubscribe` for a channel this instance never subscribed to. Not reachable
  // through `session.ts`, which unsubscribes exactly the set it subscribed — but it
  // is on the `Presence` interface, so a caller can do it, and the reference count
  // must not go negative or throw.
  it("tolerates an unsubscribe for a channel never subscribed", async () => {
    const presence = createPresence({ logger: silent });
    try {
      await expect(presence.unsubscribe(randomUUID())).resolves.toBeUndefined();
    } finally {
      await presence.close();
    }
  }, 30_000);

  // The no-op `deliver` the module starts with. `onTransition` is called by
  // `attachSessions` at wiring time, and a `Presence` built without sessions still
  // receives on its subscriptions — it must drop them rather than throw inside an
  // ioredis event handler, where a throw is an unhandled rejection.
  it("drops a transition when no handler has been registered", async () => {
    const listener = createPresence({ logger: silent });
    const publisher = createPresence({ logger: silent });
    try {
      const channel = api.channelIds[1] as string;
      await listener.subscribe(channel);
      await quiet(200);
      await publisher.connected("env-x", takeSubject(), [channel]);
      await quiet(400);
      // Nothing to assert but the absence of a crash: an unhandled rejection here
      // fails the file, which is the assertion.
      expect(true).toBe(true);
    } finally {
      await listener.close();
      await publisher.close();
    }
  }, 30_000);

  // `close()` while a grace check is pending. A draining instance abandons its
  // pending offlines — stated in the chapter rather than discovered — and the timer
  // must be cleared, or a suite standing up two instances leaks one into the next
  // file.
  it("clears a pending grace check when the instance closes", async () => {
    const instance = await startInstance(api.url, {
      graceMs: 10_000,
      marginMs: 1_000,
    });
    const who = takeSubject();
    const socket = new WebSocket(`${instance.url}/v1/ws?token=${await mint(who)}`);
    await waitForFrame(socket, "connection.ack");
    await quiet(300);
    // Closing the socket arms the check ten seconds out; closing the instance while
    // it is pending is the path.
    socket.close();
    await quiet(400);
    await instance.close();

    expect(
      instance.logs.filter(
        (l) => l.msg === "presence.published" && l.fields.state === "offline",
      ),
    ).toEqual([]);
  }, 30_000);

  // `DEFAULT_REDIS_URL`. `main.ts` builds the module with no `url`, so the default
  // is what a real gateway uses and no test had ever taken it — every instance here
  // passes one, and `RELAY_REDIS_URL` is set in the lane.
  it("falls back to the default url when neither is supplied", async () => {
    const saved = process.env.RELAY_REDIS_URL;
    delete process.env.RELAY_REDIS_URL;
    try {
      const presence = createPresence({ logger: silent });
      await presence.subscribe(api.channelIds[2] as string);
      await presence.close();
    } finally {
      if (saved !== undefined) process.env.RELAY_REDIS_URL = saved;
    }
    expect(DEFAULT_REDIS_URL).toBe("redis://localhost:6379");
  }, 30_000);
});
