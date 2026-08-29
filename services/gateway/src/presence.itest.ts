import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import { createLogger, serve, type Logger } from "@relay/service-kit";
import { docsUrl } from "@relay/protocol";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiClient } from "./api-client.js";
import { createFanout } from "./fanout.js";
import { createPresence, type PresenceOptions } from "./presence.js";
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
    createPool: () => unknown;
  };
  const seeder = require_(join(dist, "db", "repository.js")) as Seeder;
  const db = client.createDb(client.createPool());

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
  const subjects = Array.from({ length: 40 }, (_, i) => `subject-${i}`);
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
  const key = await seeder.createApiKey(db, {
    environmentId: environment.id,
  });

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
  return { url, credential: key.credential, subjects, stop: () => child.kill() };
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
interface Instance {
  url: string;
  close: () => Promise<void>;
}

async function startInstance(
  apiUrl: string,
  presenceOptions: Partial<PresenceOptions> = {},
): Promise<Instance> {
  const fanout = createFanout({ logger: silent });
  const presence = createPresence({ logger: silent, ...presenceOptions });
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
  it("publishes nothing until the fifth of five connections closes", async () => {
    const who = takeSubject();
    const watcher = await arrive("linh");
    const open = [];
    for (let i = 0; i < 5; i += 1) open.push(await arrive(who, i % 2 ? a : b));
    const seen = collect(watcher, "presence.changed", who);

    for (const socket of open.slice(0, 4)) {
      socket.close();
      await quiet(SETTLE);
      expect(seen.frames).toEqual([]);
    }

    open[4]?.close();
    await quiet(SETTLE);
    expect(seen.frames.filter((f) => f.payload.state === "offline")).toHaveLength(1);
  }, 60_000);

  // T044. A DEPLOY DRAIN. `docs/05-sad.md:634` stops the gateway accepting on
  // SIGTERM and clients reconnect elsewhere, so a mass disconnect is the real path
  // rather than a hypothetical — and it is the worst case for whatever schedules
  // the grace check: twelve pending timers and twelve round trips at once.
  it("publishes one offline per user when eight close in the same tick", async () => {
    const watcher = await arrive("linh");
    const crowd: string[] = [];
    for (let i = 0; i < 8; i += 1) crowd.push(takeSubject());
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
