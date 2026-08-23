import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { createLogger, serve, type Logger } from "@relay/service-kit";
import { Redis } from "ioredis";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// THE LANE'S PORT MAP, and it is a map because two files drawing from one range
// is the same fault as two files sharing a fixed port (chapter 3.12, T077):
//
//   4100-4300  gateway/limits.itest.ts          api
//   4310-4370  dispatcher/dispatcher.itest.ts   api
//   4400-4600  gateway/session.itest.ts         api
//   4610-4670  gateway/meter.itest.ts           gateway
//   4710-4770  gateway/meter.itest.ts           api
//   4900-5100  gateway/isolation.itest.ts       api (TWO children, see below)
//   5200-5400  gateway/public-surface.itest.ts  api

import { createApiClient } from "./api-client.js";
import { createGatewayLimits, type GatewayLimits } from "./limits.js";
import { attachSessions } from "./session.js";

// The claim no single-process test can make (chapter 3.8): that the api and the
// gateway increment ONE counter.
//
// Everything else about the limits is provable cheaper. The arithmetic is pure
// and unit-tested; the socket's two refusals are unit-tested with a stub
// counter; the api's headers are covered by its own integration suite. What
// none of those can show is the property the whole design rests on — a socket
// send and a REST send spend the same budget, because the budget lives in Redis
// and neither process can see the other's memory. A test that stubs the store
// would pass with two separate counters.
//
//   docker compose up -d --wait postgres redis
//   pnpm build
//   RELAY_POSTGRES_PORT=… RELAY_REDIS_PORT=… \
//     pnpm --filter @relay/gateway test:integration
//
// The api runs as a CHILD PROCESS for the reason session.itest.ts gives: the
// gateway is not allowed to know how the api is built (ADR-05), and importing
// it would make that dependency real in order to deny it.

const silent: Logger = createLogger("gateway", () => {});
const REDIS_URL = `redis://localhost:${process.env.RELAY_REDIS_PORT ?? "6379"}`;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);

interface Seeded {
  environmentId: string;
  credential: string;
  channelId: string;
}

interface ApiUnderTest extends Seeded {
  url: string;
  /** Configure this environment's policy. Plain SQL through the api's pool: the
   * columns are three nullable integers and there is no admin API for them yet,
   * so inventing one for a test would be inventing product. */
  setLimits: (limits: {
    rest?: number | null;
    send?: number | null;
    connect?: number | null;
  }) => Promise<void>;
  stop: () => void;
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
    createPool: () => Pool;
  };
  const seeder = require_(join(dist, "db", "repository.js")) as {
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
      ) => Promise<{ id: string }>;
      addMember: (channelId: string, userId: string) => Promise<boolean>;
    };
  };
  const pool = client.createPool();
  const db = client.createDb(pool);

  const environment = await seeder.createEnvironment(db, {
    name: `limits-itest-${randomUUID().slice(0, 8)}`,
  });
  const repo = new seeder.Repository(db, environment.id);
  const user = await repo.createUser("tuan", "Tuan");
  const channel = await repo.createChannel("fleet", "public");
  await repo.addMember(channel.id, user.id);
  const key = await seeder.createApiKey(db, { environmentId: environment.id });

  // A RANDOM HIGH PORT, and this file is the last one in the lane to get one
  // (chapter 3.12, FR-041). It bound a fixed 4124, which is the fault
  // `session.itest.ts` documents at length and had to learn twice: a previous
  // run's child can still hold the port, the new child exits on EADDRINUSE, the
  // health check gets a 200 from the OLD api — a different environment and a
  // different signing secret — and every token this run minted is refused by a
  // service that has never heard of it. Three unrelated-looking assertions, one
  // fixture, and green until the day it is not.
  //
  // 4100-4300 here. The whole map is at the top of this file, because a range
  // that only says what it avoids goes stale the next time a file is added.
  const port = Number(
    process.env.RELAY_LIMITS_ITEST_API_PORT ??
      4100 + Math.floor(Math.random() * 200),
  );
  const child: ChildProcess = spawn("node", [join(dist, "main.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_OUTBOX_RELAY: "off",
      // Chapter 3.8: nor the notification relay, for the same reason.
      RELAY_NOTIFICATION_RELAY: "off",
      RELAY_REDIS_URL: REDIS_URL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(`${url}/healthz`);

  return {
    url,
    environmentId: environment.id,
    credential: key.credential,
    channelId: channel.id,
    setLimits: async ({ rest = null, send = null, connect = null }) => {
      await pool.query(
        "UPDATE environments SET rest_limit_per_minute = $2, " +
          "send_limit_per_minute = $3, connect_limit_per_minute = $4 " +
          "WHERE id = $1",
        [environment.id, rest, send, connect],
      );
    },
    stop: () => {
      child.kill();
      void pool.end();
    },
  };
}

interface Pool {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  end: () => Promise<void>;
}

function firstFrame(socket: WebSocket, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type: string };
      if (frame.type === type) resolve(frame);
    });
    socket.on("close", (code) => reject(new Error(`closed ${code}`)));
    setTimeout(() => reject(new Error(`no ${type} within 5s`)), 5_000);
  });
}

