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

describe("the socket refuses another tenant's identifiers", () => {
  let t: SocketTenants;
  let server: Server;
  let url: string;
  let attackerToken: string;

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
    attackerToken = await mintToken(t.apiUrl, t.attacker.credential, t.attacker.userExternalId);
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
    const socket = new WebSocket(`${url}/v1/ws?token=${attackerToken}`);
    const ack = await firstFrame(socket, "connection.ack");
    const serialised = JSON.stringify(ack);
    expect(serialised).not.toContain(t.victim.channelId);
    expect(serialised).not.toContain(t.victim.environmentId);
    expect(serialised).not.toContain(t.victim.userId);
    socket.close();
  }, 20_000);

  it("message.send to the other tenant's channel is refused", async () => {
    const socket = new WebSocket(`${url}/v1/ws?token=${attackerToken}`);
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
      const socket = new WebSocket(`${url}/v1/ws?token=${attackerToken}`);
      await firstFrame(socket, "connection.ack");
      socket.send(JSON.stringify({ type, payload: {} }));
      const error = await firstFrame(socket, "error");
      expect((error.payload as { code?: string }).code, `${type} was not refused`).toBeTruthy();
      socket.close();
    }

    // `message.ack` carries `{ seq }`, which is the easiest valid server frame to
    // build — so it is the one that proves the rule rather than the parser.
    const socket = new WebSocket(`${url}/v1/ws?token=${attackerToken}`);
    await firstFrame(socket, "connection.ack");
    socket.send(JSON.stringify({ type: "message.ack", payload: { seq: 1 } }));
    const error = await firstFrame(socket, "error");
    expect((error.payload as { code?: string }).code).toBe("unknown_frame_type");
    // A protocol violation closes the connection (EIR-WS-06's 4002).
    await expect(closeCode(socket)).resolves.toBe(4002);
  }, 60_000);

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
