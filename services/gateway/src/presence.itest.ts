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
  const channel = await repo.createChannel("fleet", "public");
  await repo.addMember(channel.id, watcher.id);
  await repo.addMember(channel.id, subject.id);
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
  return { url, credential: key.credential, stop: () => child.kill() };
}

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

describe("presence: a member sees a co-member arrive (FR-RTM-05, FR-RTM-06)", () => {
  let api: ApiUnderTest;
  let server: Server;
  let fanout: Fanout;
  let url: string;
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
    fanout = createFanout({ logger: silent });
    server = serve({
      service: "gateway",
      health: () => ({}),
      logger: silent,
      notFoundDocsUrl: docsUrl("not_found"),
    });
    attachSessions({
      server,
      api: createApiClient(api.url),
      logger: silent,
      fanout,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await fanout?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    api?.stop();
  });

  it("delivers presence.changed online to a connected co-member", async () => {
    const watcher = connect(await mintToken("linh"));
    await waitForFrame(watcher, "connection.ack");

    const subject = connect(await mintToken("tuan"));
    await waitForFrame(subject, "connection.ack");

    const frame = (await waitForFrame(watcher, "presence.changed")) as {
      payload: { user: string; state: string };
    };
    expect(frame.payload).toEqual({ user: "tuan", state: "online" });
  }, 30_000);
});
