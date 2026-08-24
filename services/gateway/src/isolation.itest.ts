import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createLogger, serve, type Logger } from "@relay/service-kit";
import { frameSchema, docsUrl } from "@relay/protocol";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApiClient } from "./api-client.js";
import { attachSessions } from "./session.js";
import { seedSocketTenants, type SocketTenants } from "./isolation-fixtures.js";

// THE SOCKET HALF OF THE GAUNTLET (FR-007, NFR-SEC-09, constitution I).
//
// `services/api/src/isolation/gauntlet.itest.ts` attacks every HTTP route. None
// of it reaches the socket: a WebSocket is not in `router.stack`, so the derived
// target list cannot see it and this file is the only place the four socket
// verbs — session, send, resume, subscribe — get attacked with another tenant's
// identifiers.
//
// The arrangement is chapter 3.2's and 3.11 kept it for the same reason: the
// gateway runs IN PROCESS and the api as a CHILD. In process, because a test that
// cannot reach the gateway's own state cannot check what it subscribed to; as a
// child, because importing the api would make this service depend on the api's
// framework to test itself, and not knowing how the api is built is the whole of
// ADR-05.

const silent: Logger = createLogger("gateway", () => {});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/** 120 SECONDS, NOT 30, and the number is measured (chapter 3.15's Phase 1).
 *
 * This suite spawns an api child and waits for its health endpoint. Thirty seconds is
 * ample in the integration lane, where the whole suite finishes in **6 s**. Under
 * `pnpm coverage` the same suite takes **90.9 s** — v8 instrumentation on a NestJS boot
 * is most of that — and the child blew the 30 s deadline every run: one failed suite,
 * six tests skipped, and an `afterAll` that then timed out at 60 s waiting on a
 * half-started server.
 *
 * A generous deadline costs nothing when the api is healthy: the loop polls every 100 ms
 * and returns on the first success. It only changes how long a genuinely dead api takes
 * to say so.
 *
 * Chapter 3.12's battery blew this same 30 s at run 11 for an unrelated reason — two
 * Next.js dev servers compiling an MDX page while the child had 30 s to boot. Both
 * failures were the deadline being tight rather than the api being broken. */
async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 120_000;
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

/** A RANDOM HIGH PORT, for the reason `session.itest.ts` records at length: a
 * fixed port races the sibling file that also binds one, and a previous run's
 * child still holding it makes `waitForHealth` succeed against an api serving a
 * DIFFERENT environment — every token this run minted then gets refused by a
 * service that has never heard of it. Three unrelated-looking assertions, one
 * fixture. Its range is 4400-4600 and `limits.itest.ts` holds 4124, so this
 * takes 4900-5100 — see the port map at the top of `limits.itest.ts`. The first
 * draft took 4600-4800, which OVERLAPPED `meter.itest.ts`'s two ranges (4610-4670
 * and 4710-4770); T077's audit is what found that, and a range chosen by looking
 * at one neighbour instead of at all of them is how it happened.
 *
 * `+ children` rather than a second random draw: this file starts TWO api
 * children, and two draws from one range can collide with each other — a 1-in-200
 * failure that would read as a broken gateway rather than a broken fixture, which
 * is the exact trap the fixed port was. */