describe("one counter, two services (chapter 3.8)", () => {
  let api: ApiUnderTest;
  let server: Server;
  let limits: GatewayLimits;
  let redis: Redis;
  let url: string;
  const sockets: WebSocket[] = [];

  /** The key the api and the gateway are both supposed to be incrementing.
   * Spelled out here rather than imported, because a test that computed it with
   * the code under test would agree with a wrong answer. */
  const key = (operation: string) =>
    `rl:${api.environmentId}:${operation}:` +
    `${Math.floor(Date.now() / 60_000) * 60_000}`;

  const count = async (operation: string): Promise<number> =>
    Number((await redis.get(key(operation))) ?? 0);

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

  const connect = async (token: string) => {
    const socket = new WebSocket(`${url}/v1/ws?token=${token}`);
    sockets.push(socket);
    await firstFrame(socket, "connection.ack");
    return socket;
  };

  const frameSend = async (socket: WebSocket, text: string) => {
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: { channel: api.channelId, text, idem_key: randomUUID() },
      }),
    );
  };

  const restSend = (text: string) =>
    fetch(`${api.url}/v1/channels/${api.channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.credential}`,
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ text }),
    });

  beforeAll(async () => {
    api = await startApi();
    limits = createGatewayLimits(REDIS_URL);
    redis = new Redis(REDIS_URL);
    server = serve({ service: "gateway", health: () => ({}), logger: silent });
    attachSessions({
      server,
      api: createApiClient(api.url),
      logger: silent,
      limits,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    // Every test starts from an empty bucket and the documented defaults.
    // Otherwise the first test's traffic is the second test's head start, and
    // the window is a minute long.
    await redis.del(key("rest"), key("send"), key("connect"));
    await api.setLimits({});
  });

  afterAll(async () => {
    server.close();
    await limits.close();
    redis.disconnect();
    api.stop();
  });

  it("counts a socket send ONCE, against the api's own key (FR-RTL-01)", async () => {
    // Not twice — the gateway's internal call to `/v1/... ` is exempt (FR-WHK-05),
    // so the frame is counted by the gateway and not again when its HTTP hop
    // lands. And not zero times, which is what an exemption applied one layer
    // too broadly would produce.
    const socket = await connect(await mintToken());
    const before = await count("send");
    await frameSend(socket, "one");
    await firstFrame(socket, "message.ack");
    expect(await count("send")).toBe(before + 1);
  });

  it("spends ONE budget across both transports (FR-RTL-01, research R11)", async () => {
    // Five over REST and five over the socket. If the two services were
    // counting separately this would read 5 and 5.
    const socket = await connect(await mintToken());
    for (let i = 0; i < 5; i += 1) {
      const res = await restSend(`rest-${i}`);
      expect(res.status).toBe(201);
    }
    for (let i = 0; i < 5; i += 1) {
      await frameSend(socket, `frame-${i}`);
      await firstFrame(socket, "message.ack");
    }
    expect(await count("send")).toBe(10);
    // The REQUEST budget saw only the five REST calls: a frame is not an HTTP
    // request, and the gateway's hop to the api does not count as one either.
    // This is the asymmetry FR-RTL-01 was rewritten to force into view — on one
    // transport alone, the two counters move together and a limiter counting
    // requests is indistinguishable from one counting messages.
    expect(await count("rest")).toBe(5);
  });

  it("reports the budget with FEWER remaining, not the one that was asked about", async () => {
    // Two budgets, one set of headers. A client that saw only the request
    // budget would be told it had 595 left while the send budget it is actually
    // spending had 590 — an answer that is true and useless.
    await api.setLimits({ rest: 100, send: 20 });
    const socket = await connect(await mintToken());
    for (let i = 0; i < 5; i += 1) {
      await frameSend(socket, `frame-${i}`);
      await firstFrame(socket, "message.ack");
    }
    const res = await restSend("rest-after-frames");
    expect(res.status).toBe(201);
    // send: 5 frames + this one = 6 of 20, so 14 left. rest: 1 of 100, 99 left.
    expect(res.headers.get("x-ratelimit-limit")).toBe("20");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("14");
  });

  it("names the limit that was reached when it refuses (FR-RTL-01)", async () => {
    await api.setLimits({ rest: 100, send: 2 });
    await restSend("one");
    await restSend("two");
    const refused = await restSend("three");
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { code: string; message: string };
    expect(body.code).toBe("rate_limited");
    // "you are rate limited" leaves a developer guessing which dial to turn.
    // The wording names the UNIT rather than the column: "too many messages"
    // says slow down, "too many requests" says batch. This traffic was three
    // sends against a send limit of two, so it has to be the first.
    expect(body.message).toMatch(/too many messages/);
    expect(body.message).not.toMatch(/too many requests/);
  });

  it("lets the gateway through an environment that is at its REST limit (FR-WHK-05)", async () => {
    // The exemption cannot key off the principal: the gateway forwards the END
    // USER's token, so its session and send calls resolve to `kind: "user"`
    // exactly like customer traffic. A rule that exempted only the platform
    // credential would refuse them — and the socket would go down for a REST
    // budget it never spends (research R17).
    await api.setLimits({ rest: 1 });
    expect((await restSend("the one allowed request")).status).toBe(201);
    expect((await restSend("over")).status).toBe(429);

    // The environment is over its REST limit. The socket still opens…
    const socket = await connect(await mintToken());
    // …and still sends, because a frame spends the SEND budget and the
    // gateway's hop to the api spends nothing.
    await frameSend(socket, "through the closed door");
    expect(await firstFrame(socket, "message.ack")).toMatchObject({
      type: "message.ack",
    });
  });
});
