import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { docsUrl, frameSchema } from "@relay/protocol";
import { createLogger, serve, type Logger } from "@relay/service-kit";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiClient } from "./api-client.js";
import { mintToken, seedSocketTenants, type SocketTenants } from "./isolation-fixtures.js";
import { attachSessions } from "./session.js";

// THE SOCKET HALF OF THE GAUNTLET (FR-007, NFR-SEC-09, constitution I).
//
// The api's gauntlet attacks every HTTP route. None of it reaches here: A WEBSOCKET IS
// NOT IN `router.stack`, so the derived target list cannot see it, and this file is the
// only place the socket gets attacked with another tenant's identifiers.
//
// The list of things to attack is derived here too, from `frameSchema`'s own members
// rather than from a list somebody typed — same argument as the router, one protocol
// down. A frame type added to the union and forgotten here is exactly the case that
// would otherwise ship unattacked.

const silent: Logger = createLogger("gateway", () => {});

/** Every frame type the protocol declares, read off the union.
 *
 * ASSERTED NON-EMPTY BEFORE IT IS USED, for the reason the router derivation records: a
 * shape change in zod that made this return nothing would leave the suite green while
 * it attacked no frames at all. */
function declaredFrameTypes(): string[] {
  const options = (frameSchema as unknown as { options?: unknown[] }).options ?? [];
  const types: string[] = [];
  for (const option of options) {
    const shape = (option as { shape?: { type?: { value?: unknown } } }).shape;
    const value = shape?.type?.value;
    if (typeof value === "string") types.push(value);
  }
  return types;
}

async function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.on("close", (code) => resolve(code));
    socket.on("error", () => undefined);
    setTimeout(() => reject(new Error("no close within 5s")), 5_000);
  });
}

async function firstFrame(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (frame.type === type) resolve(frame);
    });
    socket.on("close", (code) => reject(new Error(`closed ${code}`)));
    setTimeout(() => reject(new Error(`no ${type} within 5s`)), 5_000);
  });
}

/** ABSENCE NEEDS A DEADLINE RATHER THAN A RACE. `firstFrame` resolves on the frame it
 * is waiting for, which is the right shape for "this is refused" and no shape at all
 * for "nothing was delivered". This buffers everything a socket receives so a test can
 * wait a fixed window and then read what the buffer holds. */
function collect(socket: WebSocket): () => Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  socket.on("message", (raw) => {
    frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });
  return () => [...frames];
}

