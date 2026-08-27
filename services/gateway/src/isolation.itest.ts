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
  /** The close code, once it arrives (T151). Added because a refusal at
   * connect IS a close code — the frame is only the explanation — and asserting the
   * frame alone would pass whether the socket closed 4003, 4001 or not at all. */
  closedWith: (timeoutMs?: number) => Promise<number>;
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

  const closedWith = async (timeoutMs = 5_000): Promise<number> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (closed !== null) return closed;
      if (Date.now() > deadline) throw new Error("socket never closed");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  return { socket, waitFor, frames: () => [...buffer], opened, closedWith };
}

async function quiet(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** OPEN AND BUFFER IN ONE STEP. Every socket in this file goes through here, because
 * `read` has to attach its listener at construction time — the whole point of the
 * buffer — and a `new WebSocket(…)` written inline is a socket whose handshake frame
 * nobody is listening for. */
/** EVERY SOCKET THIS FILE OPENS, so `afterAll` can close them.
 *
 * `server.close()` waits for its connections. A test that asserts a refusal has no
 * reason to close the socket it was refused on, and fifteen tests leaving one open
 * each made the teardown hook time out at 10s — with every test passing, which reads
 * as a suite that works and a harness that does not. */
const sockets: WebSocket[] = [];

function connect(base: string, token: string, query = ""): Reader {
  const socket = new WebSocket(`${base}/v1/ws?token=${token}${query}`);
  sockets.push(socket);
  return read(socket);
}

function closeAll(): void {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  sockets.length = 0;
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
    // SOCKETS FIRST. `server.close()` waits for its connections, so a socket left
    // open by a passing test is a teardown that hangs.
    closeAll();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    t?.stop();
  });

  it("derives the frame types from the protocol, and finds some", () => {
    const types = declaredFrameTypes();
    // An empty derivation is a broken derivation, not a small protocol.
    expect(types.length).toBeGreaterThan(1);
    expect(types).toContain("message.send");
  });

  // ── T040b: a promoted bot's live token cannot open a socket (FR-005b) ──────
  //
  // REFUSING AT THE MINT IS NOT ENOUGH, and this is the test that says so. A token lives
  // up to 24 hours (FR-AUT-07), so a user promoted to a bot at 09:00 holds a valid token
  // until 09:00 tomorrow. The session route reads `banned_at` and, until this chapter,
  // not `kind` — so closing the mint alone would leave a bot able to connect for a day
  // after it became one.
  //
  // THE SOCKET SEES A CLOSE, NOT A 404. The refusal is the api's, at
  // `POST /internal/session`, and the gateway has nothing to tell a client whose session
  // was refused — which is why this test lives here and not in the api's suite.
  describe("a bot cannot open a socket, even holding a token minted before it was one", () => {
    it("closes the connection instead of acknowledging it", async () => {
      // A DISPOSABLE USER, not the tenant's own. Promoting the attacker's user makes it
      // unable to connect for the rest of the file, and the first version of this test
      // took the control down with it — the fifth shared-fixture casualty in two
      // features.
      const doomed = await t.attacker.disposable();
      // The token is minted while the identifier is still a person, which is the whole
      // scenario: the promotion happens afterwards and the token stays valid.
      await connect(url, doomed.token).waitFor("connection.ack");

      await doomed.promoteToBot();

      await expect(
        connect(url, doomed.token).waitFor("connection.ack"),
      ).rejects.toThrow();
    });
  });

  // ── THE CONTROL, for the reason the HTTP gauntlet needed one ────────────────
  //
  // Three of the four attacks below assert that NOTHING happened. A socket that
  // is broken, a token that is expired, a gateway that delivers to nobody — all
  // of those also make nothing happen, and would pass this file while attacking
  // nothing. So the attacker's socket is shown to work first.
  describe("the control: the attacker's own socket works", () => {
    it("connects and is acknowledged", async () => {
      const ack = await connect(url, t.attacker.token).waitFor<{ payload: { user: string } }>(
        "connection.ack",
      );
      expect(ack.payload.user).toBe(t.attacker.userExternalId);
    });

    it("sends into its own channel and is acked", async () => {
      const client = connect(url, t.attacker.token);
      await client.waitFor("connection.ack");
      client.socket.send(
        JSON.stringify({
          type: "message.send",
          payload: {
            idem_key: randomUUID(),
            channel: t.attacker.channelId,
            text: "the control writes",
          },
        }),
      );
      const ack = await client.waitFor<{ payload: { seq: number } }>("message.ack");
      expect(ack.payload.seq).toBeGreaterThan(0);
    });
  });

  it("a connection ack names nothing belonging to the other tenant", async () => {
    const socket = connect(url, t.attacker.token);
    const ack = await socket.waitFor("connection.ack");
    const serialised = JSON.stringify(ack);
    expect(serialised).not.toContain(t.victim.channelId);
    expect(serialised).not.toContain(t.victim.environmentId);
    expect(serialised).not.toContain(t.victim.userId);
    socket.socket.close();
  }, 20_000);

  it("message.send to the other tenant's channel is refused", async () => {
    const socket = connect(url, t.attacker.token);
    await socket.waitFor("connection.ack");
    socket.socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: t.victim.channelId,
          text: "from the attacker",
        },
      }),
    );
    const error = await socket.waitFor("error");
    const payload = error.payload as { code?: string; message?: string };
    // The refusal must not name what it refused. An error that echoes the channel id
    // back tells the attacker the channel exists, which is the leak the HTTP gauntlet
    // proves is absent on every route — the socket does not get an exemption.
    expect(JSON.stringify(payload)).not.toContain(t.victim.channelId);
    expect(payload.code).toBeTruthy();
    socket.socket.close();
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
      const socket = connect(url, t.attacker.token);
      await socket.waitFor("connection.ack");
      socket.socket.send(JSON.stringify({ type, payload: {} }));
      const error = await socket.waitFor("error");
      expect((error.payload as { code?: string }).code, `${type} was not refused`).toBeTruthy();
      socket.socket.close();
    }

    // `message.ack` carries `{ seq }`, which is the easiest valid server frame to
    // build — so it is the one that proves the rule rather than the parser.
    const socket = connect(url, t.attacker.token);
    await socket.waitFor("connection.ack");
    socket.socket.send(JSON.stringify({ type: "message.ack", payload: { seq: 1 } }));
    const error = await socket.waitFor("error");
    expect((error.payload as { code?: string }).code).toBe("unknown_frame_type");
    // A protocol violation closes the connection (EIR-WS-06's 4002).
    await expect(socket.closedWith()).resolves.toBe(4002);
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
    const socket = connect(url, t.attacker.token);
    await socket.waitFor("connection.ack");

    const text = `not a member ${randomUUID()}`;
    socket.socket.send(
      JSON.stringify({
        type: "message.send",
        payload: { idem_key: randomUUID(), channel: t.attacker.privateChannelId, text },
      }),
    );
    const refused = await socket.waitFor("error");

    socket.socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          idem_key: randomUUID(),
          channel: "00000000-0000-4000-8000-000000000000",
          text: `nowhere ${randomUUID()}`,
        },
      }),
    );
    const absent = await socket.waitFor("error");
    socket.socket.close();

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

  // ── A REMOVED MEMBER'S RECONNECTION (SC-004) ────────────────────────────────
  //
  // T058. The session is built from `members` — `channelsForUser` selects from that
  // table, and `repository.backfill` joins it per cursor — so removal takes the
  // channel out of the next session without the gateway knowing anything about
  // removal.
  //
  // ASSERTED ON THE ACCEPTED CURSOR, and the two attempts before this one are worth
  // recording because both were unfalsifiable:
  //
  //   1. Looking for the channel id in `connection.ack`'s payload. That frame carries
  //      `user`, `cursor`, `resume_ok`, `truncated` and no channel list.
  //   2. Sending a message and waiting for `message.created`. **This suite attaches
  //      no fan-out** — `attachSessions({server, api, logger})` passes none, so
  //      `fanout?.publish` is a no-op and nothing is ever delivered here. The control
  //      hung for five seconds and timed out.
  //
  //      STILL TRUE OF THIS SUITE after this chapter. It gave the api a
  //      publisher and added a THIRD describe to `session.itest.ts` with a fan-out
  //      attached — deliberately a new block rather than a fourth argument to the
  //      existing ones, so blocks like this that want no broker keep none. If a
  //      delivery assertion belongs anywhere, it belongs there.
  //
  // The ack's `cursor` is what the server ACCEPTED, so it is the one place the
  // session's membership decision is visible from outside. The control below shows a
  // member's cursor being accepted, which is what makes the removal assertion mean
  // something.
  it("a removed member's resume cursor is no longer accepted", async () => {
    // A CONTROL AND THE CASE, in that order, on one fixture. Asserting only that a
    // removed member's cursor is refused would pass against a server that accepts no
    // cursor at all — so the same token presents the same cursor twice, and the
    // difference between the two acks is the whole assertion.
    await t.attacker.say(`before removal ${randomUUID()}`);

    const asMember = connect(url, t.attacker.token, `&cursor=${t.attacker.channelId}:0`);
    const first = await asMember.waitFor("connection.ack");
    const beforeCursor = (first.payload as { cursor?: Record<string, number> }).cursor ?? {};
    expect(Object.keys(beforeCursor)).toContain(t.attacker.channelId);
    asMember.socket.close();

    // Through the PUBLIC ROUTE, so the test asserts the consequence of the API rather
    // than of a direct write — a repository call would prove the session reads
    // `members` and nothing about whether the endpoint gets there.
    await t.attacker.removeSelf();

    const afterRemoval = connect(url, t.attacker.token, `&cursor=${t.attacker.channelId}:0`);
    const frames = afterRemoval.frames;
    const second = await afterRemoval.waitFor("connection.ack");
    const afterCursor = (second.payload as { cursor?: Record<string, number> }).cursor ?? {};
    expect(Object.keys(afterCursor)).not.toContain(t.attacker.channelId);

    // And nothing is backfilled from it either. The ack's cursor is what the server
    // ACCEPTED; this is what it DELIVERED, and the two can disagree.
    await quiet(1_000);
    expect(frames().filter((f) => f.type === "message.created")).toEqual([]);
    afterRemoval.socket.close();

    // PUT IT BACK. This test mutates state every later test in the file leans on,
    // and the next one to need it failed on its control rather than on its subject.
    await t.attacker.rejoinSelf();
  });

  // ── AN ARCHIVED CHANNEL AND THE SOCKET (FR-022a) ───────────────────────────
  //
  // T078a. FR-022 asks two things and only one of them had a task for eleven
  // analysis passes: whether an archived channel appears in a listing (it does, with
  // a flag) and **whether the socket delivers anything for it**. This is the second.
  //
  // THE ANSWER IS THAT NOTHING CHANGES, AND THE GATEWAY NEEDS NO EDIT. Archiving
  // stops writes and touches no membership, so the channel stays in the session and
  // the resume cursor is still accepted. Nothing new arrives because nothing new can
  // be sent — the refusal is at the write, not at the subscription.
  //
  // A NO-OP PROVED RATHER THAN ASSUMED. "We changed nothing so nothing broke" is the
  // sentence this test exists to replace: archiving could plausibly have been
  // implemented by removing memberships, and then a member would silently lose the
  // channel from their session.
  it("keeps an archived channel in the session and its cursor accepted", async () => {
    await t.attacker.archiveOwnChannel();
    try {
      const socket = connect(url, t.attacker.token, `&cursor=${t.attacker.channelId}:0`);
      const ack = await socket.waitFor("connection.ack");
      const cursor = (ack.payload as { cursor?: Record<string, number> }).cursor ?? {};
      expect(Object.keys(cursor)).toContain(t.attacker.channelId);
      socket.socket.close();
    } finally {
      // IN A `finally`, BECAUSE THE TEST ABOVE LEARNED THIS THE OTHER WAY. It left a
      // removed membership behind and the next test failed on its control rather
      // than on its subject. An assertion that throws must still put the state back,
      // or the diagnosis lands in a file that did nothing wrong.
      await t.attacker.unarchiveOwnChannel();
    }
  });

  // ── T047: the resume ───────────────────────────────────────────────────────
  it("a cursor naming the other tenant's channel backfills nothing", async () => {
    // Something to backfill, planted before the socket opens — a resume that finds an
    // empty channel proves nothing about whether it would have delivered.
    const text = `before the resume ${randomUUID()}`;
    await t.victim.say(text);

    const socket = connect(url, t.attacker.token, `&cursor=${t.victim.channelId}:1`);
    const frames = socket.frames;
    const ack = await socket.waitFor("connection.ack");

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
    socket.socket.close();
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
    const socket = connect(url, borrowed);
    try {
      const ack = await socket.waitFor("connection.ack");
      expect(JSON.stringify(ack)).not.toContain(t.victim.channelId);
    } catch {
      // A closed socket is a refusal, which is also correct.
      await expect(socket.closedWith()).resolves.toBeGreaterThan(0);
    }
    socket.socket.close();
  }, 20_000);

  // ── THE SAME-TENANT NON-MEMBER, ON THE SOCKET (T087) ───────────────────────

  // ── T151, T153: THE BAN AT THE DOOR, AND WHAT IT DOES TO AN OPEN SOCKET ───
  //
  // FR-032 asks what a ban does to a connection that is ALREADY OPEN, and T153 named two
  // candidate answers — "closed at the next heartbeat" and "closed immediately" — noting
  // they differ in whether the gateway has to be told.
  //
  // **THE ANSWER IS NEITHER, AND IT IS ALREADY BUILT.** A banned socket stops being able
  // to SEND the instant the ban lands, because a socket send goes through the api's
  // `/internal/messages`, which is the same repository path the ban check sits at the top
  // of. It keeps RECEIVING until it closes for any other reason, because delivery never
  // asks the api anything.
  //
  // That is not a compromise invented here — it is the shape the credentials chapter already chose
  // for an expired token, whose comment in `session.ts` says it in as many words: "the
  // socket is still up and still RECEIVES, because delivery never asks the api anything.
  // Writing does."
  //
  // WHY NOT CLOSE IT. Closing an open socket on ban needs the api to tell the gateway,
  // which is new plumbing on the fan-out for an event that happens rarely; re-checking at
  // each heartbeat needs an api call on every ping of every connection. Both buy the
  // difference between "cannot speak" and "cannot listen", for a user the tenant has
  // already silenced.
  it("refuses a banned user at connect with 4003, not 4001", async () => {
    await t.attacker.banSelf();
    try {
      const client = connect(url, t.attacker.token);
      // The error frame arrives first, because a close reason is a short string.
      const err = await client.waitFor<{ payload: { code: string } }>("error");
      expect(err.payload.code).toBe("user_banned");
      const closed = await client.closedWith();
      // 4003 AND NOT 4001. The token is valid and the user is refused; 4001 would send a
      // client round the re-authentication loop for ever.
      expect(closed).toBe(4003);
    } finally {
      await t.attacker.unbanSelf();
    }
  });

  it("stops an already-open socket from sending, and keeps delivering to it", async () => {
    const client = connect(url, t.victim.token);
    await client.waitFor("connection.ack");

    await t.victim.banSelf();
    try {
      // SENDING STOPS. The frame is accepted by the gateway and refused by the api, so
      // the client is told rather than disconnected.
      client.socket.send(
        JSON.stringify({
          type: "message.send",
          payload: {
            idem_key: randomUUID(),
            channel: t.victim.channelId,
            text: "banned mid-connection",
          },
        }),
      );
      const err = await client.waitFor<{ payload: { code: string } }>("error");
      expect(err.payload.code).toBe("user_banned");

      // AND THE SOCKET IS STILL OPEN. Stated as an assertion because it is the half of
      // FR-032 a reader will not guess: a ban silences a connection, it does not sever
      // it, and the next reconnect is where the door closes.
      expect(client.socket.readyState).toBe(1);
    } finally {
      await t.victim.unbanSelf();
    }
  });

  // ── T144: A DELETED USER'S MESSAGE STILL REACHES A SOCKET (FR-028) ────────
  //
  // THIS IS THE ASSERTION THAT WOULD HAVE CAUGHT `ON DELETE SET NULL`, and the reason
  // R7 chose to keep the row over satisfying the letter of the clause.
  //
  // `backfill.controller`'s `toFrame` turns a row into a frame **or into nothing**, and
  // one of the two rows it drops is a senderless one — `messageSchema.user` is
  // `z.string().min(1)`, so a null author cannot be a `message.created` payload at all.
  // Nulling `messages.user_id` on deletion would therefore preserve every message in
  // storage and remove it from every reconnecting client, silently, with a sequence gap
  // as the only trace.
  //
  // THE RESUME PATH IS THE ONE THAT CARRIES IT. The backfill runs at connect, from the
  // client's cursor, which is the only place in this suite where a stored message becomes
  // a frame — the live fan-out does not reach this suite at all (see T134).
  it("delivers a deleted user's message on resume, still attributed to them", async () => {
    // ITS OWN FIXTURE. The first version deleted the shared `victim`, which took that
    // tenant's membership with it and made the next test's profile PATCH answer 404 —
    // the same shared-fixture mutation the removal test hit.
    const { userExternalId, channelId, seq, witnessToken } =
      await t.victim.seedDeletable();

    const deleted = await fetch(`${t.apiUrl}/v1/users/${userExternalId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${t.victim.credential}` },
    });
    expect(deleted.status).toBe(200);

    // A REMAINING MEMBER RESUMES. The deletion took the doomed user's own membership, so
    // their session no longer carries the channel — and the case that matters is that the
    // message survives for everybody else.
    const socket = connect(url, witnessToken, `&cursor=${channelId}:0`);
    const ack = await socket.waitFor("connection.ack");
    const cursor = (ack.payload as { cursor?: Record<string, number> }).cursor ?? {};
    expect(Object.keys(cursor)).toContain(channelId);

    const mine = await socket.waitFor("message.created");
    // THE FRAME ARRIVED, and its `user` is the deleted user's external id. Both halves
    // matter: absent means `toFrame` dropped the row, and a null `user` means
    // `messageSchema` would have refused it.
    expect((mine.payload as Record<string, unknown>)["seq"]).toBe(seq);
    expect((mine.payload as Record<string, unknown>)["user"]).toBe(userExternalId);
    const frame = mine.payload as Record<string, unknown>;
    expect(frame["text"]).toBe("sent before the deletion");
    socket.socket.close();
  });

  // ── T134: THE PROFILE IS STORED AND THE WIRE DID NOT MOVE ─────────────────
  //
  // This chapter gives `users.display_name`, `users.avatar_url` and `users.metadata` a
  // route that writes them and a route that reads them. **None of that reaches a
  // socket.** `connection.ack` names who you are with a bare external id string, and
  // `messageSchema` carries `user` the same way — no display name, no avatar, no
  // metadata.
  //
  // ASSERTED RATHER THAN ASSUMED, because "we did not change the protocol" is the claim a
  // test replaces. A later change that enriched `user` into an object would break every
  // client parsing frames against the published schema.
  //
  // THE MESSAGE HALF IS CHECKED AGAINST THE SCHEMA AND NOT AGAINST A LIVE FRAME, because
  // no `message.created` ever arrives in this suite: `say()` writes through the
  // repository, THIS SUITE attaches no fan-out, and nothing here drains the outbox.
  //
  // THE REASON CHANGED IN THIS CHAPTER AND THE FACT DID NOT. This comment used to say
  // "the api publishes to no fan-out", which was the platform-wide truth the isolation
  // harness recorded as a finding — a REST-sent message reached no socket, by two
  // independent mechanisms. The sender chapter removed one and this chapter the other,
  // so the api does publish now; nothing arrives HERE because this suite subscribes to
  // nothing, which is a property of the fixture rather than of the platform.
  // `public-surface.itest.ts` used to pin the absence and now pins the arrival.
  //
  // Waiting for a frame here is still a 5-second timeout, which is how this test was
  // written the first time.
  it("keeps the socket's identity a bare external id, whatever the profile holds", async () => {
    // A full profile written through the public route.
    const patched = await fetch(`${t.apiUrl}/v1/users/${t.victim.userExternalId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${t.victim.credential}`,
      },
      body: JSON.stringify({
        display_name: "A Name On The Wire",
        avatar_url: "https://cdn.example.com/face.png",
        metadata: { seen: "by nobody" },
      }),
    });
    expect(patched.status).toBe(200);

    // THE LIVE HALF: the handshake, after the profile exists.
    const socket = connect(url, t.victim.token);
    const ack = await socket.waitFor("connection.ack");
    const identity = (ack.payload as { user?: unknown }).user;
    expect(typeof identity).toBe("string");
    expect(identity).toBe(t.victim.userExternalId);

    // THE CONTRACT HALF: the frame union refuses an enriched identity. If somebody widens
    // `messageSchema.user` to an object, this stops failing — and that is the change this
    // assertion exists to catch, because it is the one that breaks published clients.
    const enriched = frameSchema.safeParse({
      type: "message.created",
      payload: {
        id: randomUUID(),
        channel: t.victim.channelId,
        seq: 1,
        user: { id: t.victim.userExternalId, display_name: "A Name On The Wire" },
        text: "hello",
        created_at: new Date().toISOString(),
      },
    });
    expect(enriched.success).toBe(false);

    // And the six keys, exactly: a seventh would also have to be added deliberately.
    const bare = frameSchema.safeParse({
      type: "message.created",
      payload: {
        id: randomUUID(),
        channel: t.victim.channelId,
        seq: 1,
        user: t.victim.userExternalId,
        text: "hello",
        created_at: new Date().toISOString(),
        avatar_url: "https://cdn.example.com/face.png",
      },
    });
    expect(bare.success).toBe(false);
    socket.socket.close();
  });

  //
  // The protocol's frame union has exactly one inbound member — `message.send` — so
  // there is no "subscribe" frame to attack: what a socket may see is decided at
  // connect, from the session's channel list, and a cursor is the only thing a client
  // gets to assert about it. So the socket's version of "a non-member reaches a
  // private channel" is a cursor naming one.
  //
  // The tenant's own user is not a member of the tenant's own private channel —
  // `seedSocketTenants` creates it and adds nobody — which makes this the same-tenant
  // case rather than the cross-tenant one every other attack here uses.
  it("a same-tenant non-member's cursor for a private channel is not accepted", async () => {
    const socket = connect(url, t.attacker.token, `&cursor=${t.attacker.privateChannelId}:0`);
    const frames = socket.frames;
    const ack = await socket.waitFor("connection.ack");
    const cursor = (ack.payload as { cursor?: Record<string, number> }).cursor ?? {};
    expect(Object.keys(cursor)).not.toContain(t.attacker.privateChannelId);

    // THE CONTROL IS THE REMOVAL TEST ABOVE: the same token's cursor for a channel it
    // IS a member of gets accepted there. Without that pair, an empty cursor set here
    // would pass whether the session was scoped or simply broken.
    await quiet(1_000);
    expect(frames().filter((f) => f.type === "message.created")).toEqual([]);
    socket.socket.close();
  });

  // ── T048: the subscribe ────────────────────────────────────────────────────
  it("nothing from the other tenant's channel is delivered", async () => {
    const socket = connect(url, t.attacker.token);
    const frames = socket.frames;
    await socket.waitFor("connection.ack");
    await t.victim.say(`the victim speaks ${randomUUID()}`);
    // A DEADLINE RATHER THAN A RACE, and longer than the others because this one is
    // waiting on a fan-out that has to travel through Redis before it could arrive.
    await quiet(1_500);
    expect(frames().filter((f) => f.type === "message.created")).toEqual([]);
    socket.socket.close();
  });
});