let children = 0;
async function startApi(): Promise<{ url: string; stop: () => void }> {
  const port = 4900 + ((Math.floor(Math.random() * 100) * 2 + children++) % 200);
  const dist = join(REPO, "services", "api", "dist");
  if (!existsSync(join(dist, "main.js"))) {
    throw new Error(
      "the api is not built — run `pnpm build` before this lane " +
        "(the suite talks to the real service, not a stub)",
    );
  }
  const child: ChildProcess = spawn("node", [join(dist, "main.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      // Neither relay: this suite asserts on rows and on frames, and a
      // background loop draining the tables another file is asserting on turns
      // two unrelated suites into a race (chapters 3.3 and 3.8).
      RELAY_OUTBOX_RELAY: "off",
      RELAY_NOTIFICATION_RELAY: "off",
      // Its own failed-authentication keyspace. Chapter 3.8's auth limiter counts
      // failures per source address, every suite in this lane is 127.0.0.1, and
      // vitest runs the files in parallel — so a neighbour's expected 401 becomes
      // this file's 429.
      RELAY_AUTH_KEY_PREFIX: `rlauth-iso-${randomUUID().slice(0, 8)}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(`${url}/healthz`);
  return { url, stop: () => child.kill() };
}

/** A SOCKET WITH A BUFFER, and the buffer is the point.
 *
 * The obvious shape — await `open`, then attach a `message` listener, then read —
 * loses the handshake. `connection.ack` is sent the moment the upgrade completes,
 * and awaiting `open` yields to the event loop first: the frame arrives with no
 * listener attached and is gone. Every test in this file that waited for a second
 * frame timed out at exactly 5000ms until the listener moved to construction time.
 *
 * So frames are collected from the instant the socket exists, and `waitFor` reads
 * the buffer before it waits. */
interface Reader {
  socket: WebSocket;
  waitFor: <T = Record<string, unknown>>(type: string, timeoutMs?: number) => Promise<T>;
  frames: () => { type: string }[];
  opened: () => Promise<void>;
}

function read(socket: WebSocket): Reader {
  const buffer: { type: string }[] = [];
  let closed: number | null = null;
  socket.on("message", (raw) => buffer.push(JSON.parse(raw.toString()) as { type: string }));
  socket.on("close", (code) => {
    closed = code;
  });
  socket.on("error", () => undefined);

  const opened = () =>
    new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) return resolve();
      socket.on("open", () => resolve());
      socket.on("close", (code) => reject(new Error(`closed ${code} before opening`)));
      setTimeout(() => reject(new Error("socket never opened")), 5_000);
    });

  const waitFor = async <T>(type: string, timeoutMs = 5_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = buffer.find((f) => f.type === type);
      if (found) return found as T;
      if (closed !== null) throw new Error(`closed ${closed} before a ${type} arrived`);
      if (Date.now() > deadline) {
        throw new Error(
          `no ${type} within ${timeoutMs}ms — saw ${buffer.map((f) => f.type).join(", ") || "nothing"}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  return { socket, waitFor, frames: () => [...buffer], opened };
}

/** Absence needs a deadline rather than a race, so three of the four attacks below
 * wait a fixed window and then read what the buffer holds. */
async function quiet(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the socket gauntlet", () => {
  let api: { url: string; stop: () => void };
  let server: Server;
  let wsUrl: string;
  let tenants: SocketTenants;
  const sockets: WebSocket[] = [];

  const connect = (token: string, query = ""): Reader => {
    const socket = new WebSocket(`${wsUrl}/v1/ws?token=${token}${query}`);
    sockets.push(socket);
    return read(socket);
  };

  beforeAll(async () => {
    api = await startApi();
    tenants = await seedSocketTenants(api.url);
    server = serve({
      service: "gateway",
      health: () => ({}),
      logger: silent,
      notFoundDocsUrl: docsUrl("not_found"),
    });
    attachSessions({ server, api: createApiClient(api.url), logger: silent });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 90_000);

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    api?.stop();
  });

  // ── THE CONTROL, for the reason the HTTP gauntlet needed one ────────────────
  //
  // Three of the four attacks below assert that NOTHING happened. A socket that
  // is broken, a token that is expired, a gateway that delivers to nobody — all
  // of those also make nothing happen, and would pass this file while attacking
  // nothing. So the attacker's socket is shown to work first.
  describe("the control: the attacker's own socket works", () => {
    it("connects and is acknowledged", async () => {
      const ack = await connect(tenants.attacker.token).waitFor<{ payload: { user: string } }>(
        "connection.ack",
      );
      expect(ack.payload.user).toBe(tenants.attacker.userExternalId);
    });

    it("sends into its own channel and is acked", async () => {
      const client = connect(tenants.attacker.token);
      await client.waitFor("connection.ack");
      client.socket.send(
        JSON.stringify({
          type: "message.send",
          payload: {
            idem_key: randomUUID(),
            channel: tenants.attacker.channelId,
            text: "the control writes",
          },
        }),
      );
      const ack = await client.waitFor<{ payload: { seq: number } }>("message.ack");
      expect(ack.payload.seq).toBeGreaterThan(0);
    });
  });

  // ── T045: the session ──────────────────────────────────────────────────────
  it("the session it is given names none of the other tenant's channels", async () => {
    // `channel_ids` is the API's `/internal/session` response, not a field of
    // `connection.ack` — the ack carries user, cursor, resume_ok and truncated.
    // The gateway reads that response at connect (`auth.ts`) and it becomes the
    // subscription set, so this is where a leak would start.
    const res = await fetch(`${api.url}/internal/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${tenants.attacker.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(tenants.attacker.channelId);
    expect(body).not.toContain(tenants.victim.channelId);
  });

  // ── T046: the send ─────────────────────────────────────────────────────────
  it("a send into the other tenant's channel is refused, and that channel gains nothing", async () => {
    const before = await tenants.victim.history();
    const client = connect(tenants.attacker.token);
    await client.waitFor("connection.ack");
    const text = `not mine ${randomUUID()}`;
    client.socket.send(
      JSON.stringify({
        type: "message.send",
        payload: { idem_key: randomUUID(), channel: tenants.victim.channelId, text },
      }),
    );
    const error = await client.waitFor<{ payload: { code: string } }>("error");
    expect(error.payload.code).toBeTruthy();
    // READ THE VICTIM'S STATE, do not infer it from the refusal. A refusal that
    // wrote the row anyway is the failure this assertion exists for.
    const after = await tenants.victim.history();
    expect(after).not.toContain(text);
    expect(after).toBe(before);
  });

  // ── THE SOCKET'S SEND INTO A PRIVATE CHANNEL OF ITS OWN TENANT ─────────────
  //
  // Chapter 3.15, FR-001. Every attack above crosses a tenant boundary; this one
  // does not. The attacker's own tenant holds a private channel they are not a
  // member of, and the socket reaches the same `repository.sendMessage` the REST
  // route does — through `api-client` to `POST /internal/messages`, which has
  // always supplied the user id.
  //
  // THE SAME ANSWER AS A CHANNEL THAT DOES NOT EXIST, on this surface too. A
  // socket error frame carries a code rather than a status, so the comparison is
  // between two frames: the refusal for a private channel the caller cannot see
  // and the refusal for an id that exists nowhere.
  it("a send into its own tenant's private channel is refused as if absent, and that channel gains nothing", async () => {
    const client = connect(tenants.attacker.token);
    await client.waitFor("connection.ack");

    const text = `not a member ${randomUUID()}`;
    client.socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: tenants.attacker.privateChannelId,
          text,
        },
      }),
    );
    const refused = await client.waitFor<{ payload: { code: string } }>("error");

    client.socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: "00000000-0000-4000-8000-000000000000",
          text: `nowhere ${randomUUID()}`,
        },
      }),
    );
    const absent = await client.waitFor<{ payload: { code: string } }>("error");

    expect(refused.payload.code).toBe(absent.payload.code);

    // And read the channel's state rather than inferring it from the refusal.
    const after = await tenants.attacker.privateHistory();
    expect(after).not.toContain(text);
  });

  // ── T047: the resume ───────────────────────────────────────────────────────
  it("a cursor naming the other tenant's channel backfills nothing", async () => {
    await tenants.victim.say(`before the resume ${randomUUID()}`);
    const client = connect(tenants.attacker.token, `&cursor=${tenants.victim.channelId}:1`);
    const ack = await client.waitFor<{
      payload: { cursor: Record<string, number>; resume_ok: boolean };
    }>("connection.ack");
    // The ack echoes what the server ACCEPTED. A channel this token cannot see is
    // not in it, whatever the client presented.
    expect(Object.keys(ack.payload.cursor)).not.toContain(tenants.victim.channelId);
    await quiet(1_000);
    expect(client.frames().filter((f) => f.type === "message.created")).toEqual([]);
  });

  // ── T048: the subscribe ────────────────────────────────────────────────────
  it("nothing from the other tenant's channel is delivered", async () => {
    const client = connect(tenants.attacker.token);
    await client.waitFor("connection.ack");
    await tenants.victim.say(`the victim speaks ${randomUUID()}`);
    await quiet(1_500);
    expect(client.frames().filter((f) => f.type === "message.created")).toEqual([]);
  });
});

// ── T049, T050: the ten frames, classified ───────────────────────────────────
//
// THE MEMBER LIST IS DERIVED; THE DIRECTION IS NOT. `frameSchema.options` yields
// all ten discriminator values at runtime, so a frame added to the union appears
// here without an edit and fails the totality check until somebody classifies it
// — the same property `targets.itest.ts` gives the route list.
//
// The DIRECTION cannot be derived, and an earlier draft of this task and of
// `contracts/gauntlet.md` §4 both said it could. The union carries no direction
// metadata: no inbound/outbound split, no client/server marker, nothing but the
// discriminator. So each entry below is a classification with a reason, and the
// authority for every one of them is `session.ts`, which refuses anything that is
// not `message.send` with `unknown_frame_type` and close 4002.
const DIRECTIONS: ReadonlyArray<readonly [string, "inbound" | "outbound", string]> = [
  ["message.send", "inbound", "the only frame a client may utter (session.ts)"],
  ["connection.ack", "outbound", "the server's answer to the handshake"],
  ["message.ack", "outbound", "the server's answer to a send, after commit"],
  ["message.created", "outbound", "a real-time event; the server decides who hears it"],
  ["message.updated", "outbound", "as message.created"],
  ["message.deleted", "outbound", "as message.created"],
  ["membership.changed", "outbound", "membership is written through the api, never the socket"],
  ["presence.changed", "outbound", "derived from connections the gateway holds, not claimed"],
  ["typing", "outbound", "server-fanned; a client claiming one could type as anybody"],
  ["error", "outbound", "the server's refusal shape"],
];

/** Something schema-valid for each type, so a refusal is `unknown_frame_type`
 * rather than `invalid_frame` — the two are different findings and only one of
 * them is about direction. */
function sample(type: string, channel: string, user: string): unknown {
  const message = {
    id: randomUUID(),
    channel,
    seq: 1,
    user,
    text: "forged",
    created_at: new Date().toISOString(),
  };
  switch (type) {
    case "connection.ack":
      return { type, payload: { user, cursor: {}, resume_ok: true, truncated: [] } };
    case "message.ack":
      return { type, payload: { seq: 1 } };
    case "message.created":
    case "message.updated":
    case "message.deleted":
      return { type, payload: message };
    case "membership.changed":
      return { type, payload: { channel, user, change: "added" } };
    case "presence.changed":
      return { type, payload: { user, state: "online" } };
    case "typing":
      return { type, payload: { channel, user } };
    case "error":
      return {
        type,
        payload: { code: "forged", message: "forged", docs_url: "/x", request_id: "x" },
      };
    default:
      return { type, payload: { idem_key: randomUUID(), channel, text: "forged" } };
  }
}

describe("every frame in the union is classified, in both directions", () => {
  const members = frameSchema.options.map(
    (option) => (option.shape.type as { value: string }).value,
  );

  it("derives all ten members from the union itself", () => {
    expect(members.length).toBe(10);
  });

  it("classifies every member exactly once", () => {
    const classified = DIRECTIONS.map(([type]) => type);
    const missing = members.filter((m) => !classified.includes(m));
    expect(
      missing,
      `these frames are in frameSchema and classified nowhere: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("names no frame the union does not have", () => {
    const stale = DIRECTIONS.map(([type]) => type).filter((t) => !members.includes(t));
    expect(stale, `classified but no longer in frameSchema: ${stale.join(", ")}`).toEqual([]);
  });

  it("agrees with the gateway: exactly one member is inbound", () => {
    const inbound = DIRECTIONS.filter(([, d]) => d === "inbound").map(([t]) => t);
    // Not a taste assertion. `session.ts` compares against this one literal and
    // closes 4002 on everything else, so a second inbound frame here would be a
    // classification the code does not implement.
    expect(inbound).toEqual(["message.send"]);
  });
});

// The behavioural half: the classification above is checked against the running
// gateway rather than believed. Nine sockets, one per outbound frame, because the
// refusal closes the connection.
describe("a client uttering a server frame is refused, frame by frame", () => {
  let api: { url: string; stop: () => void };
  let server: Server;
  let wsUrl: string;
  let tenants: SocketTenants;

  beforeAll(async () => {
    api = await startApi();
    tenants = await seedSocketTenants(api.url);
    server = serve({
      service: "gateway",
      health: () => ({}),
      logger: silent,
      notFoundDocsUrl: docsUrl("not_found"),
    });
    attachSessions({ server, api: createApiClient(api.url), logger: silent });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    api?.stop();
  });

  for (const [type, direction] of DIRECTIONS.filter(([, d]) => d === "outbound")) {
    it(`${type} (${direction}) is refused with unknown_frame_type`, async () => {
      const client = read(new WebSocket(`${wsUrl}/v1/ws?token=${tenants.attacker.token}`));
      await client.opened();
      await client.waitFor("connection.ack");
      client.socket.send(
        JSON.stringify(
          sample(type, tenants.attacker.channelId, tenants.attacker.userExternalId),
        ),
      );
      const error = await client.waitFor<{ payload: { code: string } }>("error");
      expect(error.payload.code).toBe("unknown_frame_type");
      client.socket.close();
    });
  }
});
