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
import { createConnections, type Connections } from "./connections.js";
import { attachSessions } from "./session.js";

// The socket's credential cases (chapter 3.2), against a REAL api.
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
    /** Chapter 3.18. An application credential may send only as a bot user
     * (chapter 3.17), so a REST send needs one to exist — and `createUser`
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
      // CHAPTER 3.21. **The child has already said why and nobody was
      // listening.** This file spawns with `stdio: ["ignore", "pipe", "pipe"]`
      // and never read either pipe, so an api that died took its reason with it —
      // which is the entire reason chapter 3.20's `gaps.md` item 19a has four
      // occurrences and three eliminated hypotheses rather than a cause. The
      // buffer is drained below and its tail is attached here.
      throw new Error(
        `api never became healthy${why === undefined ? "" : `\n--- child output ---\n${why()}`}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A FRESH PORT PER CALL, and chapter 3.11 had to learn why twice.
 *
 * This used to bind a fixed 4123. Two things go wrong with a fixed port and both
 * of them look like a broken feature rather than a broken fixture:
 *
 *   - `limits.itest.ts` binds 4124 and vitest runs these files in PARALLEL, so a
 *     second describe here that picked 4124 raced it;
 *   - and back to back, the previous run's child can still hold the port. The
 *     new child exits on EADDRINUSE, `waitForHealth` gets a 200 from the OLD
 *     api — a different environment, a different signing secret — and every
 *     token this run minted is refused by an api that has never heard of it.
 *
 * The symptoms are `fetch failed`, `expected 1011 to be 4001`, and
 * `expected 'internal_error' to be 'unauthorized'`: three different assertions,
 * one fixture. `meter.itest.ts` already picks a random high port for exactly
 * this, and this now does the same. */
