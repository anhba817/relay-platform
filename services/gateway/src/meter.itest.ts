import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// What a signal does to a bill (chapter 3.11, US2).
//
// EVERY OTHER TEST IN THIS CHAPTER RUNS THE GATEWAY IN-PROCESS, and that is the
// right default: `attachSessions` takes its interval as a parameter, so the
// timing assertions drive a clock instead of waiting on one. Two tests cannot.
// A signal is the one thing an in-process gateway cannot receive, and what
// SIGKILL and SIGTERM do to an open connection's minutes is the difference
// between a bounded under-count and an unbounded one.
//
// So this file spawns TWO children — an api and a gateway — and points the
// second at the first. `session.itest.ts` and `limits.itest.ts` already spawn
// the api and run the gateway in-process; this copies their shape and adds the
// half they did not need.

const require_ = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const PLATFORM = "rk_svc_meter_itest_0123456789abcdef012345";
const METER_INTERVAL_MS = 300;

interface Seeder {
  createEnvironment: (db: unknown, input: { name: string }) => Promise<{ id: string }>;
  createApiKey: (db: unknown, input: { environmentId: string }) => Promise<{ credential: string }>;
  usageFor: (
    db: unknown,
    environmentId: string,
    period: string,
  ) => Promise<{ connectionMinutes: number }>;
}

