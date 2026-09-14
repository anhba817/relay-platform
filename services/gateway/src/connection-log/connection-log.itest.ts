import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import { AckPolicy, connect, type NatsConnection } from "nats";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ANALYTICS_STREAM, docsUrl } from "@relay/protocol";
import { createLogger, serve, type Logger } from "@relay/service-kit";

import { createApiClient } from "../api-client.js";
import { startApi, mintToken } from "../isolation-fixtures.js";
import { attachSessions } from "../session.js";
import { createConnectionLog, type ConnectionLog } from "./event.js";
import { createConnectionPublisher } from "./publisher.js";

const require_ = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const NATS_URL = process.env["RELAY_NATS_URL"] ?? "nats://localhost:4222";
const CH = {
  host: process.env["RELAY_CLICKHOUSE_HOST"] ?? "localhost",
  port: process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123",
  auth: "Basic " + Buffer.from("relay:relay").toString("base64"),
};

const silent: Logger = createLogger("gateway", () => {});

async function ch(sql: string): Promise<string> {
  const res = await fetch(`http://${CH.host}:${CH.port}/`, {
    method: "POST",
    headers: { Authorization: CH.auth },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim().split("\n")[0]);
  return text.trim();
}

interface Seeder {
  createEnvironment: (db: unknown, i: { name: string }) => Promise<{ id: string }>;
  createApiKey: (db: unknown, i: { environmentId: string }) => Promise<{ credential: string }>;
}

/** EVERY ASSERTION IN THIS FILE IS SCOPED TO ONE ENVIRONMENT, and the environment is
 *  minted per run. The gateway lane runs four files at a time and `connection_events` is
 *  a shared table in a shared store, which `check-lane-scope.py` cannot see -- its
 *  SHARED list is the lane's Postgres tables and its own last line is "SQL text only".
 *  So the scope is this file's job rather than the sweeper's. */
describe("a connection that opens and closes becomes two records", () => {
  let api: { url: string; stop: () => void };
  let server: ReturnType<typeof serve>;
  let log: ConnectionLog;
  let nc: NatsConnection;
  let url: string;
  let environmentId: string;
  let credential: string;
  const sockets: WebSocket[] = [];

  /** N ACROSS N USERS, NOT N FOR ONE. `MAX_CONNECTIONS_PER_USER = 5` is enforced by
   *  claiming one of five Redis slot keys per user per environment, and the sixth socket
   *  is refused with close 4004 -- on a path that returns BEFORE `open()`, so it produces
   *  no Connection and no record at all. Ten sockets as one user would assert 20 and
   *  measure 10, and the failure would read as ten lost records. */
  const N = 6;

  beforeAll(async () => {
    const dist = join(REPO, "services", "api", "dist");
    const client = require_(join(dist, "db", "client.js")) as {
      createDb: (p: unknown) => unknown;
      createPool: () => unknown;
    };
    const seeder = require_(join(dist, "db", "repository.js")) as Seeder;
    const db = client.createDb(client.createPool());
    const env = await seeder.createEnvironment(db, {
      name: `conn-log-itest-${randomUUID().slice(0, 8)}`,
    });
    environmentId = env.id;
    credential = (await seeder.createApiKey(db, { environmentId })).credential;

    api = await startApi({
      RELAY_AUTH_KEY_PREFIX: `rlauth-connlog-${randomUUID().slice(0, 8)}`,
      RELAY_OUTBOX_RELAY: "off",
      RELAY_EVENT_CONSUMER: "off",
    });

    log = createConnectionLog({
      publisher: createConnectionPublisher({ logger: silent, url: NATS_URL }),
      logger: silent,
      // A TICK LONG ENOUGH NOT TO FIRE. Every flush in this file is explicit, so the
      // assertions read what this test sent rather than what a timer happened to catch.
      intervalMs: 1_000_000,
    });

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
      connectionLog: log,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

    nc = await connect({ servers: NATS_URL });
  }, 120_000);

  afterAll(async () => {
    for (const s of sockets.splice(0)) s.close();
    log?.stop();
    await nc?.drain().catch(() => {});
    server?.close();
    api?.stop();
    // Clean up this run's rows. A probe that writes to a shared store and leaves is the
    // data the next measurement reads as pre-existing.
    if (environmentId) {
      await ch(
        `DELETE FROM relay_analytics.connection_events
          WHERE environment_id = toUUID('${environmentId}')`,
      ).catch(() => {});
    }
  }, 60_000);

  /** Open a socket, wait for the ack, and hand back a promise of its close. */
  async function openAndClose(user: string): Promise<void> {
    const token = await mintToken(api.url, credential, user);
    const socket = new WebSocket(`${url}/v1/ws?token=${token}`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${user} never acked`)), 15_000);
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as { type?: string };
        if (frame.type === "connection.ack") {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.close();
    });
  }

  /** Read this environment's records off the stream, without consuming anybody else's. */
  async function readStream(): Promise<{ opened: number; closed: number }> {
    const jsm = await nc.jetstreamManager();
    const durable = `conn-log-itest-${randomUUID().slice(0, 8)}`;
    await jsm.consumers.add(ANALYTICS_STREAM, {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      // FILTERED TO THIS ENVIRONMENT. The subject carries the tenant, which is what makes
      // a per-run scope expressible at all -- and what makes a mis-addressed subject a
      // tenancy defect rather than a tidiness one.
      filter_subject: `analytics.connection.*.${environmentId}`,
    });
    const consumer = await nc.jetstream().consumers.get(ANALYTICS_STREAM, durable);
    let opened = 0;
    let closed = 0;
    const messages = await consumer.fetch({ max_messages: 500, expires: 3_000 });
    for await (const m of messages) {
      const record = JSON.parse(new TextDecoder().decode(m.data)) as { type: string };
      if (record.type === "connection.opened") opened += 1;
      if (record.type === "connection.closed") closed += 1;
      m.ack();
    }
    await jsm.consumers.delete(ANALYTICS_STREAM, durable);
    return { opened, closed };
  }

  it(`puts 2N records on the stream for N connections, against a non-zero floor`, async () => {
    // Six users, one connection each. A three-way equality at zero is satisfied by
    // nothing at all, so the floor is asserted before the equality.
    for (let i = 0; i < N; i++) await openAndClose(`conn-log-user-${i}`);
    await log.flushOnce();

    const { opened, closed } = await readStream();
    expect(N).toBeGreaterThan(0);
    expect(opened).toBe(N);
    expect(closed).toBe(N);
  }, 120_000);
});