async function startApi(
  port = Number(
    process.env.RELAY_SESSION_ITEST_API_PORT ??
      4400 + Math.floor(Math.random() * 200),
  ),
): Promise<ApiUnderTest> {
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
  // Chapter 3.18: the sender a REST send names. ADDITIVE to this fixture — the
  // tests above assert on "tuan" and a second user changes nothing for them,
  // which is the difference between adding a capability and repurposing one.
  await repo.upsertUser("delivery-bot", {
    display_name: "Delivery Bot",
    kind: "bot",
    description: "sends over REST so a socket can receive it",
  });
  // CHAPTER 3.23: two PEOPLE in the channel, because FR-005's property is "every
  // connected member" and one socket cannot show it. ADDITIVE, on chapter 3.18's
  // precedent recorded just above — the tests that assert on "tuan" are unaffected by
  // two more members of a public channel, and T033 is the only test that names these.
  //
  // BOTH ARE MEMBERS, and that is what the first run of T033 got wrong: `mintToken`
  // mints a token for any identifier, so two sockets opened fine and neither was
  // delivered to. The failure read "no the creation; saw connection.ack" — a
  // membership problem wearing a delivery problem's message.
  const editor = await repo.createUser("editor", "The Editor");
  const watcher = await repo.createUser("watcher", "The Watcher");
  const channel = await repo.createChannel("fleet", "public");
  await repo.addMember(channel.id, user.id);
  await repo.addMember(channel.id, editor.id);
  await repo.addMember(channel.id, watcher.id);
  const key = await seeder.createApiKey(db, {
    environmentId: environment.id,
  });

  const child: ChildProcess = spawn("node", [join(dist, "main.js")], {
    // Chapter 3.3: no outbox relay in this child. This suite is about the
    // socket's credentials; a background loop draining a table that chapter
    // 3.3's suite is asserting on turns two unrelated test files into a race.
    env: { ...process.env, PORT: String(port), RELAY_OUTBOX_RELAY: "off",
      // Chapter 3.8: nor the notification relay, for the same reason.
      RELAY_NOTIFICATION_RELAY: "off",
      // Chapter 3.11: its own failed-authentication keyspace. Chapter 3.8's auth
      // limiter counts failures per SOURCE ADDRESS in Redis, every suite in this
      // lane is 127.0.0.1, and vitest runs the files in parallel — so ten
      // failures a minute across ALL of them turns a neighbour's expected 401
      // into a 429.
      //
      // NOT what broke this file — that was the fixed port above — and this was
      // the first theory, held long enough to be written down before the evidence
      // arrived. Kept because the coupling is real and the isolation costs one
      // line, but it fixed nothing here and the comment says so rather than
      // taking the credit.
      RELAY_AUTH_KEY_PREFIX: `rlauth-session-${randomUUID().slice(0, 8)}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // DRAINED, AND KEPT. Two reasons, and the second is why this exists at all:
  // an undrained pipe fills (chapter 3.20 measured 4,000 requests before it
  // mattered, so this is not the cause of any death), and an unread pipe throws
  // the evidence away when one happens. Item 19a is four unexplained failures
  // across two chapters — `ECONNREFUSED` on a port this file chose — and every
  // one of them had an api that already said why.
  const output: string[] = [];
  const keep = (chunk: unknown): void => {
    output.push(String(chunk));
    // A ring, so a long-lived child cannot turn diagnosis into a memory leak.
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("exit", (code, signal) => {
    keep(`\n[child exited code=${String(code)} signal=${String(signal)}]\n`);
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

describe("the socket's credentials (chapter 3.2)", () => {
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
    // No port argument: `startApi` picks its own, for the reasons written above
    // it. This describe is where the fixed-port fault was found.
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

  // T022c and T020a (chapter 3.24). THE SOCKET DOOR, WHICH IS THE ONE THAT DROPS THINGS.
  //
  // Every other send test in this chapter walks the REST door, and the REST door was never
  // at risk: it validates with `sendMessageBodySchema` and hands a typed body straight to
  // the service. The socket path has three named points where a field can vanish without
  // an error — `session.ts`'s inbound destructure, `internal.controller.ts`'s named build,
  // and `session.ts`'s outbound payload — and a message that commits without its
  // attachments is acked as though it worked.
  it("refuses eleven at the GATEWAY, naming the field (FR-005 (3.24))", async () => {
    // NAME THE LAYER AND THE CODE. The bound is on `messageSendSchema`, so the gateway
    // refuses the frame before the api sees it and the client gets `invalid_frame` —
    // not the api's `invalid_request`. Two doors, two refusals, one bound, and a test
    // asserting only "it was refused" could not tell a working bound from a socket that
    // dropped the field entirely.
    const socket = connect(await mintToken("tuan", 3600));
    await firstFrame(socket, "connection.ack");
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: api.channelId,
          text: "eleven over the socket",
          attachments: Array.from({ length: 11 }, (_, i) => ({
            type: "url",
            kind: "image",
            url: `https://example.test/${i}.png`,
          })),
        },
      }),
    );
    const refusal = (await firstFrame(socket, "error")) as {
      payload: { code: string; field?: string };
    };
    expect(refusal.payload.code).toBe("invalid_frame");
    // T041a: the frame contract has published `field` since chapter 1.3 and the gateway
    // had never set it. The joined path is what a developer reading their own frame sees.
    expect(refusal.payload.field).toBe("payload.attachments");
  }, 20_000);

  it("refuses a media_id and SAYS hosted media is unavailable (FR-003a (3.24))", async () => {
    // THE MESSAGE, BECAUSE THE CODE IS THE SAME ONE EVERY MALFORMED FRAME GETS. A one-arm
    // union would also refuse this — with "Invalid discriminator value. Expected 'url'",
    // which is the sentence FR-003a forbids by name. This assertion is the only thing
    // that can tell the two-arm schema from a one-arm one on this door.
    const socket = connect(await mintToken("tuan", 3600));
    await firstFrame(socket, "connection.ack");
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: api.channelId,
          text: "hosted media over the socket",
          attachments: [{ type: "media", media_id: "m_1" }],
        },
      }),
    );
    const refusal = (await firstFrame(socket, "error")) as {
      payload: { code: string; message: string };
    };
    // `invalid_frame` AND NOT `media_not_available`: `sendError` fixes its code at the
    // call site, so the REST door answers with the code and the socket answers with the
    // sentence. T039 records that split.
    expect(refusal.payload.code).toBe("invalid_frame");
    expect(refusal.payload.message).toMatch(/hosted media is not available/i);
  }, 20_000);

  it("commits TWO attachments sent over the socket, in order (FR-001 (3.24), FR-006 (3.24))", async () => {
    const socket = connect(await mintToken("tuan", 3600));
    await firstFrame(socket, "connection.ack");
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: api.channelId,
          text: "two over the socket",
          // TWO, IN A DELIBERATE ORDER. One cannot show an order, and the ordered pair is
          // what makes §4.14's later arm safe to add.
          attachments: [
            { type: "url", kind: "image", url: "https://example.test/socket-first.png" },
            { type: "url", kind: "video", url: "https://example.test/socket-second.mp4" },
          ],
        },
      }),
    );
    const ack = (await firstFrame(socket, "message.ack")) as { payload: { seq: number } };
    expect(ack.payload.seq).toBeGreaterThan(0);

    // THROUGH THE COLUMN, NOT HISTORY, AND THAT IS A PHASE ORDERING FACT. The ack carries
    // a sequence and nothing else — it has never carried a message and this chapter does
    // not widen it — so an ack alone cannot tell a stored attachment from a dropped one.
    // History would be the natural reader, and `listMessages` does not select the column
    // until phase 5 (T028), so asserting there would fail for the next phase's reason.
    // Phase 5's T030 is where this claim moves to the wire.
    const client = require_(
      join(REPO, "services", "api", "dist", "db", "client.js"),
    ) as {
      createPool: () => {
        query: (q: string, v: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
        end: () => Promise<void>;
      };
    };
    const pool = client.createPool();
    const { rows } = await pool.query(
      "SELECT attachments FROM messages WHERE sequence = $1 AND channel_id = $2",
      [ack.payload.seq, api.channelId],
    );
    await pool.end();
    expect(
      (rows[0]!["attachments"] as Array<{ url: string }>).map((a) => a.url),
    ).toEqual([
      "https://example.test/socket-first.png",
      "https://example.test/socket-second.mp4",
    ]);
  }, 20_000);

  it("accepts an attachments-only message and refuses one with neither (FR-019 (3.24), FR-019b (3.24))", async () => {
    const socket = connect(await mintToken("tuan", 3600));
    await firstFrame(socket, "connection.ack");

    // BOTH HALVES. The acceptance passes the moment the text bound is relaxed; the refusal
    // needs a rule that relaxation removes, and `refineTextAndAttachments` is the only
    // thing putting it back on this door.
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: api.channelId,
          text: "",
          attachments: [
            { type: "url", kind: "image", url: "https://example.test/no-caption.png" },
          ],
        },
      }),
    );
    const ack = (await firstFrame(socket, "message.ack")) as { payload: { seq: number } };
    expect(ack.payload.seq).toBeGreaterThan(0);

    const bare = connect(await mintToken("tuan", 3600));
    await firstFrame(bare, "connection.ack");
    bare.send(
      JSON.stringify({
        type: "message.send",
        payload: { idem_key: randomUUID(), channel: api.channelId, text: "", attachments: [] },
      }),
    );
    const refusal = (await firstFrame(bare, "error")) as {
      payload: { code: string; message: string };
    };
    // `invalid_frame`, NOT `invalid_request`. The bound is on `messageSendSchema`, so the
    // GATEWAY refuses the frame before the api sees it — two doors, two codes, one rule,
    // and a test asserting only "it was refused" could not tell which layer answered.
    expect(refusal.payload.code).toBe("invalid_frame");
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