async function waitForHealth(url: string, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${what} never became healthy`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("a signal, and what it does to a bill", () => {
  let api: ChildProcess;
  let gateway: ChildProcess;
  let apiUrl: string;
  let db: unknown;
  let seeder: Seeder;
  let environmentId: string;
  let token: string;
  const period = `${new Date().toISOString().slice(0, 7)}-01`;

  const gatewayPort = 4610 + Math.floor(Math.random() * 60);
  const apiPort = 4710 + Math.floor(Math.random() * 60);

  beforeAll(async () => {
    const apiDist = join(REPO, "services", "api", "dist");
    const gatewayDist = join(REPO, "services", "gateway", "dist");
    for (const [dist, what] of [
      [apiDist, "api"],
      [gatewayDist, "gateway"],
    ] as const) {
      if (!existsSync(join(dist, "main.js"))) {
        throw new Error(`the ${what} is not built — run \`pnpm build\` first`);
      }
    }

    const client = require_(join(apiDist, "db", "client.js")) as {
      createDb: (pool: unknown) => unknown;
      createPool: () => unknown;
    };
    seeder = require_(join(apiDist, "db", "repository.js")) as Seeder;
    db = client.createDb(client.createPool());
    const env = await seeder.createEnvironment(db, {
      name: `meter-itest-${randomUUID().slice(0, 8)}`,
    });
    environmentId = env.id;
    const key = await seeder.createApiKey(db, { environmentId });

    api = spawn("node", [join(apiDist, "main.js")], {
      env: {
        ...process.env,
        PORT: String(apiPort),
        RELAY_OUTBOX_RELAY: "off",
        RELAY_NOTIFICATION_RELAY: "off",
        RELAY_DELIVERY_RELAY: "off",
        RELAY_QUOTA_RELAY: "off",
        RELAY_EVENT_CONSUMER: "off",
        RELAY_INTERNAL_CREDENTIAL_GATEWAY: PLATFORM,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    api.stdout?.resume();
    api.stderr?.resume();
    apiUrl = `http://127.0.0.1:${apiPort}`;
    await waitForHealth(`${apiUrl}/healthz`, "api");

    token = (
      (await (
        await fetch(`${apiUrl}/auth/dev-token`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key.credential}`,
          },
          body: JSON.stringify({ user: "tuan", ttl_seconds: 3600 }),
        })
      ).json()) as { token: string }
    ).token;

  }, 90_000);

  afterAll(() => {
    gateway?.kill("SIGKILL");
    api?.kill("SIGKILL");
  });

  /** A gateway of its own per test, because each of these tests ends by killing
   * one and the two signals must not share a victim. */
  async function startGateway(
    port: number,
    credential = PLATFORM,
  ): Promise<ChildProcess> {
    const child = spawn(
      "node",
      [join(REPO, "services", "gateway", "dist", "main.js")],
      {
        env: {
          ...process.env,
          PORT: String(port),
          // The gateway child talks to THIS api child, not to whatever else is
          // listening on this machine.
          RELAY_API_URL: apiUrl,
          RELAY_INTERNAL_CREDENTIAL_GATEWAY: credential,
          RELAY_METER_INTERVAL_MS: String(METER_INTERVAL_MS),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.resume();
    child.stderr?.resume();
    await waitForHealth(`http://127.0.0.1:${port}/healthz`, "gateway");
    gateway = child;
    return child;
  }

  const minutes = async () =>
    (await seeder.usageFor(db, environmentId, period)).connectionMinutes;

  async function connect(port: number): Promise<WebSocket> {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/ws?token=${token}`,
    );
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
      setTimeout(() => reject(new Error("no socket within 5s")), 5_000);
    });
    return socket;
  }

  /** Wait until the figure stops changing, so the assertions below are about
   * the design rather than about a race with the reporting interval. */
  async function settle(): Promise<number> {
    let previous = -1;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, METER_INTERVAL_MS));
      const now = await minutes();
      if (now === previous && now > 0) return now;
      previous = now;
    }
    return previous;
  }

  it("SIGKILL: the figure stops where the last report left it (SC-005)", async () => {
    const child = await startGateway(gatewayPort);
    const socket = await connect(gatewayPort);
    const before = await settle();
    expect(before).toBeGreaterThan(0);

    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, METER_INTERVAL_MS * 3));
    const atDeath = await minutes();

    // Bounded: the loss is at most what accrued since the last report, and the
    // unit is a minute, so a sub-minute kill costs nothing at all.
    expect(atDeath).toBeGreaterThanOrEqual(before);

    // AND THIS IS THE ASSERTION THAT MATTERS. Ten intervals later the figure is
    // IDENTICAL — nothing is still billing for a socket nobody holds. The first
    // read only shows the loss is bounded; this one shows there is no phantom.
    await new Promise((r) => setTimeout(r, METER_INTERVAL_MS * 10));
    expect(await minutes()).toBe(atDeath);

    socket.close();
  }, 90_000);

  it("SIGTERM: the connection's minutes are recorded in full (SC-023)", async () => {
    // The case a deploy takes, and the one the gateway had no path for. Until
    // this chapter `serve()` handed back a bare `node:http` Server, nothing
    // called `server.close()`, and no signal handler existed — so the flush that
    // R11, FR-008, `contracts/metering.md` §5 and its own task all described ran
    // on no path at all.
    const port = gatewayPort + 1;
    const child = await startGateway(port);
    const socket = await connect(port);
    const before = await settle();
    expect(before).toBeGreaterThan(0);

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;

    // The socket died with the process, and its last minutes still landed —
    // because the handler awaited the flush rather than firing it.
    const after = await minutes();
    expect(after).toBeGreaterThanOrEqual(before);

    // And nothing accrues afterwards: a graceful stop is still a stop.
    await new Promise((r) => setTimeout(r, METER_INTERVAL_MS * 6));
    expect(await minutes()).toBe(after);

    socket.close();
  }, 90_000);

  it("a report the api refuses breaks nothing a customer can see (SC-019, FR-012)", async () => {
    // A credential the api has never heard of, so EVERY report comes back 401
    // and `reportUsage` throws on every tick. Metering may not close a socket,
    // refuse a connect, or fail a send — this is the whole of FR-012, and the
    // way to test it is to break the reporting and then use the service.
    const port = gatewayPort + 2;
    // Scoped to what this test changes, not to zero. The two tests above have
    // already credited this environment, and an assertion that ignored them
    // would be the shared-resource mistake FR-032 exists to forbid — caught
    // here by writing it and watching it fail.
    const before = await minutes();
    const child = await startGateway(
      port,
      "rk_svc_nobody_knows_this_one_0123456789ab",
    );

    const socket = await connect(port);
    const acked = new Promise<unknown>((resolve, reject) => {
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string };
        if (frame.type === "connection.ack") resolve(frame);
      });
      setTimeout(() => reject(new Error("no ack within 5s")), 5_000);
    });
    expect(await acked).toBeTruthy();

    // Several intervals of failing reports later, the socket is still open and a
    // second one still opens.
    await new Promise((r) => setTimeout(r, METER_INTERVAL_MS * 5));
    expect(socket.readyState).toBe(WebSocket.OPEN);

    const second = await connect(port);
    expect(second.readyState).toBe(WebSocket.OPEN);

    // And the api recorded nothing NEW, because nothing it accepted was ever
    // sent. The failure is total and it is invisible from the outside, which is
    // the trade FR-012 asks for.
    expect(await minutes()).toBe(before);

    socket.close();
    second.close();
    child.kill("SIGKILL");
  }, 90_000);
});
