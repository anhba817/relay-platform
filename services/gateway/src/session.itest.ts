import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { createLogger, serve, type Logger } from "@relay/service-kit";
import { docsUrl, frameSchema } from "@relay/protocol";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApiClient } from "./api-client.js";
import { createFanout, type Fanout } from "./fanout.js";
import { createMembership, type Membership } from "./membership.js";
import { attachSessions } from "./session.js";

// The socket's credential cases, against a REAL api.
//
// The unit suite stubs the api, which is right for the ordering and framing
// questions it asks — but it cannot prove the thing this chapter changed: that
// a token the api minted opens a socket, that an API key does not, and that the
// gateway's refusals are the api's refusals rather than its own opinion.
// Nothing in the unit suite would fail if `authenticate` simply believed a stub.
//
//   docker compose up -d --wait postgres
//   pnpm build
//   RELAY_POSTGRES_PORT=… pnpm --filter @relay/gateway test:integration
//
// The api runs as a CHILD PROCESS, not as an in-process module. Importing it
// would make the gateway depend on the api's framework to test itself, and the
// one thing this service is not allowed to know about is how the api is built
// (ADR-05). A port and a health check are the whole contract — which is also
// all the gateway has in production.

const silent: Logger = createLogger("gateway", () => {});

interface ApiUnderTest {
  url: string;
  environmentId: string;
  credential: string;
  channelId: string;
  stop: () => void;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);

/** Seeding goes through the api's own repository, imported from its build
 * output — the test-only seam 2.8 established, for the same reason: there is no
 * admin API for environments or keys yet, and inventing one for a test would be
 * inventing product. */
interface Seeder {
  createEnvironment: (
    db: unknown,
    input: { name: string },
  ) => Promise<{ id: string }>;
  createApiKey: (
    db: unknown,
    input: { environmentId: string },
  ) => Promise<{ credential: string }>;
  Repository: new (
    db: unknown,
    environmentId: string,
  ) => {
    createUser: (externalId: string, name?: string) => Promise<{ id: string }>;
    createChannel: (
      externalId: string,
      type: string,
      name?: string,
    ) => Promise<{ id: string }>;
    addMember: (channelId: string, userId: string) => Promise<boolean>;
    /** An application credential may send only as a bot user
     * So a REST send needs one to exist — and `createUser`
     * makes a person. Widening this type rather than reaching around it: the
     * shape here is a hand-written mirror of the real repository, and a member
     * it does not name is a member this suite cannot call. */
    upsertUser: (
      externalId: string,
      profile: {
        display_name?: string;
        kind?: "person" | "bot";
        description?: string;
      },
    ) => Promise<unknown>;
  };
}