async function quiet(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the socket refuses another tenant's identifiers", () => {
  let t: SocketTenants;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    t = await seedSocketTenants();
    server = serve({
      service: "gateway",
      health: () => ({}),
      logger: silent,
      notFoundDocsUrl: docsUrl("not_found"),
    });
    attachSessions({ server, api: createApiClient(t.apiUrl), logger: silent });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    t?.stop();
  });

  it("derives the frame types from the protocol, and finds some", () => {
    const types = declaredFrameTypes();
    // An empty derivation is a broken derivation, not a small protocol.
    expect(types.length).toBeGreaterThan(1);
    expect(types).toContain("message.send");
  });

  it("a connection ack names nothing belonging to the other tenant", async () => {
    const socket = new WebSocket(`${url}/v1/ws?token=${t.attacker.token}`);
    const ack = await firstFrame(socket, "connection.ack");
    const serialised = JSON.stringify(ack);
    expect(serialised).not.toContain(t.victim.channelId);
    expect(serialised).not.toContain(t.victim.environmentId);
    expect(serialised).not.toContain(t.victim.userId);
    socket.close();
  }, 20_000);

  it("message.send to the other tenant's channel is refused", async () => {
    const socket = new WebSocket(`${url}/v1/ws?token=${t.attacker.token}`);
    await firstFrame(socket, "connection.ack");
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: t.victim.channelId,
          text: "from the attacker",
        },
      }),
    );
    const error = await firstFrame(socket, "error");
    const payload = error.payload as { code?: string; message?: string };
    // The refusal must not name what it refused. An error that echoes the channel id
    // back tells the attacker the channel exists, which is the leak the HTTP gauntlet
    // proves is absent on every route — the socket does not get an exemption.
    expect(JSON.stringify(payload)).not.toContain(t.victim.channelId);
    expect(payload.code).toBeTruthy();
    socket.close();
  }, 20_000);

  it("every declared frame type that is not message.send is refused inbound", async () => {
    // SCHEMA VALIDATION RUNS BEFORE THE TYPE CHECK, and that shapes what this can
    // claim. A frame whose payload does not match its own schema is answered
    // `invalid_frame` and never reaches the rule that says clients may not utter a
    // server frame — so a loop sending `{}` for every type would pass while testing
    // the parser, not the rule. The first draft of this test did exactly that.
    //
    // So: every declared type must be refused SOMEHOW, and one well-formed server
    // frame must be refused BY THE RULE.
    const inboundOnly = declaredFrameTypes().filter((type) => type !== "message.send");
    expect(inboundOnly.length).toBeGreaterThan(0);
    for (const type of inboundOnly) {
      const socket = new WebSocket(`${url}/v1/ws?token=${t.attacker.token}`);
      await firstFrame(socket, "connection.ack");
      socket.send(JSON.stringify({ type, payload: {} }));
      const error = await firstFrame(socket, "error");
      expect((error.payload as { code?: string }).code, `${type} was not refused`).toBeTruthy();
      socket.close();
    }

    // `message.ack` carries `{ seq }`, which is the easiest valid server frame to
    // build — so it is the one that proves the rule rather than the parser.
    const socket = new WebSocket(`${url}/v1/ws?token=${t.attacker.token}`);
    await firstFrame(socket, "connection.ack");
    socket.send(JSON.stringify({ type: "message.ack", payload: { seq: 1 } }));
    const error = await firstFrame(socket, "error");
    expect((error.payload as { code?: string }).code).toBe("unknown_frame_type");
    // A protocol violation closes the connection (EIR-WS-06's 4002).
    await expect(closeCode(socket)).resolves.toBe(4002);
  }, 60_000);

  // ── THE SOCKET'S SEND INTO A PRIVATE CHANNEL OF ITS OWN TENANT ─────────────
  //
  // FR-001. Every attack above crosses a tenant boundary; this one
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
    // A PAIR, AND THE PAIR IS THE ASSERTION. A code on its own says the send was
    // refused; it does not say the refusal is indistinguishable from one for a
    // channel that exists nowhere, and indistinguishability is the property SC-002
    // asks for.
    //
    // ONE SOCKET FOR BOTH, because opening a second would let a difference in
    // connection state stand in for a difference in the answer.
    const socket = new WebSocket(`${url}/v1/ws?token=${t.attacker.token}`);
    await firstFrame(socket, "connection.ack");

    const text = `not a member ${randomUUID()}`;
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: { idem_key: randomUUID(), channel: t.attacker.privateChannelId, text },
      }),
    );
    const refused = await firstFrame(socket, "error");

    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: "00000000-0000-4000-8000-000000000000",
          text: `nowhere ${randomUUID()}`,
        },
      }),
    );
    const absent = await firstFrame(socket, "error");
    socket.close();

    const refusedCode = (refused.payload as { code?: string }).code;
    expect(refusedCode, "the private-channel send was not refused at all").toBeTruthy();
    expect(refusedCode).toBe((absent.payload as { code?: string }).code);

    // AND READ THE CHANNEL, rather than inferring its state from the refusal. A
    // refusal that wrote the row first is still a breach, and only the channel's own
    // side of the wire can tell. Read with the APPLICATION key, which sees private
    // channels (FR-005), so the check is not itself subject to the rule under test.
    const after = await t.attacker.privateHistory();
    expect(after).not.toContain(text);
  });

  // ── T047: the resume ───────────────────────────────────────────────────────
  it("a cursor naming the other tenant's channel backfills nothing", async () => {
    // Something to backfill, planted before the socket opens — a resume that finds an
    // empty channel proves nothing about whether it would have delivered.
    const text = `before the resume ${randomUUID()}`;
    await t.victim.say(text);

    const socket = new WebSocket(
      `${url}/v1/ws?token=${t.attacker.token}&cursor=${t.victim.channelId}:1`,
    );
    const frames = collect(socket);
    const ack = await firstFrame(socket, "connection.ack");

    // THE ACK ECHOES WHAT THE SERVER ACCEPTED, not what the client presented. A
    // channel this token cannot see is not in it — and asserting on the echo is the
    // cheap half, because a server that silently dropped the cursor and a server that
    // honoured it both answer with an ack.
    const cursor = (ack.payload as { cursor?: Record<string, number> }).cursor ?? {};
    expect(Object.keys(cursor)).not.toContain(t.victim.channelId);

    // THE EXPENSIVE HALF. Wait a window and read the buffer: the property is that no
    // message from that channel is delivered, and only elapsed time can say so.
    await quiet(1_000);
    const delivered = frames().filter((f) => f.type === "message.created");
    expect(delivered).toEqual([]);
    // And the buffer is not empty for an unrelated reason — the ack is in it, so a
    // collector that attached too late would fail here rather than pass vacuously.
    expect(frames().some((f) => f.type === "connection.ack")).toBe(true);
    socket.close();
  });

  it("a token minted by one tenant cannot open a session for the other", async () => {
    // The attacker asks its OWN api for a token naming the victim's user. Either the
    // mint refuses, or the session it opens must resolve nothing of the victim's.
    const borrowed = await mintToken(
      t.apiUrl,
      t.attacker.credential,
      t.victim.userExternalId,
    ).catch(() => null); // refused at the mint is the stronger answer
    if (borrowed === null) return;
    const socket = new WebSocket(`${url}/v1/ws?token=${borrowed}`);
    try {
      const ack = await firstFrame(socket, "connection.ack");
      expect(JSON.stringify(ack)).not.toContain(t.victim.channelId);
    } catch {
      // A closed socket is a refusal, which is also correct.
      await expect(closeCode(socket)).resolves.toBeGreaterThan(0);
    }
    socket.close();
  }, 20_000);
});
