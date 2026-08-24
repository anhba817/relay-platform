import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createLogger, serve, type Logger } from "@relay/service-kit";
import { docsUrl } from "@relay/protocol";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiClient } from "./api-client.js";
import { createFanout, type Fanout } from "./fanout.js";
import { attachSessions } from "./session.js";

// THE EXIT CRITERION, REHEARSED IN THE LANE (FR-020, SC-015).
//
// A channel created over the public API, a member added over the public API, a
// message sent over the public API, and the socket delivering it to that member.
// Chapter 3.12 built the first two endpoints for exactly this path, and this is
// the test that the path joins up.
//
// NO REPOSITORY CALL FOR ANY OF IT, which is the whole point and is a narrower
// claim than it sounds. The environment and the API key still come through the
// build-output seam, because there is no public way to create either — that has
// been true since chapter 2.8 and is still true. Everything downstream of the
// credential is public HTTP: `POST /v1/channels`, `POST
// /v1/channels/:id/members`, `POST /auth/dev-token`, `POST
// /v1/channels/:id/messages`, and `ws://…/v1/ws`.
//
// `packages/outsider` will make the stronger version of this claim in Phase 10 —
// a package mechanically forbidden from importing workspace code at all. This one
// runs where the coverage lane can see it.

const silent: Logger = createLogger("gateway", () => {});
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);