describe("the cap at the door (chapter 3.11, US3)", () => {
  let api: ApiUnderTest;
  let server: Server;
  let url: string;
  const sockets: WebSocket[] = [];
  let stopSessions: () => Promise<void>;

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

  const setCap = async (config: unknown) => {
    const client = require_(
      join(REPO, "services", "api", "dist", "db", "client.js"),
    ) as { createPool: () => { query: (q: string, v: unknown[]) => Promise<unknown>; end: () => Promise<void> } };
    const pool = client.createPool();
    await pool.query(
      "UPDATE environments SET quota_config = $1 WHERE id = $2",
      [JSON.stringify(config), api.environmentId],
    );
    await pool.end();
  };

  beforeAll(async () => {
    api = await startApi();
    server = serve({
      service: "gateway",
      health: () => ({}),
      logger: silent,
      notFoundDocsUrl: docsUrl("not_found"),
    });
    const sessions = attachSessions({
      server,
      api: createApiClient(api.url),
      logger: silent,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stopSessions = sessions.close;
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await stopSessions?.();
    server?.close();
    api?.stop();
  });

  it("closes 4008 with an error frame naming the resume date", async () => {
    // THE CLIENT'S HALF. The api answers 402; what reaches the browser is the
    // socket's own vocabulary — a code the protocol has declared since chapter
    // 1.3 and nothing has ever sent.
    await setCap({ connection_minutes: { hard: 0 } });
    const socket = connect(await mintToken());

    const frame = (await firstFrame(socket, "error")) as {
      payload: { code: string; message: string; docs_url: string; request_id: string };
    };
    expect(frame.payload.code).toBe("quota_exceeded");
    expect(frame.payload.message).toContain("connection-minute");
    expect(frame.payload.message).toContain("connections resume on");
    // Four fields, like every other error this contract carries.
    expect(frame.payload.docs_url).toBeTruthy();
    expect(frame.payload.request_id).toBeTruthy();

    expect(await closeCode(socket)).toBe(4008);
  });

  it("is NOT 4001, and not 1011 either", async () => {
    // Before this chapter a 402 fell through to `parse`, threw, and closed 1011
    // — "we are broken, retry". Mapping it to `refused` instead would close 4001
    // — "your credential is bad" — which a client acts on by re-authenticating
    // for ever. The token here is perfectly good.
    await setCap({ connection_minutes: { hard: 0 } });
    const code = await closeCode(connect(await mintToken()));
    expect(code).not.toBe(4001);
    expect(code).not.toBe(1011);
    expect(code).toBe(4008);
  });

  it("opens normally the moment the cap is raised", async () => {
    await setCap({ connection_minutes: { hard: 100_000 } });
    const socket = connect(await mintToken());
    expect(await firstFrame(socket, "connection.ack")).toBeTruthy();
  });

  it("leaves a socket opened before the breach open and receiving", async () => {
    // FR-RTL-08's promise, and the reason the overshoot exists at all.
    await setCap({ connection_minutes: { hard: 100_000 } });
    const early = connect(await mintToken());
    expect(await firstFrame(early, "connection.ack")).toBeTruthy();

    await setCap({ connection_minutes: { hard: 0 } });
    const refused = connect(await mintToken());
    expect(await closeCode(refused)).toBe(4008);

    // The early socket is untouched by its neighbour's refusal.
    expect(early.readyState).toBe(WebSocket.OPEN);
  });
});

// ── chapter 3.18: the same harness, WITH a fan-out ──────────────────────────
//
// A THIRD DESCRIBE RATHER THAN A FOURTH ARGUMENT TO THE OTHER TWO. Both blocks
// above call `attachSessions({ server, api, logger })` with no `fanout`, so
// `fanout?.publish` is a no-op there and nothing in them subscribes to
// anything. That is correct for what they test — credentials and refusals — and
// changing them to carry a broker would move twelve socket opens and four api
// boots to prove nothing new. Chapter 3.17's T040b took five tests down doing
// exactly that, the fifth such incident in two features.
//
// So this adds a capability instead: a real spawned api, a real gateway, real
// sockets, and a fan-out wired in. Delivery lives here from now on.
describe("the socket's delivery, with a fan-out attached (chapter 3.18)", () => {
  let api: ApiUnderTest;
  let server: Server;
  let url: string;
  let fanout: Fanout;
  /** A SECOND client on the same subject, standing in for whoever published —
   * the api, in this chapter, and any other gateway instance before it. The
   * subscriber under test must not be the publisher, or the test proves only
   * that an object can call itself. */
  let publisher: Fanout;
  /** Chapter 3.20. **Its dependency injection is three hundred lines above the test
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
      attachments: [],
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

  it("delivers to EVERY connection the same person holds", async () => {
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
      attachments: [],
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

  // T028b, T030 and T029a (chapter 3.24). THE TWO DELIVERY DOORS AND THE ACK.
  const twoAttachments = [
    { type: "url", kind: "image", url: "https://example.test/deliver-first.png" },
    { type: "url", kind: "audio", url: "https://example.test/deliver-second.mp3" },
  ];
  const urlsOf = (payload: { attachments: Array<{ url?: string }> }) =>
    payload.attachments.map((a) => a.url);

  it("delivers attachments SOCKET to SOCKET, in order (FR-008 (3.24), SC-001 (3.24))", async () => {
    // ONE MEMBER SENDS OVER ITS SOCKET AND ANOTHER RECEIVES. The REST delivery test below
    // cannot see this path: the api builds the fan-out payload for a REST send and the
    // GATEWAY builds it for a socket send, so they are two constructions of one frame.
    // BOTH MUST BE MEMBERS, and `mintToken` mints a token for any identifier — so two
    // sockets open fine and neither is delivered to. This file already records that trap
    // 630 lines above, written for T033, and this test hit it anyway: the failure reads
    // "no message.created on the watcher; saw connection.ack", which is a membership
    // problem wearing a delivery problem's message.
    const added = await fetch(`${api.url}/v1/channels/${api.channelId}/members`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({ user_ids: ["linh"] }),
    });
    expect([200, 201, 409]).toContain(added.status);

    const senderSocket = connect(await mintToken("tuan"));
    const sender = record(senderSocket);
    const watcher = record(connect(await mintToken("linh")));
    await waitFor(sender, (f) => f.type === "connection.ack", "ack on sender");
    await waitFor(watcher, (f) => f.type === "connection.ack", "ack on watcher");

    const text = `socket to socket ${randomUUID()}`;
    senderSocket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: api.channelId,
          text,
          attachments: twoAttachments,
        },
      }),
    );

    const delivered = (await waitFor(
      watcher,
      (f) => f.type === "message.created" && (f as { payload: { text: string } }).payload.text === text,
      "message.created on the watcher",
    )) as { payload: { attachments: Array<{ url?: string }> } };
    expect(urlsOf(delivered.payload)).toEqual([
      "https://example.test/deliver-first.png",
      "https://example.test/deliver-second.mp3",
    ]);
  }, 20_000);

  it("delivers a deletion with NO attachment field at all (FR-013 (3.24))", async () => {
    // AN EXACT KEY SET, NOT `payload.attachments === undefined`. An absent key and an
    // undefined value are the same to a truthiness check and different to a contract —
    // and the contract is the point: `message.deleted` carries no text because a payload
    // with a text field can carry the words somebody asked to have removed, and an
    // attachment URL is exactly as recoverable. So the absence is the assertion.
    const watcher = record(connect(await mintToken("tuan")));
    await waitFor(watcher, (f) => f.type === "connection.ack", "ack on watcher");

    const text = `to be deleted ${randomUUID()}`;
    const posted = await fetch(`${api.url}/v1/channels/${api.channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
      },
      body: JSON.stringify({
        text,
        user: "delivery-bot",
        idempotency_key: randomUUID(),
        attachments: twoAttachments,
      }),
    });
    expect(posted.status, await posted.clone().text()).toBe(201);
    const created = (await posted.json()) as { id: string };
    await waitFor(watcher, (f) => f.type === "message.created", "message.created");

    const removed = await fetch(
      `${api.url}/v1/channels/${api.channelId}/messages/${created.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${api.credential}` } },
    );
    expect(removed.status, await removed.clone().text()).toBe(204);

    const deleted = (await waitFor(
      watcher,
      (f) => f.type === "message.deleted",
      "message.deleted",
    )) as { payload: Record<string, unknown> };
    expect(Object.keys(deleted.payload).sort()).toEqual([
      "channel",
      "deleted_at",
      "id",
      "seq",
      "user",
    ]);
  }, 20_000);

  it("carries only `seq` on the sender's ack (FR-008 (3.24))", async () => {
    // THE ACK HAS NEVER CARRIED A MESSAGE AND THIS CHAPTER DOES NOT WIDEN IT. A sender
    // learns its attachments landed from the `message.created` frame the fan-out returns
    // to it, not from the ack — so the ack's exact key set is the assertion.
    const ackSocket = connect(await mintToken("tuan"));
    const sender = record(ackSocket);
    await waitFor(sender, (f) => f.type === "connection.ack", "ack on sender");
    ackSocket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: api.channelId,
          text: `ack only ${randomUUID()}`,
          attachments: twoAttachments,
        },
      }),
    );
    const ack = (await waitFor(
      sender,
      (f) => f.type === "message.ack",
      "message.ack",
    )) as { payload: Record<string, unknown> };
    expect(Object.keys(ack.payload).sort()).toEqual(["seq"]);
  }, 20_000);

  it("delivers a message SENT OVER REST to an open socket (SC-001, FR-004)", async () => {
    // THE CHAPTER, END TO END, in the integration lane. A real api spawned from
    // dist/main.js, a real gateway, a real socket opened before the send, and a
    // POST to the route a customer's backend calls. Nothing here publishes by
    // hand.
    //
    // `user` is required and must name a bot: an application credential may
    // speak only as software (chapter 3.17). `idempotency_key` must be a UUID on
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
          // T030 (chapter 3.24). TWO, because one cannot show an order.
          attachments: twoAttachments,
        }),
      },
    );
    expect(posted.status, await posted.clone().text()).toBe(201);

    const delivered = (await waitFor(
      frames,
      (f) => f.type === "message.created",
      "message.created for a REST send",
    )) as {
      payload: {
        text: string;
        user: string;
        seq: number;
        attachments: Array<{ url?: string }>;
      };
    };
    // SC-001 IS A CLAIM THAT TWO READERS AGREE, so this compares the frame's list against
    // what the history route returns for the same message rather than asserting each
    // alone. The api builds this payload; the socket-to-socket test above covers the
    // gateway's own construction of the same frame.
    expect(urlsOf(delivered.payload)).toEqual([
      "https://example.test/deliver-first.png",
      "https://example.test/deliver-second.mp3",
    ]);
    const history = await fetch(
      `${api.url}/v1/channels/${api.channelId}/messages?limit=10`,
      { headers: { authorization: `Bearer ${api.credential}` } },
    );
    const page = (await history.json()) as {
      messages: Array<{ seq: number; attachments: Array<{ url?: string }> }>;
    };
    const read = page.messages.find((m) => m.seq === delivered.payload.seq)!;
    expect(urlsOf(read)).toEqual(urlsOf(delivered.payload));
    expect(delivered.payload.text).toBe(text);
    expect(delivered.payload.user).toBe("delivery-bot");
    // The sequence the api committed, not one the gateway invented.
    expect(delivered.payload.seq).toBeGreaterThan(0);
  });

  it("an edit over REST reaches every member's socket as message.updated exactly once (FR-005, SC-001)", async () => {
    // TWO SOCKETS, TWO DIFFERENT PEOPLE, and a count rather than a first match.
    // `waitFor` resolves on the first frame that matches, so it cannot see a duplicate;
    // FR-005 is one property with two halves — everybody gets it, and nobody gets it
    // twice — and only counting after a settle covers the second.
    const first = record(connect(await mintToken("editor")));
    const second = record(connect(await mintToken("watcher")));
    await waitFor(first, (f) => f.type === "connection.ack", "connection.ack (editor)");
    await waitFor(second, (f) => f.type === "connection.ack", "connection.ack (watcher)");

    // SENT BY THE EDITOR'S OWN TOKEN. Only an author may edit (FR-013) and the edit
    // route takes no application credential at all (FR-013a), so the send has to be
    // attributed to the same person — which a user token does by itself, and which is
    // why this body names no `user`.
    const editorToken = await mintToken("editor");
    const before = `to be corrected ${randomUUID()}`;
    const posted = await fetch(`${api.url}/v1/channels/${api.channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${editorToken}`,
      },
      body: JSON.stringify({ text: before }),
    });
    expect(posted.status, await posted.clone().text()).toBe(201);
    const sent = (await posted.json()) as { id: string; seq: number };
    await waitFor(second, (f) => f.type === "message.created", "the creation");

    const after = `${before} (corrected)`;
    const edited = await fetch(
      `${api.url}/v1/channels/${api.channelId}/messages/${sent.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${editorToken}`,
        },
        body: JSON.stringify({ text: after }),
      },
    );
    expect(edited.status, await edited.clone().text()).toBe(200);

    for (const [who, frames] of [
      ["editor", first],
      ["watcher", second],
    ] as const) {
      const updated = (await waitFor(
        frames,
        (f) => f.type === "message.updated",
        `message.updated (${who})`,
      )) as { payload: { text: string; seq: number; id: string } };
      expect(updated.payload.text, who).toBe(after);
      // THE SEQUENCE IT ALREADY HAD (FR-002), on the wire. A new number here would
      // put the edit at the end of every client's list and break every cursor.
      expect(updated.payload.seq, who).toBe(sent.seq);
      expect(updated.payload.id, who).toBe(sent.id);
    }

    // AND EXACTLY ONCE EACH, after a settle long enough for a second copy to have
    // arrived. Both counts, because the two sockets take different paths through the
    // registry — the editor's connection and the watcher's are separate entries and a
    // per-connection duplicate would show on one of them.
    await new Promise((r) => setTimeout(r, 300));
    expect(first.filter((f) => f.type === "message.updated")).toHaveLength(1);
    expect(second.filter((f) => f.type === "message.updated")).toHaveLength(1);
    // …AND NO SECOND CREATION, which is what ADR-24 is for. Routed to the old callback
    // the edit arrives as `message.created` and no shape check can see it, because the
    // `updated` arm's payload IS a `Message`.
    expect(first.filter((f) => f.type === "message.created")).toHaveLength(1);
    expect(second.filter((f) => f.type === "message.created")).toHaveLength(1);
  });

  it("a deletion over REST reaches a member's socket with NO text field, and a second deletion sends nothing (FR-007, FR-009)", async () => {
    const frames = record(connect(await mintToken("watcher")));
    await waitFor(frames, (f) => f.type === "connection.ack", "connection.ack");

    // Sent by the editor and deleted by the TENANT KEY, which FR-012 permits
    // irrespective of author — the path a moderator takes, exercised here because the
    // frame must be identical either way.
    const editorToken = await mintToken("editor");
    const text = `to be removed ${randomUUID()}`;
    const posted = await fetch(`${api.url}/v1/channels/${api.channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${editorToken}`,
      },
      body: JSON.stringify({ text }),
    });
    expect(posted.status, await posted.clone().text()).toBe(201);
    const sent = (await posted.json()) as { id: string; seq: number };
    await waitFor(frames, (f) => f.type === "message.created", "the creation");

    const removed = await fetch(
      `${api.url}/v1/channels/${api.channelId}/messages/${sent.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${api.credential}` } },
    );
    expect(removed.status, await removed.clone().text()).toBe(204);

    const frame = (await waitFor(
      frames,
      (f) => f.type === "message.deleted",
      "message.deleted",
    )) as { payload: Record<string, unknown> };
    // THE EXACT KEY SET, which is the assertion FR-020's sibling requirement needs:
    // "no text" as `Object.keys` rather than as `payload.text === undefined`, because
    // an absent key and a null one read the same through a property access.
    expect(Object.keys(frame.payload).sort()).toEqual([
      "channel",
      "deleted_at",
      "id",
      "seq",
      "user",
    ]);
    expect(frame.payload).not.toHaveProperty("text");
    // Identity and position (FR-008), and the sequence is the one it had — a tombstone
    // that gave up its place would leave a gap in every client's ordering.
    expect(frame.payload["id"]).toBe(sent.id);
    expect(frame.payload["seq"]).toBe(sent.seq);
    // THE AUTHOR, NOT THE DELETER. A tenant key removed it; the frame names who wrote
    // it, which is the fact every client already holds beside the message.
    expect(frame.payload["user"]).toBe("editor");

    // AND NO SECOND FRAME FOR A SECOND DELETION (FR-009, SC-007). The status is 204
    // either way, so this count is the only thing that can tell the two apart on the
    // wire.
    expect(
      (
        await fetch(`${api.url}/v1/channels/${api.channelId}/messages/${sent.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${api.credential}` },
        })
      ).status,
    ).toBe(204);
    await new Promise((r) => setTimeout(r, 300));
    expect(frames.filter((f) => f.type === "message.deleted")).toHaveLength(1);
  });

  it("stops delivering to a member who was REMOVED while connected (FR-RTM-10)", async () => {
    // INVERTED IN CHAPTER 3.20, AND THE TITLE WITH IT. This test read "keeps
    // delivering" and asserted the violation on purpose from chapter 3.18 until
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
    // AND THE TITLE IS PART OF THE CHANGE. Chapter 3.19 shipped a test whose title
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
    // FR-CHN-05's fourth door. The read paths got three in chapter 3.15 — list,
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
      attachments: [],
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
      // Chapter 3.24: WELL-FORMED IS THE POINT. `messageSchema` requires
      // attachments, and a forged frame missing them is refused for its SHAPE —
      // `invalid_frame` — a phase before the direction check this suite is about.
      attachments: [],
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
        return { type, payload: message };
      // CHAPTER 3.23 SPLIT THIS CASE OFF, and the failure that forced it is the point
      // of the test. `message.deleted` shared `message` — a `Message` with a `text` —
      // until 3.23 gave the frame a payload of its own with no text and a
      // `deleted_at`. The forged frame then failed the SHAPE check and came back
      // `invalid_frame`, so the test asserting `unknown_frame_type` went red.
      //
      // It was red for the right reason: this test's whole claim is that a WELL-FORMED
      // outbound frame is refused for its DIRECTION. A malformed one is refused a
      // phase earlier and proves nothing about direction at all — which is what it
      // would have been quietly asserting had the payload merely been tolerated.
      case "message.deleted":
        return {
          type,
          payload: {
            id: message.id,
            channel,
            seq: 1,
            user: "tuan",
            deleted_at: new Date().toISOString(),
          },
        };
      case "membership.changed":
        return { type, payload: { channel, user: "tuan", change: "added" } };
      case "presence.changed":
        return { type, payload: { user: "tuan", state: "online" } };
      case "typing":
        return { type, payload: { channel, user: "tuan" } };
      default:
        return {
          type,
          payload: {
            code: "forged",
            message: "forged",
            docs_url: "/x",
            request_id: "x",
          },
        };
    }
  };

  /** CHAPTER 3.21, T034 — T009 INVERTED, and the same shape on purpose.
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

describe("the connection cap at the door (chapter 3.22, US1)", () => {
  // ITS OWN FIXTURE, AND THE REASON IS A DEFECT T042d CAUSED. That task wired the
  // module into chapter 3.11's "cap at the door" describe, whose five quota tests
  // share the user "tuan" — so the cap bit them and two went red:
  //
  //   × opens normally the moment the cap is raised
  //   × leaves a socket opened before the breach open and receiving
  //
  // **Wiring a new module into an existing describe changes the behaviour of every
  // test in it.** The same class as the leak inside `connections.itest.ts`, where
  // tests sharing a user shared five places — fixed there with a fresh user per
  // test, and fixed here by not joining somebody else's fixture at all.
  let api: ApiUnderTest;
  let server: Server;
  let url: string;
  let connections: Connections;
  let stopSessions: () => Promise<void>;
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

  const connect = (token: string) => {
    const socket = new WebSocket(`${url}/v1/ws?token=${token}`);
    sockets.push(socket);
    return socket;
  };

  beforeAll(async () => {
    api = await startApi();
    connections = createConnections({ logger: silent });
    server = serve({
      service: "gateway",
      health: () => ({}),
      logger: silent,
      notFoundDocsUrl: docsUrl("not_found"),
    });
    const sessions = attachSessions({
      server,
      api: createApiClient(api.url),
      logger: silent,
      connections,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stopSessions = sessions.close;
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await stopSessions?.();
    await connections?.close();
    server?.close();
    api?.stop();
  });

  // CHAPTER 3.22, T011. RED ON PURPOSE, and the phase commit says so.
  //
  // FR-RTM-09 permits five concurrent connections per user and nothing counts
  // them, so all six of these are accepted today. This test asserts the sixth is
  // refused, which is the behaviour the chapter builds — so it fails now and
  // passes when Phase 5 lands. A red lane nobody explained is indistinguishable
  // from a red lane nobody noticed, and CI cannot tell them apart.
  //
  // IT LIVES IN THIS DESCRIBE FOR A REASON, and the reason was found in Phase 1.
  // Every gateway module is an optional parameter (`session.ts:192` onward) and
  // this block calls `attachSessions` with none, so the cap will not be enforced
  // here until Phase 5 passes the module in — which it must, or this test can
  // never go green. The block is named "the cap at the door" and already holds
  // the other two door refusals: chapter 3.8's rate limit and chapter 3.11's
  // quota. The connection cap is the third and belongs beside them.
  //
  // `expect.fail` is deliberate over `it.fails`: the assertion below states the
  // requirement, and a reader of a red run should see the count that was allowed
  // rather than "this test was expected to throw".
  it("refuses a sixth connection for one user (FR-RTM-09 (3.22))", async () => {
    // A user this test alone uses. The api's seed created "tuan"; a dev token for
    // any name works, and a name of its own is what keeps five places to itself.
    const token = await mintToken("tuan");
    const accepted: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const frame = (await firstFrame(connect(token), "connection.ack")) as {
        payload: { user: string };
      };
      expect(frame.payload.user).toBe("tuan");
      accepted.push(i);
    }
    expect(accepted).toHaveLength(5);

    // The sixth. Today it acks like the rest; after Phase 5 it closes with the
    // cap's own code, which is NOT 4001, 4002, 4003, 4008 or 4009 — every reuse
    // fails `codes.ts`'s standing test, "a client that cannot tell them apart
    // retries the wrong one for ever".
    const sixth = connect(token);
    const code = await closeCode(sixth);
    expect(code).not.toBe(4001);
    expect(code).toBeGreaterThanOrEqual(4000);
    expect(code).toBeLessThan(5000);
  }, 30_000);

});