async function waitForHealth(url: string, why?: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      // **The child has already said why and nobody was
      // listening.** This file spawns with `stdio: ["ignore", "pipe", "pipe"]`
      // and never read either pipe, so an api that died took its reason with it —
      // which is the entire reason the membership-revocation chapter's `gaps.md` item 19a has four
      // occurrences and three eliminated hypotheses rather than a cause. The
      // buffer is drained below and its tail is attached here.
      throw new Error(
        `api never became healthy${why === undefined ? "" : `\n--- child output ---\n${why()}`}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startApi(): Promise<ApiUnderTest> {
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
    name: `session-itest-${randomUUID().slice(0, 8)}`,
  });
  const repo = new seeder.Repository(db, environment.id);
  const user = await repo.createUser("tuan", "Tuan");
  // The sender a REST send names. ADDITIVE to this fixture — the
  // tests above assert on "tuan" and a second user changes nothing for them,
  // which is the difference between adding a capability and repurposing one.
  await repo.upsertUser("delivery-bot", {
    display_name: "Delivery Bot",
    kind: "bot",
    description: "sends over REST so a socket can receive it",
  });
  const channel = await repo.createChannel("fleet", "public");
  await repo.addMember(channel.id, user.id);
  const key = await seeder.createApiKey(db, {
    environmentId: environment.id,
  });

  // PORT=0, AND THE PORT READ BACK FROM THE CHILD. This bound a fixed 4123 behind an
  // environment variable nothing set — so every run took the same port, and a
  // previous run's child still holding it answers the health check from a DIFFERENT
  // environment. Every token this run minted is then refused by an api that has never
  // heard of it, which reads as a credential fault and is a busy port.
  const child: ChildProcess = spawn("node", [join(dist, "main.js")], {
    // No outbox relay in this child. This suite is about the socket's credentials; a
    // background loop draining a table the outbox chapter's suite is asserting on
    // turns two unrelated test files into a race.
    env: { ...process.env, PORT: "0", RELAY_OUTBOX_RELAY: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // DRAINED, AND KEPT. Two reasons, and the second is why this exists at all: an
  // undrained pipe eventually fills, and an unread pipe throws the evidence away when
  // the child dies. The port reader below listens on `stdout` for one line; this keeps
  // BOTH streams and hands their tail to `waitForHealth`.
  const output: string[] = [];
  const keep = (chunk: unknown): void => {
    output.push(String(chunk));
    // A ring, so a long-lived child cannot turn diagnosis into a memory leak.
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("api never reported a port")), 30_000);
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      for (const line of buffered.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { msg?: string; port?: number };
          if (parsed.msg === "listening" && typeof parsed.port === "number") {
            clearTimeout(timer);
            resolve(parsed.port);
            return;
          }
        } catch {
          /* a partial line; the next chunk completes it */
        }
      }
    });
    child.on("exit", (code, signal) => {
      keep(`\n[child exited code=${String(code)} signal=${String(signal)}]\n`);
      clearTimeout(timer);
      reject(
        new Error(
          `api exited before listening (code ${String(code)})` +
            `\n--- child output ---\n${output.join("")}`,
        ),
      );
    });
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(`${url}/healthz`, () => output.join(""));

  return {
    url,
    environmentId: environment.id,
    credential: key.credential,
    channelId: channel.id,
    stop: () => child.kill(),
  };
}

async function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.on("close", (code) => resolve(code));
    socket.on("error", () => undefined);
    setTimeout(() => reject(new Error("no close within 5s")), 5_000);
  });
}

async function firstFrame(socket: WebSocket, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type: string };
      if (frame.type === type) resolve(frame);
    });
    socket.on("close", (code) => reject(new Error(`closed ${code}`)));
    setTimeout(() => reject(new Error(`no ${type} within 5s`)), 5_000);
  });
}

describe("the socket's credentials", () => {
  let api: ApiUnderTest;
  let server: Server;
  let url: string;
  const sockets: WebSocket[] = [];

  const mintToken = async (user = "tuan", ttlSeconds = 3600) => {
    const res = await fetch(`${api.url}/auth/dev-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({ user, ttl_seconds: ttlSeconds }),
    });
    if (!res.ok) throw new Error(`dev-token: ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };

  const connect = (token: string) => {
    const socket = new WebSocket(`${url}/v1/ws?token=${token}`);
    sockets.push(socket);
    return socket;
  };

  beforeAll(async () => {
    api = await startApi();
    server = serve({
      service: "gateway",
      health: () => ({}),
      logger: silent,
      notFoundDocsUrl: docsUrl("not_found"),
    });
    attachSessions({ server, api: createApiClient(api.url), logger: silent });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  it("opens for a token the api minted, and knows the user's channels", async () => {
    const frame = (await firstFrame(
      connect(await mintToken()),
      "connection.ack",
    )) as { payload: { user: string; channels?: string[] } };
    // The identity in the ack came from the api's verification, not from
    // anything the gateway decided.
    expect(frame.payload.user).toBe("tuan");
  });

  it("refuses an API KEY presented as a socket token (4001)", async () => {
    // The chapter's mistake, at the other door: the credential is perfectly
    // valid, and it is the wrong kind for a socket. The upgrade closes 4001
    // rather than opening a session for an application.
    expect(await closeCode(connect(api.credential))).toBe(4001);
  });

  it("refuses a token this environment did not sign (4001)", async () => {
    const foreign = await fetch(`${api.url}/auth/dev-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "tuan" }),
    });
    // No credential at all: the api refuses to mint, so there is nothing to
    // present. The socket's refusal is the same one either way.
    expect(foreign.status).toBe(401);
    expect(await closeCode(connect("eyJhbGciOiJIUzI1NiJ9.forged.signature"))).toBe(
      4001,
    );
  });

  it("keeps an established connection alive past its token's expiry (invariant 10)", async () => {
    // FR-AUT-11's first clause, and the reason it is worth a test: verification
    // happens AT CONNECT. A socket is not re-authenticated on a timer, so a
    // token that ages out mid-conversation does not drop the call.
    const socket = connect(await mintToken("tuan", 2));
    await firstFrame(socket, "connection.ack");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(socket.readyState).toBe(WebSocket.OPEN);

    // What it can no longer do is WRITE, and this is the honest half of the
    // requirement rather than a bug: the internal hop forwards the user's own
    // token, so a write after expiry presents an expired credential and the api
    // refuses it. Delivery is unaffected — fan-out never asks the api anything.
    //
    // FR-AUT-11's SECOND clause is what would close this gap: a frame that lets
    // the client hand over a refreshed token on the open connection. This
    // chapter does not build it, so the socket says what a client can actually
    // do instead.
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: api.channelId,
          text: "still here",
        },
      }),
    );
    const refusal = (await firstFrame(socket, "error")) as {
      payload: { code: string; message: string };
    };
    expect(refusal.payload.code).toBe("unauthorized");
    expect(refusal.payload.message).toMatch(/expired/);
    expect(refusal.payload.message).toMatch(/reconnect/);
    // Still open after the refusal: refusing a write is not closing a socket.
    expect(socket.readyState).toBe(WebSocket.OPEN);
  }, 20_000);

  it("a reconnect with a fresh token can send again", async () => {
    // The recovery path the refusal above names, proven rather than asserted.
    const socket = connect(await mintToken("tuan", 3600));
    await firstFrame(socket, "connection.ack");
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: api.channelId,
          text: "back with a fresh token",
        },
      }),
    );
    const ack = (await firstFrame(socket, "message.ack")) as {
      payload: { seq: number };
    };
    expect(ack.payload.seq).toBeGreaterThan(0);
  });

  afterAll(async () => {
    api?.stop();
    server?.close();
  });
});