interface Seeder {
  createEnvironment: (db: unknown, input: { name: string }) => Promise<{ id: string }>;
  createApiKey: (db: unknown, input: { environmentId: string }) => Promise<{ credential: string }>;
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("api never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 5200-5400 — see the port map at the top of `limits.itest.ts`. A random high
 * port per run, for the reason `session.itest.ts` records: a previous run's child
 * still holding a fixed port answers the health check from a DIFFERENT
 * environment, and every token this run minted is then refused by an api that has
 * never heard of it. */
async function startApi(): Promise<{ url: string; credential: string; stop: () => void }> {
  const port = 5200 + Math.floor(Math.random() * 200);
  const dist = join(REPO, "services", "api", "dist");
  if (!existsSync(join(dist, "main.js"))) {
    throw new Error("the api is not built — run `pnpm build` before this lane");
  }
  const client = require_(join(dist, "db", "client.js")) as {
    createDb: (pool: unknown) => unknown;
    createPool: () => unknown;
  };
  const seeder = require_(join(dist, "db", "repository.js")) as Seeder;
  const db = client.createDb(client.createPool());
  const environment = await seeder.createEnvironment(db, {
    name: `public-surface-${randomUUID().slice(0, 8)}`,
  });
  const key = await seeder.createApiKey(db, { environmentId: environment.id });

  const child: ChildProcess = spawn("node", [join(dist, "main.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_OUTBOX_RELAY: "off",
      RELAY_NOTIFICATION_RELAY: "off",
      RELAY_AUTH_KEY_PREFIX: `rlauth-public-${randomUUID().slice(0, 8)}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(`${url}/healthz`);
  return { url, credential: key.credential, stop: () => child.kill() };
}

describe("a channel, a member and a message, all over the public API", () => {
  let api: { url: string; credential: string; stop: () => void };
  let server: Server;
  let wsUrl: string;
  let fanout: Fanout;

  const post = (path: string, body: unknown, auth: string) =>
    fetch(`${api.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    api = await startApi();
    server = serve({
      service: "gateway",
      health: () => ({}),
      logger: silent,
      notFoundDocsUrl: docsUrl("not_found"),
    });
    // THE FAN-OUT IS NOT OPTIONAL FOR DELIVERY, which is easy to miss because a
    // gateway without one still connects, still authenticates and still acks a
    // send. `attachSessions` takes `fanout` as an option, and without it a
    // message reaches the api and stops: the sender gets `message.ack` and every
    // other socket — on this instance or any other — hears nothing. That is how
    // this file first read, and it looked like a membership bug.
    fanout = createFanout({ logger: silent });
    attachSessions({ server, api: createApiClient(api.url), logger: silent, fanout });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await fanout?.close();
    api?.stop();
  });

  /** Collect from construction. `connection.ack` is sent the instant the upgrade
   * completes, and awaiting `open` first loses it — twelve tests in
   * `isolation.itest.ts` timed out learning that. */
  function reader(url: string) {
    const socket = new WebSocket(url);
    const frames: { type: string; payload?: { text?: string } }[] = [];
    socket.on("message", (raw) =>
      frames.push(JSON.parse(raw.toString()) as { type: string; payload?: { text?: string } }),
    );
    socket.on("error", () => undefined);
    const opened = new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("close", (code) => reject(new Error(`closed ${code}`)));
      setTimeout(() => reject(new Error("socket never opened")), 10_000);
    });
    const waitForText = async (text: string, ms = 10_000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        if (frames.some((f) => f.type === "message.created" && f.payload?.text === text)) return;
        if (Date.now() > deadline) {
          throw new Error(`never saw "${text}"; frames were ${frames.map((f) => f.type).join(", ")}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    return { socket, frames, opened, waitForText };
  }

  /** A channel and two members, all over public HTTP. Returns the channel id. */
  async function seedOverTheWire(label: string, users: string[]): Promise<string> {
    const created = await post(
      "/v1/channels",
      { external_id: `${label}-${randomUUID().slice(0, 8)}`, type: "public" },
      api.credential,
    );
    expect(created.status).toBe(201);
    const channelId = ((await created.json()) as { id: string }).id;
    const members = await post(
      `/v1/channels/${channelId}/members`,
      { user_ids: users },
      api.credential,
    );
    expect(members.status).toBe(200);
    const body = (await members.json()) as { members: { status: string }[] };
    expect(body.members.every((m) => m.status === "added")).toBe(true);
    return channelId;
  }

  const mint = async (user: string): Promise<string> => {
    // 200, not 201: minting a token creates nothing that has a URL.
    const res = await post("/auth/dev-token", { user, ttl_seconds: 3600 }, api.credential);
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  };

  it("delivers a message between two members added over the wire", async () => {
    const channelId = await seedOverTheWire("live", ["tuan", "mai"]);

    const tuan = reader(`${wsUrl}/v1/ws?token=${await mint("tuan")}`);
    const mai = reader(`${wsUrl}/v1/ws?token=${await mint("mai")}`);
    await Promise.all([tuan.opened, mai.opened]);

    const text = `over the wire ${randomUUID().slice(0, 8)}`;
    tuan.socket.send(
      JSON.stringify({
        type: "message.send",
        payload: { idem_key: randomUUID(), channel: channelId, text },
      }),
    );

    // Mai hears it, and the ONLY reason she is in this channel is the
    // `POST /v1/channels/:id/members` call above. No repository, no fixture.
    await mai.waitForText(text);
    tuan.socket.close();
    mai.socket.close();
  }, 60_000);

  // A MESSAGE SENT OVER THE PUBLIC REST API CANNOT REACH A SOCKET AT ALL, and
  // that is the platform's behaviour rather than this test's shortcoming. Pinned
  // here because chapter 3.14's exit criterion is that an outsider integrates on
  // the documentation alone, and this is the sentence that documentation has to
  // contain.
  //
  // Two independent mechanisms stop it, and each one is enough on its own:
  //
  //   1. NOTHING IN THE API PUBLISHES TO THE FAN-OUT. `session.ts` publishes when
  //      a SOCKET sends; the api's send path writes the row and the outbox and
  //      stops. The event consumer's handler is `createRecorder` — it records, it
  //      does not deliver. So there is no live push.
  //   2. AN UNATTRIBUTED ROW IS NOT A FRAME. `POST /v1/channels/:id/messages`
  //      never passes a user — the public controller calls
  //      `messages.send(channelId, body)` with no `userId`, so every row it writes
  //      has `user_id` NULL. `backfill.controller.ts`'s `toFrame` drops those on
  //      purpose and says why: `messageSchema` requires `user`, and there is no
  //      truthful value to invent. So resume does not carry it either.
  //
  // The route that works is the socket, and the test above proves it. An
  // integrating developer who sends over REST and waits on a socket waits for
  // ever — so the guide has to say "send over the socket", not "send a message".
  //
  // FIXING IT IS A PRODUCT DECISION AND NOT THIS CHAPTER'S. Attributing a public
  // send to an end-user token would change what `user` means on the wire for every
  // existing caller (FR-MSG-13's territory), and a live fan-out from the api is a
  // new coupling between the api and Redis. Both are named in the chapter.
  it("does NOT deliver a REST-sent message, live or on resume", async () => {
    const channelId = await seedOverTheWire("rest", ["tuan"]);
    const token = await mint("tuan");

    const live = reader(`${wsUrl}/v1/ws?token=${token}`);
    await live.opened;

    const first = `first over rest ${randomUUID().slice(0, 8)}`;
    const second = `second over rest ${randomUUID().slice(0, 8)}`;
    for (const text of [first, second]) {
      const sent = await post(`/v1/channels/${channelId}/messages`, { text }, api.credential);
      expect(sent.status).toBe(201);
    }

    // Both rows exist and both are unattributed — this is the row shape the drop
    // is about, asserted rather than assumed.
    const history = (await (
      await fetch(`${api.url}/v1/channels/${channelId}/messages?limit=10`, {
        headers: { authorization: `Bearer ${api.credential}` },
      })
    ).json()) as { messages: { seq: number; user: string | null; text: string }[] };
    expect(history.messages.map((m) => m.text)).toEqual([second, first]);
    expect(history.messages.every((m) => m.user === null)).toBe(true);

    // No live delivery.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(live.frames.filter((f) => f.type === "message.created")).toEqual([]);
    live.socket.close();

    // And none on resume either. The cursor IS accepted — `resume_ok` is true and
    // the channel is in the echoed cursor — so this is not a rejected resume
    // dressed as an empty one. The page came back and every row in it was
    // dropped for having no sender.
    const resumed = reader(`${wsUrl}/v1/ws?token=${token}&cursor=${channelId}:1`);
    await resumed.opened;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const ack = resumed.frames.find((f) => f.type === "connection.ack") as
      | { payload: { cursor: Record<string, number>; resume_ok: boolean } }
      | undefined;
    expect(ack?.payload.resume_ok).toBe(true);
    expect(Object.keys(ack?.payload.cursor ?? {})).toContain(channelId);
    expect(resumed.frames.filter((f) => f.type === "message.created")).toEqual([]);
    resumed.socket.close();
  }, 60_000);
});