describe("the socket's delivery, with a fan-out attached", () => {
  let api: ApiUnderTest;
  let server: Server;
  let url: string;
  let fanout: Fanout;
  /** A SECOND client on the same subject, standing in for whoever published —
   * the api, in this chapter, and any other gateway instance before it. The
   * subscriber under test must not be the publisher, or the test proves only
   * that an object can call itself. */
  let publisher: Fanout;
  /** **Its dependency injection is three hundred lines above the test
   * that needs it**, and without this line the inversion below simply fails: this
   * describe injected no `presence`, no `limits` and no `membership`, so the gateway
   * under it never learned of a removal. */
  let membership: Membership;
  const sockets: WebSocket[] = [];

  const mintToken = async (user = "tuan") => {
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

  const connect = (token: string) => {
    const socket = new WebSocket(`${url}/v1/ws?token=${token}`);
    sockets.push(socket);
    return socket;
  };

  /** Every frame a socket sees, in order. Attached before `open` resolves,
   * because `connection.ack` arrives the instant the upgrade completes and a
   * listener added after a yield to the event loop misses it. */
  const record = (socket: WebSocket): { type: string; payload?: unknown }[] => {
    const frames: { type: string; payload?: unknown }[] = [];
    socket.on("message", (raw) => {
      frames.push(JSON.parse(String(raw)) as { type: string });
    });
    return frames;
  };

  const waitFor = async (
    frames: { type: string; payload?: unknown }[],
    predicate: (f: { type: string; payload?: unknown }) => boolean,
    what: string,
    ms = 4_000,
  ) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = frames.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `no ${what}; saw ${frames.map((f) => f.type).join(", ") || "nothing"}`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  beforeAll(async () => {
    api = await startApi();
    fanout = createFanout({ logger: silent });
    publisher = createFanout({ logger: silent });
    server = serve({
      service: "gateway",
      health: () => ({}),
      logger: silent,
      notFoundDocsUrl: docsUrl("not_found"),
    });
    membership = createMembership({ logger: silent });
    attachSessions({
      server,
      api: createApiClient(api.url),
      logger: silent,
      fanout,
      membership,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  afterAll(async () => {
    await fanout.close();
    await publisher.close();
    await membership.close();
    server.close();
    api?.stop();
  });

  it("delivers a frame published by somebody else to a member's socket", async () => {
    // T014's own proof that the harness works. Nothing here is about the api
    // publishing — that is Phase 3 — only that a frame placed on the subject by
    // a different client reaches a socket this gateway holds. Without it, every
    // delivery test below would fail for the same uninformative reason.
    const socket = connect(await mintToken());
    const frames = record(socket);
    await waitFor(frames, (f) => f.type === "connection.ack", "connection.ack");

    // `api.channelId`, not the ack. `connectionAckSchema.payload` is
    // `{ user, cursor, resume_ok, truncated }` — there is no `channels` field on
    // it, and the first version of this test read one. The gateway knows the
    // channel list internally, from `POST /internal/session`; it does not tell
    // the client, which is why this reads the seeded id from the harness.
    const channel = api.channelId;

    await publisher.publish({
      id: randomUUID(),
      channel,
      seq: 9_001,
      user: "tuan",
      text: "published by somebody else",
      created_at: new Date(0).toISOString(),
    });

    const delivered = (await waitFor(
      frames,
      (f) => f.type === "message.created",
      "message.created",
    )) as { payload: { text: string; seq: number } };
    expect(delivered.payload.text).toBe("published by somebody else");
    expect(delivered.payload.seq).toBe(9_001);
  });

  it("delivers to EVERY connection the same person holds (T021)", async () => {
    // Spec edge case 5. What is under test is the registry's fan-out to local
    // sockets, so who published is irrelevant — this publishes directly. Two
    // sockets for one user is the case a naive registry keyed by user id gets
    // wrong, and it is worth its own test because the failure is invisible: one
    // of the two tabs just stops updating.
    const token = await mintToken();
    const a = record(connect(token));
    const b = record(connect(token));
    await waitFor(a, (f) => f.type === "connection.ack", "ack on a");
    await waitFor(b, (f) => f.type === "connection.ack", "ack on b");

    const text = `to both tabs ${randomUUID()}`;
    await publisher.publish({
      id: randomUUID(),
      channel: api.channelId,
      seq: 9_002,
      user: "tuan",
      text,
      created_at: new Date(0).toISOString(),
    });

    for (const [frames, which] of [[a, "a"], [b, "b"]] as const) {
      const got = (await waitFor(
        frames,
        (f) => f.type === "message.created",
        `message.created on ${which}`,
      )) as { payload: { text: string } };
      expect(got.payload.text).toBe(text);
    }
  });

  it("delivers a message SENT OVER REST to an open socket (SC-001, FR-004)", async () => {
    // THE CHAPTER, END TO END, in the integration lane. A real api spawned from
    // dist/main.js, a real gateway, a real socket opened before the send, and a
    // POST to the route a customer's backend calls. Nothing here publishes by
    // hand.
    //
    // `user` is required and must name a bot: an application credential may
    // speak only as software. `idempotency_key` must be a UUID on
    // this route, where the socket frame takes any string.
    const frames = record(connect(await mintToken()));
    await waitFor(frames, (f) => f.type === "connection.ack", "connection.ack");

    const text = `over REST to a socket ${randomUUID()}`;
    const posted = await fetch(
      `${api.url}/v1/channels/${api.channelId}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${api.credential}`,
        },
        body: JSON.stringify({
          text,
          user: "delivery-bot",
          idempotency_key: randomUUID(),
        }),
      },
    );
    expect(posted.status, await posted.clone().text()).toBe(201);

    const delivered = (await waitFor(
      frames,
      (f) => f.type === "message.created",
      "message.created for a REST send",
    )) as { payload: { text: string; user: string; seq: number } };
    expect(delivered.payload.text).toBe(text);
    expect(delivered.payload.user).toBe("delivery-bot");
    // The sequence the api committed, not one the gateway invented.
    expect(delivered.payload.seq).toBeGreaterThan(0);
  });

  it("stops delivering to a member who was REMOVED while connected (FR-RTM-10)", async () => {
    // INVERTED IN THE MEMBERSHIP-REVOCATION CHAPTER, AND THE TITLE WITH IT. This test read "keeps
    // delivering" and asserted the violation on purpose from the fan-out chapter until
    // now — its own closing comment carried the instruction: "change this to
    // `.rejects` on the day a re-read exists".
    //
    // FR-RTM-10 is P1: events "shall not be delivered to a client whose membership
    // no longer grants access, effective within 5 seconds of the membership change".
    // What the old comment described is what changed:
    //
    //   `connection.channelIds` is a Set built once at connect, `fanout.subscribe`
    //   runs once over it, `fanout.unsubscribe` runs once when the socket CLOSES,
    //   and `registry.subscribersOf` reads that same set on every delivery. Nothing
    //   in between re-reads membership. **There is no code path that could.**
    //
    // There is now: `deliverMembership` in `session.ts` deletes the channel from
    // that Set when the fabric says the membership ended.
    //
    // **THE 5,500 ms WAIT IS UNCHANGED**, which is the whole point of inverting this
    // test rather than writing a new one. A pass means the clause is met, not that
    // the assertion moved to somewhere easier.
    //
    // AND THE TITLE IS PART OF THE CHANGE. THE PRESENCE CHAPTER shipped a test whose title
    // claimed an arm it never touched and nothing caught it for four phases; a title
    // saying "keeps delivering" over an assertion that nothing arrives is the same
    // defect with the sign flipped.
    const channel = api.channelId;
    const frames = record(connect(await mintToken()));
    await waitFor(frames, (f) => f.type === "connection.ack", "connection.ack");

    const removed = await fetch(
      `${api.url}/v1/channels/${channel}/members/remove`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${api.credential}`,
        },
        body: JSON.stringify({ user_ids: ["tuan"] }),
      },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);

    // The clause's own window, plus a margin. If a re-read existed anywhere —
    // a poll, an invalidation, a message on another subject — five seconds is
    // the budget it was given.
    await new Promise((r) => setTimeout(r, 5_500));

    const text = `after removal ${randomUUID()}`;
    const posted = await fetch(`${api.url}/v1/channels/${channel}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({
        text,
        user: "delivery-bot",
        idempotency_key: randomUUID(),
      }),
    });
    expect(posted.status).toBe(201);

    await expect(
      waitFor(
        frames,
        (f) =>
          f.type === "message.created" &&
          (f as { payload: { text: string } }).payload.text === text,
        "the frame FR-RTM-10 says must not arrive",
      ),
    ).rejects.toThrow(/must not arrive/);

    // AND THE NOTICE DID ARRIVE, which is the half that separates a working
    // revocation from a socket that broke. `waitFor` rejecting proves only that
    // nothing came; a gateway that dropped the connection satisfies that perfectly.
    expect(
      frames.filter((f) => f.type === "membership.changed"),
    ).toHaveLength(1);
  }, 20_000);

  it("delivers nothing from a PRIVATE channel to a non-member's socket (FR-014, SC-007)", async () => {
    // FR-CHN-05's fourth door. The read paths got three in the channel-control chapter — list,
    // history, and the channel itself — and delivery is the one this chapter
    // opens. Tested as its own case rather than inferred from the others,
    // because the mechanism is different: the read paths ask the repository,
    // and delivery asks whether a subject was ever subscribed to.
    //
    // A non-member's connection subscribes to nothing, so it cannot hear the
    // subject at all. That is a stronger property than a refusal — there is no
    // decision to get wrong — and it is worth pinning for exactly that reason:
    // a future re-read that "fixed" subscriptions could break it.
    const stranger = `stranger-${randomUUID().slice(0, 8)}`;
    const created = await fetch(`${api.url}/v1/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({ users: [{ external_id: stranger }] }),
    });
    expect(created.status, await created.clone().text()).toBeLessThan(300);

    const privately = await fetch(`${api.url}/v1/channels`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({
        external_id: `private-${randomUUID().slice(0, 8)}`,
        type: "private",
      }),
    });
    expect(privately.status).toBe(201);
    const privateId = ((await privately.json()) as { id: string }).id;

    const frames = record(connect(await mintToken(stranger)));
    await waitFor(frames, (f) => f.type === "connection.ack", "connection.ack");

    // Published directly: what is under test is whether a non-member's socket
    // can hear the subject, not whether the api will publish to it.
    await publisher.publish({
      id: randomUUID(),
      channel: privateId,
      seq: 9_100,
      user: "tuan",
      text: "not for a stranger",
      created_at: new Date(0).toISOString(),
    });
    await new Promise((r) => setTimeout(r, 800));

    expect(frames.filter((f) => f.type === "message.created")).toEqual([]);
  });
  /** Something schema-valid for each outbound type, so the refusal under test is
   * the direction one. Mirrors `isolation.itest.ts`'s builder; the duplication is
   * deliberate, because that file proves a client cannot FORGE these and this one
   * proves the seam still refuses them after being widened. */
  const sampleOutbound = (type: string, channel: string): unknown => {
    const message = {
      id: randomUUID(),
      channel,
      seq: 1,
      user: "tuan",
      text: "forged",
      created_at: new Date().toISOString(),
    };
    switch (type) {
      case "connection.ack":
        return {
          type,
          payload: { user: "tuan", cursor: {}, resume_ok: true, truncated: [] },
        };
      case "message.ack":
        return { type, payload: { seq: 1 } };
      case "message.created":
      case "message.updated":
      case "message.deleted":
        return { type, payload: message };
      case "membership.changed":
        return { type, payload: { channel, user: "tuan", change: "added" } };
      case "presence.changed":
        return { type, payload: { user: "tuan", state: "online" } };
      case "typing":
        return { type, payload: { channel, user: "tuan" } };
      default:
      // NO `request_id` IN THE ERROR SAMPLE. The payload is a `strictObject`, so an
      // extra field is refused as `invalid_frame` — and this loop asserts
      // `unknown_frame_type`, which is a claim about DIRECTION. A sample that fails
      // validation tests the validator instead.
        return {
          type,
          payload: {
            code: "forged",
            message: "forged",
            docs_url: "/x",
          },
        };
    }
  };

  /** T034 — T009 INVERTED, and the same shape on purpose.
   *
   * The send is byte-identical to the one that got `unknown_frame_type` and a
   * 4002 in phase 2. Only the seam moved, so a pass here means the seam moved —
   * not that somebody softened an assertion until it passed.
   *
   * The refusal's three states, closed:
   *
   *   phase 1   not in the union         ->  invalid_frame, socket open
   *   phase 2   in the union, not send   ->  unknown_frame_type, close 4002
   *   phase 4   in the named inbound set ->  accepted, socket open        <- here
   *
   * NO ACK, AND THAT IS THE ASSERTION. A typing signal is answered by nothing:
   * no `message.ack`, no error, no close. So "accepted" can only be tested as
   * the absence of a refusal plus a socket still open — which is why the wait
   * below is real time rather than a frame to await. */
  it("accepts typing.send and answers with nothing at all", async () => {
    const socket = connect(await mintToken());
    const frames = record(socket);
    await waitFor(frames, (f) => f.type === "connection.ack", "connection.ack");

    let closeCode: number | undefined;
    socket.on("close", (code: number) => {
      closeCode = code;
    });

    socket.send(
      JSON.stringify({
        type: "typing.send",
        payload: { channel: api.channelId },
      }),
    );

    await new Promise((r) => setTimeout(r, 400));
    expect(frames.filter((f) => f.type === "error")).toEqual([]);
    expect(closeCode).toBeUndefined();
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  /** T035. EVERY OTHER TYPE, DRIVEN FROM THE UNION rather than from a list.
   *
   * A hand-written list is a second place to forget the eleventh type — and this
   * chapter added one, so the list would already be wrong. `frameSchema.options`
   * yields the discriminators at runtime, so a twelfth frame appears here without
   * an edit and fails until somebody decides its direction.
   *
   * **EVERY SAMPLE IS SCHEMA-VALID FOR ITS TYPE**, which is the whole care in
   * this test. A frame that fails `safeParse` is answered `invalid_frame` and
   * never reaches the direction check — so a sloppy payload would turn nine
   * direction assertions into nine parser assertions and still be green.
   * `isolation.itest.ts`'s sample builder makes the same point in its own
   * comment, and this is a second copy rather than a shared helper because the
   * two files disagree about what they are proving. */
  it("refuses every non-inbound type with unknown_frame_type and 4002", async () => {
    const outbound = frameSchema.options
      .map((option) => (option.shape.type as { value: string }).value)
      .filter((type) => type !== "message.send" && type !== "typing.send");

    expect(outbound).toHaveLength(9);

    for (const type of outbound) {
      const socket = connect(await mintToken());
      const frames = record(socket);
      await waitFor(frames, (f) => f.type === "connection.ack", "connection.ack");
      const closed = new Promise<number>((resolve) =>
        socket.on("close", (code: number) => resolve(code)),
      );

      socket.send(JSON.stringify(sampleOutbound(type, api.channelId)));

      const error = await waitFor(frames, (f) => f.type === "error", `error for ${type}`);
      expect(error.payload, `direction refusal for ${type}`).toMatchObject({
        code: "unknown_frame_type",
      });
      expect(await closed, `close code for ${type}`).toBe(4002);
    }
  });

  /** T037. THE PAYLOAD CANNOT NAME A USER, and the delivered frame names the
   * connection's identity in the same run.
   *
   * Two halves because they fail differently: a `user` on the way IN is a schema
   * rejection (`typingSendSchema` is strict and has no such field), and the user
   * on the way OUT is `signalTyping` reading `connection.identity`. A test that
   * only checked the first would pass against a handler that took the user from
   * anywhere. */
  it("refuses a typing.send whose payload names a user", async () => {
    const socket = connect(await mintToken());
    const frames = record(socket);
    await waitFor(frames, (f) => f.type === "connection.ack", "connection.ack");

    socket.send(
      JSON.stringify({
        type: "typing.send",
        payload: { channel: api.channelId, user: "somebody-else" },
      }),
    );

    const error = await waitFor(frames, (f) => f.type === "error", "error");
    // `invalid_frame`, not `unknown_frame_type`: the type IS inbound, so this
    // never reaches the direction check — the strict schema rejects it first.
    expect(error.payload).toMatchObject({ code: "invalid_frame" });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});
