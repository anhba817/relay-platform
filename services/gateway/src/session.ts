import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  ALL_CHANNELS,
  CLOSE_CODES,
  docsUrl,
  frameSchema,
  type ErrorCode,
  type Frame,
  type Message,
  isErrorCode,
  type MembershipFabric,
  type PresenceFabric,
} from "@relay/protocol";
import { newRequestId, type Logger } from "@relay/service-kit";
import { WebSocketServer, type WebSocket } from "ws";

import { ApiError, type ApiClient } from "./api-client.js";
import { authenticate, type Identity } from "./auth.js";
import type { Fanout } from "./fanout.js";
import type { Decision, GatewayLimits } from "./limits.js";
import { createMeter, METER_INTERVAL_MS, type Meter } from "./meter.js";
import { type Membership } from "./membership.js";
import { type Presence } from "./presence.js";
import { Registry, type Connection } from "./registry.js";
import { type Typing } from "./typing.js";
import {
  MAX_BUFFERED_FRAMES,
  SUBSCRIBE_DEADLINE_MS,
  flushable,
  highWaterMarks,
  scopeMarks,
  suppressed,
  parseCursors,
  scopeCursors,
  withDeadline,
} from "./resume.js";

// One session per socket (chapter 2.5). The order of operations here is the
// chapter: verify at the door, learn memberships, register, ack inside
// EIR-WS-03's one-second budget, then start the heartbeat. Frames in are
// parsed with @relay/protocol's schemas — the SAME objects the api uses, so
// a frame the gateway accepts is a frame every component understands.

const PING_INTERVAL_MS = 30_000;
const MAX_MISSED_PINGS = 2;

/** THE FRAME TYPES A CLIENT MAY SEND (chapter 3.21, FR-003).
 *
 * A SET WITH A NAME, not a second `!==` and not an array inlined at the check.
 * For twenty chapters this was one literal compared with `!==`, and a second
 * comparison would have been the cheapest edit and the worst one: two conditions
 * to keep in step, and nothing anywhere that says how many there are. A named set
 * has one home, and `session.test.ts` asserts both its size and its membership —
 * so a third inbound frame is a decision somebody made rather than a diff nobody
 * read.
 *
 * **BOTH MEMBERS END IN `.send`, and that is the rule rather than a coincidence.**
 * `message.send` was the only one until this chapter; `typing.send` was named to
 * match it, so the next person adding an inbound frame has a spelling to follow
 * and `frames.test.ts` asserts the correspondence.
 *
 * THE AUTHORITY IS STILL THIS FILE. `isolation.itest.ts`'s DIRECTIONS table
 * classifies every union member and its `inbound` rows must equal this set —
 * that test is the bridge, and it was `it.fails` from phase 2 until this line
 * landed. */
export type InboundFrameType = "message.send" | "typing.send";

export const INBOUND_FRAME_TYPES: ReadonlySet<InboundFrameType> = new Set([
  "message.send",
  "typing.send",
]);

/** **A `Set.has` IS NOT A TYPE GUARD, AND THE SINGLE `!==` WAS ONE FOR FREE.**
 *
 * Replacing `frame.data.type !== "message.send"` with a set lookup compiled and
 * then broke the send path forty lines below with three `TS2339`s — `channel`,
 * `text` and `idem_key` "does not exist on type" — because the union was no
 * longer narrowed. The comparison had been doing two jobs and only one of them
 * was visible.
 *
 * A predicate keeps both: the set stays the single home FR-003 asks for, and the
 * narrowing comes back. **It has to take the FRAME rather than the type string** —
 * the first version took `type: string` and compiled, and the send path still did
 * not narrow, because TypeScript cannot push a narrowing of `.type` back onto the
 * discriminated union it came from. The alternative was an unreachable
 * `if (type !== "message.send") return;` after the branch below, which is dead
 * code the coverage ratchet would have to be told to ignore — and this chapter's
 * pins are 100/100/100/100. */
function isInboundFrame(frame: Frame): frame is Extract<Frame, { type: InboundFrameType }> {
  return INBOUND_FRAME_TYPES.has(frame.type as InboundFrameType);
}

function send(socket: WebSocket, frame: Frame): void {
  socket.send(JSON.stringify(frame));
}

/** EIR-API-04's envelope, wearing its WebSocket clothes.
 *
 * `request_id` ARRIVED IN CHAPTER 3.8, and the gateway had none to give — it
 * minted no ids at all. The field is required on the frame rather than optional,
 * because an optional fourth field would have been the fourth instance of the
 * habit that chapter is about: `rate_limited`, close code 4008 and this field
 * were all declared in 1.3 and left unenforced (research R13).
 *
 * WHAT THE ID IS FOR decides its shape. A developer quoting one in a support
 * ticket needs it to find a single server-side log line, and on a socket the
 * useful unit is the frame that failed — a client whose tenth `message.send` was
 * refused needs to point at that refusal, not at the connection. So callers pass
 * the id of the frame they are answering, and `sendError` mints one only for a
 * frame nobody asked for. */
/** The handshake refusal (chapter 3.8, FR-RTL-03). Written onto the raw upgrade
 * socket by hand, because there is no `res` here — `server.on("upgrade")` hands
 * over the socket and the unparsed head, and anything sent on it has to be a
 * complete HTTP response including the blank line before the body.
 *
 * The same three headers the api sends on a 429, from the same numbers, plus
 * `Retry-After` — a client should not have to learn a second dialect for the
 * socket door. `Connection: close` because this socket is not becoming a
 * WebSocket and is not being kept alive for a second request either. */
function refuseUpgrade(socket: Duplex, decision: Decision): void {
  const body = JSON.stringify({
    code: "rate_limited",
    message: "too many connections; retry after the window resets",
    docs_url: docsUrl("rate_limited"),
    request_id: newRequestId(),
  });
  socket.write(
    [
      "HTTP/1.1 429 Too Many Requests",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      `Retry-After: ${decision.retryAfterSeconds}`,
      `X-RateLimit-Limit: ${decision.limit}`,
      `X-RateLimit-Remaining: ${decision.remaining}`,
      `X-RateLimit-Reset: ${decision.resetSeconds}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
  socket.destroy();
}

/** `ErrorCode`, not `string` (chapter 3.14, FR-025). Every code this function is
 * given becomes a `docs_url`, so a typo used to ship a link to a page that could
 * not exist — and the gateway is the surface where nobody sees a 404 until a
 * customer clicks it. Narrowing the parameter is what makes the registry the
 * vocabulary rather than a suggestion. */
function sendError(
  socket: WebSocket,
  code: ErrorCode,
  message: string,
  requestId: string = newRequestId(),
): void {
  send(socket, {
    type: "error",
    payload: {
      code,
      message,
      docs_url: docsUrl(code),
      request_id: requestId,
    },
  });
}

export interface SessionServerOptions {
  server: Server;
  api: ApiClient;
  logger: Logger;
  /** The cross-instance fabric (chapter 2.6). Optional so 2.5's tests —
   * and a single-instance dev run — still work without Redis; when it is
   * absent, delivery is local-only, which is exactly the split brain this
   * chapter opened with. */
  fanout?: Fanout;
  /** Overridable so tests can run the heartbeat in milliseconds instead of
   * half-minutes — the interval is a contract (EIR-WS-04), not a constant
   * the tests should have to wait out. */
  pingIntervalMs?: number;
  /** Same reasoning for the resume path's patience with the fabric
   * (chapter 2.7): the degrade branch is a contract, and a test should not
   * have to sit through half a second to see it. */
  resumeDeadlineMs?: number;
  /** The shared counter (chapter 3.8). Optional for the same reason `fanout`
   * is: 2.5's tests and a single-process dev run have no Redis, and a socket
   * server that refused to start without one would be a worse default than an
   * uncounted one. `main.ts` always supplies it, so the optionality is a test
   * affordance rather than a deployment mode. */
  limits?: GatewayLimits;
  /** Chapter 3.11. Optional for the reason `limits` and `fanout` are: 2.5's
   * tests and a single-process dev run have no api credential, and a socket
   * server that refused to start without one would be a worse default than an
   * unmetered one. `main.ts` always supplies the interval; the meter itself is
   * built here so its timer has the same owner as the heartbeat's. */
  meterIntervalMs?: number;
  /** Chapter 3.19. Optional for the same reason `fanout`, `limits` and the meter
   * are: 2.5's tests and a single-process dev run have no Redis, and a socket
   * server that refused to start without one would be a worse default than a
   * presence-less one. `main.ts` always supplies it. */
  presence?: Presence;
  /** Chapter 3.20. Optional for the same four reasons, and one more that is this
   * chapter's own: without it a connection's membership is what it was at connect,
   * which is the state FR-RTM-10 has been unmet in since 2.6. A gateway built
   * without this is not broken — it is the gateway this chapter starts from. */
  membership?: Membership;
  /** Chapter 3.21. Optional for the same reasons as the four above, and its own:
   * without it a client's typing signal is refused at the seam rather than
   * published, which is the gateway phase 2 left behind.
   *
   * **THE DESTRUCTURING IS NOT HERE**, and that is deliberate rather than an
   * omission. `no-unused-vars` rejects a binding whose first consumer is a later
   * phase, which makes the phase uncommittable — chapter 3.20 paid for that exact
   * task once. Phase 5 destructures it in the same commit that calls it. */
  typing?: Typing;
}

// THE FOUR PRESENCE TIMINGS ARE NOT HERE, and an earlier draft of this chapter put
// them here. `meterIntervalMs` is a session option because `attachSessions` BUILDS
// the meter; `fanout`, `limits` and `presence` are injected already built, and an
// injected thing carries its own configuration. A test that wants a hundred-
// millisecond grace period constructs `createPresence({ graceMs: 100, … })` and
// injects that, the way the fan-out's tests already do. Four options that only
// forwarded values would be four more things to keep in step with `PresenceOptions`.
//
// eslint found this: they were declared, destructured, and used by nothing.
// `presence` itself is declared on the interface above and destructured below, where
// the delivery path and the two hook points consume it.

export function attachSessions({
  server,
  api,
  logger,
  fanout,
  pingIntervalMs = PING_INTERVAL_MS,
  resumeDeadlineMs = SUBSCRIBE_DEADLINE_MS,
  limits,
  meterIntervalMs = METER_INTERVAL_MS,
  presence,
  membership,
  typing,
}: SessionServerOptions): {
  registry: Registry;
  meter: Meter;
  close: () => Promise<void>;
} {
  const registry = new Registry();
  // Chapter 3.11. A second timer beside the heartbeat, not a second job for it.
  const meter: Meter = createMeter({
    api,
    registry,
    logger,
    intervalMs: meterIntervalMs,
  });

  /** A frame arriving from the fabric — born on this instance or another,
   * indistinguishable by design — becomes message.created for every local
   * member of its channel. */
  function deliver(channelId: string, message: Message): void {
    for (const connection of registry.subscribersOf(channelId)) {
      if (connection.phase === "buffering") {
        // Step 2 (chapter 2.7). The frame is NOT dropped and NOT sent: it
        // waits until the backfill has had its turn, because sending it now
        // risks a duplicate and dropping it risks a gap.
        if (connection.buffer.length >= MAX_BUFFERED_FRAMES) {
          connection.overflowed = true;
          continue;
        }
        connection.buffer.push(message);
        continue;
      }
      // Chapter 3.7. A live connection is not necessarily a connection with
      // nothing to remember: a frame at or below what its backfill already
      // delivered is one it has, however long ago the resume finished. Before
      // this, delivery consulted `phase` and nothing else, and the marks were
      // discarded the moment the connection went live — which is precisely when
      // the fabric could still be catching up.
      if (suppressed(connection.marks, message)) continue;
      send(connection.socket, { type: "message.created", payload: message });
    }
  }
  fanout?.onDelivery(deliver);

  /** A presence transition arriving from its own fabric.
   *
   * NOT `deliver`'s path, and the differences are the point. Presence carries no
   * sequence, so it can neither duplicate a backfilled row nor leave a gap — which
   * is why it consults neither `connection.phase` nor `connection.marks`. Buffering
   * it during a resume would delay a frame for no benefit, and `suppressed()` takes
   * a `Message`. A transition mid-resume is sent immediately.
   *
   * THE WIRE FRAME IS BUILT FROM TWO FIELDS. `transition` is the fabric's business
   * and never leaves this function: what a client receives is what chapter 1.3
   * published and `frames.test.ts` asserts. */
  function deliverPresence(channelId: string, payload: PresenceFabric): void {
    for (const connection of registry.subscribersOf(channelId)) {
      // One frame per transition per connection, however many channels this
      // connection shares with the subject (FR-012).
      if (!presence?.claim(payload.transition, connection.id)) continue;
      send(connection.socket, {
        type: "presence.changed",
        payload: { user: payload.user, state: payload.state },
      });
    }
  }
  presence?.onTransition(deliverPresence);

  /** A membership change arriving from its own fabric (chapter 3.20, FR-RTM-05,
   * FR-RTM-10).
   *
   * `deliverPresence`'s path rather than `deliver`'s, for its reason exactly: a
   * membership change carries no sequence, so it can neither duplicate a backfilled
   * row nor leave a gap. It consults neither `connection.phase` nor
   * `connection.marks` (FR-030) — and here that is not merely harmless but required,
   * because a notice put into the resume buffer either arrives after the cut-off or
   * is dropped by the filter this same function installs three lines below.
   *
   * MEMBERS, AND THE SUBJECT LAST. The channel's remaining members are told, and the
   * removed user is told too — as the last frame that channel will ever produce for
   * them. The ordering is the requirement (FR-008): cut-then-send delivers a notice
   * to a client whose membership no longer grants access, and the frame is then the
   * one thing the cut was supposed to stop. */
  function deliverMembership(change: MembershipFabric): void {
    // A BAN ARRIVES AS ONE CHANGE AND LEAVES AS N (US4, T091). `channel` is the
    // all-channels sentinel, which exists on the fabric and in this module's log
    // lines and **never on the wire**: a client receives exactly the frames N
    // individual removals would have produced, and never a channel id of `"*"`.
    //
    // The expansion is here rather than in the api because the api cannot do it. It
    // knows which channels the ban revoked; it does not know which of them any given
    // connection on any given instance holds, and that is the set a client's frames
    // have to match.
    //
    // Recursion of depth one: each inner change names a real channel, so it takes
    // the branch below and never this one.
    if (change.channel === ALL_CHANNELS) {
      for (const connection of registry.connectionsFor(change.user)) {
        if (connection.identity.environmentId !== change.environment) {
          logger.log("error", "membership.failed", {
            op: "environment_mismatch",
            connection_id: connection.id,
            channel: change.channel,
          });
          continue;
        }
        // A COPY, because the recursion below deletes from `channelIds` and
        // iterating a Set while deleting from it skips entries. The bug that avoids
        // is a ban which revokes every other channel.
        for (const channelId of [...connection.channelIds]) {
          deliverMembership({ ...change, channel: channelId });
        }
      }
      // NO LINE OF ITS OWN. The per-channel `membership.applied` lines below say
      // what happened and how many times; a summary beside them would be a fifth
      // name in a vocabulary FR-032 keeps closed, saying nothing the others do not.
      return;
    }

    // TWO LOOKUPS, AND THE ASYMMETRY IS RESEARCH R1'S, NOT AN OPTIMISATION.
    //
    // On a REMOVAL, `subscribersOf(channel)` is the whole audience: the removed user
    // is still in `channelIds` at this instant, which is exactly why one publish on
    // the channel's subject reaches both the remaining members and the subject.
    //
    // On an ADDITION it cannot be. The new member is not in that channel yet — that
    // is what is changing — so `subscribersOf` would return every member EXCEPT the
    // one the frame is about, and the person being added would never be told. They
    // are found by who they are: `connectionsFor(user)`, which is why the addition
    // needs a principal-addressed subject to arrive on in the first place.
    //
    // Written first with one lookup for both, and the addition path silently told
    // everyone but its subject.
    const audience =
      change.change === "added"
        ? [
            ...registry.subscribersOf(change.channel),
            ...registry.connectionsFor(change.user),
          ]
        : registry.subscribersOf(change.channel);
    const subject: Connection[] = [];
    const others: Connection[] = [];
    const seen = new Set<string>();
    for (const connection of audience) {
      // The two lists overlap when a member of the channel is also the subject —
      // impossible for a genuine addition, and cheap insurance against telling
      // somebody twice if it ever is.
      if (seen.has(connection.id)) continue;
      seen.add(connection.id);
      // PRINCIPLE I IS STRUCTURAL HERE (FR-006). The environment compared is the
      // CONNECTION's, established at the door by the api, never the payload's. A
      // gateway that acted on a payload's environment id would be one compromised
      // publisher away from cross-tenant delivery — the exact shape the restriction
      // exists to prevent.
      if (connection.identity.environmentId !== change.environment) {
        logger.log("error", "membership.failed", {
          op: "environment_mismatch",
          connection_id: connection.id,
          channel: change.channel,
        });
        continue;
      }
      if (connection.identity.userExternalId === change.user) subject.push(connection);
      else others.push(connection);
    }

    const frame = {
      type: "membership.changed" as const,
      payload: { channel: change.channel, user: change.user, change: change.change },
    };
    for (const connection of others) send(connection.socket, frame);

    for (const connection of subject) {
      // SEND, THEN CUT. Reversing these two statements is the whole of FR-008, and
      // T065 proves the ordering test bites by removing this line and watching it
      // fail.
      if (change.change === "added") {
        // SUBSCRIBE, THEN INSERT, THEN SEND (T080), and the order is the whole of
        // it. `registry.subscribersOf` reads `channelIds`, so inserting first opens
        // a window in which this connection is a subscriber of a channel the
        // instance is not yet receiving — and a message published in that window is
        // silently lost rather than refused. T086 proves this ordering bites.
        void Promise.all([
          fanout?.subscribe(change.channel),
          presence?.subscribe(change.channel),
          membership?.subscribeChannel(change.channel),
        ]).then(
          () => {
            connection.channelIds.add(change.channel);
            send(connection.socket, frame);
            logger.log("info", "membership.applied", {
              change: "added",
              connection_id: connection.id,
              channel: change.channel,
              user: change.user,
            });
          },
          (error: unknown) => {
            // Swallowed and logged (FR-015). An addition whose subscribe failed
            // leaves the connection as it was: not a member, not told, and repaired
            // by the backstop rather than by a half-applied state.
            logger.log("error", "membership.failed", {
              op: "subscribe:added",
              channel: change.channel,
              error: String(error),
            });
          },
        );
        continue;
      }
      send(connection.socket, frame);
      if (change.change !== "removed") continue;

      // THE FIRST MUTATION OF THIS SET AFTER THE CONNECTION EXISTS. Every reader of
      // `channelIds` has assumed it immutable since chapter 2.5.
      connection.channelIds.delete(change.channel);
      // AND THE BUFFER IS ONE OF THOSE READERS (FR-029). `flushable(buffer, marks)`
      // filters on `frame.seq` and on nothing else, so a removal landing mid-resume
      // would unsubscribe the channel and then flush its buffered messages anyway —
      // access revoked and the backlog delivered in the same act.
      connection.buffer = connection.buffer.filter(
        (message) => message.channel !== change.channel,
      );
      // DECREMENT, NEVER RELEASE (research R6). This is the first caller of these
      // counters that is not a connection's own open or close path, and the sharp
      // test is that a SECOND local member of the same channel still receives —
      // which an implementation that unsubscribed the channel outright would fail.
      void Promise.all([
        fanout?.unsubscribe(change.channel).catch((error: unknown) => {
          logger.log("error", "fanout.unsubscribe_failed", {
            channel: change.channel,
            error: String(error),
          });
        }),
        presence?.unsubscribe(change.channel).catch((error: unknown) => {
          logger.log("error", "presence.failed", {
            op: "unsubscribe",
            channel: change.channel,
            error: String(error),
          });
        }),
        membership?.unsubscribeChannel(change.channel),
      ]);
      // THE WORKING PATH SAYS SOMETHING (FR-031's argument, applied to the delivery
      // half). `membership.published` is the api's line and means "it went onto the
      // fabric"; this one means "it took effect on a connection", which is the event
      // an operator actually wants when a customer says access did not change.
      //
      // ONE NAME CARRYING ITS DIRECTION rather than a `granted`/`revoked` pair: the
      // fabric's own payload spells the direction in a field, and two names would be
      // two more entries in a closed vocabulary for one event.
      logger.log("info", "membership.applied", {
        change: "removed",
        connection_id: connection.id,
        channel: change.channel,
        user: change.user,
      });
    }
  }
  membership?.onChange(deliverMembership);

  /** The backstop (chapter 3.20, FR-018, constitution IV).
   *
   * **CONSTITUTION IV PERMITS A LOSSY FABRIC** *"precisely because durability and
   * resume live in PostgreSQL sequences and cursors"*, and requires any new delivery
   * mechanism to preserve that recovery property. A message recovers through its
   * resume cursor. **A revocation has none** — it is not in a stream, it has no
   * sequence, and a client cannot ask for the ones it missed. This is what stands in
   * for the cursor: the truth is re-read on a timer and the difference applied.
   *
   * **ONE ACT, TWO TRIGGERS.** Every difference goes through `deliverMembership`,
   * the same function a published change takes, so the backstop cannot drift from
   * the fast path — a second application path would be a second set of rules about
   * buffers, reference counts and frame ordering, kept in step by hope.
   *
   * The client cannot tell which trigger fired, and that is correct: a
   * `membership.changed` frame means the same thing either way. */
  async function reread(connection: Connection): Promise<void> {
    const actual = new Set(await api.memberships(connection.identity));
    const held = new Set(connection.channelIds);

    for (const channelId of held) {
      if (actual.has(channelId)) continue;
      deliverMembership({
        environment: connection.identity.environmentId,
        channel: channelId,
        user: connection.identity.userExternalId,
        change: "removed",
      });
    }
    for (const channelId of actual) {
      if (held.has(channelId)) continue;
      deliverMembership({
        environment: connection.identity.environmentId,
        channel: channelId,
        user: connection.identity.userExternalId,
        change: "added",
      });
    }
  }
  // noServer: the upgrade is handled by hand so the token can be checked
  // BEFORE the handshake completes. Letting ws own the upgrade would mean
  // rejecting a socket that already exists (EIR-WS-05 wants the close code
  // on a connection we never really opened).
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/ws") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token");
    void (async () => {
      // Chapter 3.2: the api verifies, and answers with the identity AND the
      // memberships. This is the same one call the connect path already made —
      // it just asks a better question than "what may this user hear".
      const result = await authenticate(api, token);
      // Chapter 3.8. THE ESTABLISHMENT LIMIT IS SPENT HERE, before
      // `handleUpgrade`, and that placement is the whole difference between
      // this refusal and the one below it.
      //
      // A refusal needs to say WHEN to come back. `Retry-After` is an HTTP
      // header and a close frame has nowhere to put one — a close code and a
      // short reason string is all the protocol offers, and "4008, try later"
      // is not an instruction a client can schedule against. So an over-limit
      // handshake is refused with an HTTP 429 on the upgrade request, which
      // still has a response to write headers onto (research R7).
      //
      // That makes it deliberately unlike the 4001 path immediately below,
      // which COMPLETES the handshake in order to close it — because EIR-WS-05
      // asks for a close code on a bad token, and a close code needs a socket
      // to arrive on. Two refusals, two shapes, each because of what it has to
      // carry.
      //
      // AFTER authentication, not before: the limit belongs to an environment
      // and nothing knows which environment this is until the api has said so.
      // The cost is that an unauthenticated flood still reaches the api — which
      // is what the auth limiter there is for, and why that one counts by
      // source address instead.
      if (result.outcome === "ok" && limits !== undefined) {
        const decision = await limits.spend(
          result.identity.environmentId,
          "connect",
          result.limits.connect,
        );
        if (decision.over) {
          refuseUpgrade(socket, decision);
          logger.log("info", "connection.rejected", {
            reason: "rate_limited",
            environment_id: result.identity.environmentId,
          });
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (result.outcome === "refused") {
          // 4001: "invalid or expired token" (EIR-WS-05). The close code is
          // the protocol package's, not a number invented here.
          ws.close(4001, CLOSE_CODES[4001]);
          logger.log("info", "connection.rejected", { reason: "bad_token" });
          return;
        }
        if (result.outcome === "unavailable") {
          // The api could not answer. Not the client's fault, so not 4001:
          // 1011 tells it to retry, which is the honest instruction (the same
          // distinction 2.5 drew for the memberships lookup).
          ws.close(1011, "session lookup failed");
          logger.log("error", "connection.session_failed", {
            error: result.error,
          });
          return;
        }
        if (result.outcome === "banned") {
          // Chapter 3.15, FR-031. THE SHAPE OF THE QUOTA REFUSAL, for the same reason:
          // the handshake completes so a close code has a socket to arrive on, and an
          // error frame goes first because a close reason is a short string.
          //
          // 4003 AND NOT 4001. The token is valid; the user is refused. Closing 4001
          // would send a client round the re-authentication loop for ever, which is the
          // argument `codes.ts` makes for having distinct codes at all.
          sendError(
            ws,
            "user_banned",
            "this user is banned in this environment and cannot connect",
          );
          ws.close(4003, CLOSE_CODES[4003]);
          logger.log("info", "connection.rejected", { reason: "user_banned" });
          return;
        }
        if (result.outcome === "over_quota") {
          // Chapter 3.11, and this is the 4001 path's SHAPE for the 4001 path's
          // REASON. The handshake completes so that a close code has a socket to
          // arrive on — EIR-WS-05 asks that of a bad token and EIR-WS-06 asks the
          // same of quota exhaustion, and `CLOSE_CODES[4008]` has read "quota
          // exhausted" since chapter 1.3 with nothing emitting it.
          //
          // AN ERROR FRAME FIRST, because a close reason is a short string and
          // what a client needs is the date it resumes. The frame carries the
          // api's own message, four fields, exactly as a refusal over HTTP would.
          //
          // NOT `refuseUpgrade`. That writes chapter 3.8's raw 429 and its whole
          // justification was `Retry-After` — a header a close frame has nowhere
          // to put. A quota refusal declines that header on purpose, so the
          // argument for the HTTP shape evaporates with it, and the shape that is
          // left reaches a browser where a failed upgrade's body does not.
          sendError(ws, "quota_exceeded", result.message);
          ws.close(4008, CLOSE_CODES[4008]);
          logger.log("info", "connection.rejected", { reason: "quota_exceeded" });
          return;
        }
        void open(
          ws,
          result.identity,
          result.channelIds,
          req.url ?? "/",
          result.limits.send,
        );
      });
    })();
  });

  async function open(
    socket: WebSocket,
    identity: Identity,
    channelIds: string[],
    url: string,
    sendLimit: number,
  ): Promise<void> {
    // Cursors are read BEFORE anything else, because their presence decides
    // whether this connection is born buffering or born live.
    const presented = parseCursors(url);
    const connection: Connection = {
      id: randomUUID(),
      identity,
      socket,
      // Chapter 3.2: memberships arrived with the identity, from the session
      // call at the door. There is no second lookup to fail here — the api is
      // still the only source of membership (ADR-05), it just answers both
      // questions at once, and a failure now closes the socket before it opens.
      channelIds: new Set(channelIds),
      missedPings: 0,
      phase: presented === undefined ? "live" : "buffering",
      buffer: [],
      overflowed: false,
      // A fresh connect suppresses nothing; a resume fills this in when it
      // succeeds, and leaves it null when it degrades.
      marks: null,
      sendLimit,
      // Chapter 3.11. Stamped BEFORE the resume and before the ack, because the
      // socket is already open and already costing a minute — a connection that
      // started being metered only once it was fully established would give a
      // reconnect storm a free window on every attempt.
      openedAt: new Date(),
      environmentId: identity.environmentId,
    };

    registry.add(connection);
    // Subscriptions follow membership: the first local member of a channel
    // makes this instance a subscriber, and the last one to leave releases
    // it (reference-counted in the fabric).
    const subscribing = Promise.all(
      [...connection.channelIds].flatMap((channelId) => [
        fanout?.subscribe(channelId),
        // Chapter 3.19. Presence has its own subject per channel, so a channel now
        // carries two subscriptions. `ioredis` takes a variadic `subscribe`, so the
        // count doubles and the round trips do not.
        presence?.subscribe(channelId),
        // Chapter 3.20, and the third. Without this line the membership fabric has
        // no receiver at all — the publisher publishes, the module parses nothing,
        // and every test of the revocation path fails for a reason that looks like a
        // broken fabric. **No task owned it**: T054 covers the release on a
        // revocation and T079 covers the user's own subject, and the ordinary open
        // path fell between them.
        membership?.subscribeChannel(channelId),
      ]),
    );
    // THE BACKSTOP'S TIMER, one per connection and cancelled at close. Registered
    // here rather than once per instance because the re-read is per principal: the
    // api answers for the token this connection presented, and one instance-wide
    // timer would have to loop the registry and would still make one request per
    // connection. `watch` returns its own cancel for that reason.
    const stopWatching = membership?.watch(() => reread(connection));
    // T079. THE PRINCIPAL'S OWN SUBJECT, reference-counted per user rather than per
    // channel — the first subscription in this gateway keyed on who someone is
    // instead of what they can hear. An ADDITION cannot ride the channel's subject:
    // this instance is not subscribed to a channel the user is about to join, which
    // is the asymmetry research R1 names and the reason this grammar has two shapes.
    void membership?.subscribeUser(
      identity.environmentId,
      identity.userExternalId,
    );
    // AFTER `registry.add`, so "is this the user's first connection here?" is asked
    // of a registry that already contains it. The close handler needs the opposite
    // and gets it three lines apart — see the note there.
    void presence?.connected(
      identity.environmentId,
      identity.userExternalId,
      connection.channelIds,
    );
    logger.log("info", "connection.opened", {
      connection_id: connection.id,
      user: identity.userExternalId,
      channels: connection.channelIds.size,
      resuming: presented !== undefined,
    });

    // Listeners go on BEFORE the resume, not after the ack. A resume takes
    // a round trip to the api, and a socket that dies inside that window
    // must still be removed from the registry and release its subscriptions
    // — otherwise a client that reconnects impatiently leaks an instance's
    // worth of state per attempt.
    socket.on("pong", () => {
      connection.missedPings = 0;
    });
    socket.on("message", (raw) => void handle(connection, raw.toString()));
    socket.on("close", (code) => {
      // Chapter 3.11, and the ORDER MATTERS. The meter is told first, because
      // the line below removes this connection from the registry the meter walks
      // — and a socket that opened and closed between two reports would
      // otherwise be counted zero. That is not a rounding error: it is the one
      // thing the wall-clock-minute unit was chosen to charge (research R19).
      //
      // Handing over totals rather than reporting them. This handler is already
      // documented as the last place that should throw, and a mass disconnect
      // would turn one event into a burst of HTTP requests.
      meter?.closed(connection, new Date());
      registry.remove(connection.id);
      // Chapter 3.19, AND THIS HANDLER NOW CARRIES THREE ORDERING CONSTRAINTS, not
      // one. The meter is told BEFORE `registry.remove` — a socket that opened and
      // closed between two reports would otherwise be counted zero, which is the one
      // thing the wall-clock-minute unit was chosen to charge. Presence is told
      // AFTER it, because it asks whether this was the user's last connection on
      // this instance and must not count the one that is leaving. The unsubscribes
      // come last.
      //
      // Swapping the middle two is not a style change. With `registry.remove` after
      // this block, `connectionsFor` still sees the closing connection, the count is
      // 1 rather than 0, no grace check is ever scheduled, and the user stays online
      // for ever. A test asserts the scheduling for that reason.
      //
      // The condition asks a local question only. Closing one of two connections on
      // this instance must publish nothing (FR-006); whether the user is still
      // connected on some OTHER instance is Redis's to answer, and this registry has
      // been unable to see other instances since 2.5.
      if (
        registry.connectionsFor(connection.identity.userExternalId).length === 0
      ) {
        void presence?.disconnected(
          connection.identity.environmentId,
          connection.identity.userExternalId,
          connection.channelIds,
        );
      }
      stopWatching?.();
      // RELEASED PER CONNECTION, NOT PER USER, and the difference from the block
      // above is deliberate. Presence asks "was that the user's last connection
      // here?" because a transition is about the person. This is a reference count
      // over the same subject, so the second connection's release is exactly what
      // decrements it to zero — and putting it inside the `=== 0` branch would
      // decrement once for two increments.
      void membership?.unsubscribeUser(
        connection.identity.environmentId,
        connection.identity.userExternalId,
      );
      // Releasing a subscription can fail — a broker that went away, or a
      // fabric already closed while sockets were still draining — and a
      // close handler is the last place that should throw. The subscribe
      // path has said this since 2.7; the release path had not, and an
      // unhandled rejection during teardown is how chapter 2.8's lane found
      // out. Nothing to recover: the connection is gone either way.
      void Promise.all(
        [...connection.channelIds].flatMap((channelId) => [
          fanout?.unsubscribe(channelId).catch((error: unknown) => {
            logger.log("error", "fanout.unsubscribe_failed", {
              channel: channelId,
              error: String(error),
            });
          }),
          // Inside the same swallowing wrapper, because a close handler is the last
          // place that should throw — chapter 2.8's lane found the unhandled
          // rejection on the fan-out's release path for exactly this reason.
          presence?.unsubscribe(channelId).catch((error: unknown) => {
            logger.log("error", "presence.failed", {
              op: "unsubscribe",
              channel: channelId,
              error: String(error),
            });
          }),
          // The membership module swallows and logs its own failures internally, so
          // there is no `.catch` to add here — `failable()` in `membership.ts` is
          // where that decision lives, and duplicating it would log twice.
          membership?.unsubscribeChannel(channelId),
        ]),
      );
      logger.log("info", "connection.closed", {
        connection_id: connection.id,
        code,
      });
    });

    if (presented === undefined) {
      // A FRESH connect, and 2.6's rule stands unchanged: never wait on the
      // fabric here. EIR-WS-03 gives the handshake one second, and a stopped
      // broker must cost delivery, not connections.
      void subscribing.catch((error: unknown) => {
        logger.log("error", "fanout.subscribe_failed", {
          connection_id: connection.id,
          error: String(error),
        });
      });
      ack(connection, { cursor: {}, resume_ok: true, truncated: [] });
      return;
    }
    await resume(connection, presented, subscribing);
  }

  /** EIR-WS-03's ack. `cursor` echoes what the server ACCEPTED, never the
   * post-backfill high-water mark: this frame goes out BEFORE the backfilled
   * frames, so advertising a position the client has not received yet is how
   * you manufacture the gap this chapter exists to close. */
  function ack(
    connection: Connection,
    payload: {
      cursor: Record<string, number>;
      resume_ok: boolean;
      truncated: string[];
    },
  ): void {
    send(connection.socket, {
      type: "connection.ack",
      payload: { user: connection.identity.userExternalId, ...payload },
    });
  }

  /** The five steps (chapter 2.7, SAD §5.2). Steps 1 and 2 already happened
   * — the connection was born `buffering` and the subscribes are in flight
   * — so what is left is: confirm, backfill, ack, emit, flush, live. */
  async function resume(
    connection: Connection,
    presented: Record<string, number> | null,
    subscribing: Promise<unknown>,
  ): Promise<void> {
    const cursors =
      presented === null ? {} : scopeCursors(presented, connection.channelIds);

    /** Everything that cannot promise completeness ends up here: the client
     * is told resume did not happen and which channels to page instead. The
     * frames held so far are dropped on purpose — they would be an arbitrary
     * fragment of a stream the client is about to refetch in full. */
    const degrade = (reason: string): void => {
      connection.buffer = [];
      // AND THE MARKS. A degraded resume tells the client to page history for
      // every channel, so the backfill behind these marks is a fragment or
      // nothing at all — suppressing on them would turn this chapter's duplicate
      // into a gap, which constitution II ranks worse.
      connection.marks = null;
      connection.phase = "live";
      ack(connection, {
        cursor: cursors,
        resume_ok: false,
        truncated: [...connection.channelIds],
      });
      logger.log("info", "resume.degraded", {
        connection_id: connection.id,
        reason,
      });
    };

    // A malformed cursor is not a closed connection. A client whose stored
    // cursor got corrupted can recover from `resume_ok: false` by paging
    // history; a client closed at the door can only reconnect and be closed
    // again. (2.4 answers a bad cursor with 400 because a REST caller can
    // read the error and change its mind mid-flight; a socket cannot.)
    if (presented === null) return degrade("malformed_cursor");

    // Step 1 must be TRUE, not merely started: a subscription that lands
    // after the backfill query leaves the window open. 2.6's rule survives
    // via the deadline — resume waits briefly and then degrades honestly
    // rather than hanging a handshake on a broker.
    if (!(await withDeadline(subscribing, resumeDeadlineMs))) {
      return degrade("fabric_unconfirmed");
    }

    let backfilled: Awaited<ReturnType<ApiClient["backfill"]>>;
    try {
      // Step 3. Nothing is emitted yet — the ack has to carry the
      // truncation list, so the fetch comes first (EIR-WS-03's comment in
      // the protocol package has said so since 1.3).
      backfilled = await api.backfill(connection.identity, cursors);
    } catch (error) {
      logger.log("error", "resume.backfill_failed", {
        connection_id: connection.id,
        error: String(error),
      });
      return degrade("backfill_failed");
    }

    const marks = highWaterMarks(cursors, backfilled);
    const truncated = Object.entries(backfilled)
      .filter(([, page]) => page.truncated)
      .map(([channelId]) => channelId);
    // An overflowed buffer means live frames were dropped and we cannot say
    // which; the honest answer is the same one FR-RTM-04 gives for too much
    // backfill — page history instead of trusting the stream.
    if (connection.overflowed) return degrade("buffer_overflow");

    ack(connection, { cursor: cursors, resume_ok: true, truncated });

    for (const [, page] of Object.entries(backfilled)) {
      for (const message of page.messages) {
        send(connection.socket, {
          type: "message.created",
          payload: message,
        });
      }
    }

    // Step 4. Overflow between the ack and here cannot be reported in an
    // ack that already left, so the socket closes and the client resumes
    // again from the cursor it never advanced. (A channel busy enough to
    // overflow every attempt would loop; 7.5's load work is where that gets
    // measured rather than guessed.)
    if (connection.overflowed) {
      connection.socket.close(1011, "resume buffer overflow");
      return;
    }
    for (const message of flushable(connection.buffer, marks)) {
      send(connection.socket, { type: "message.created", payload: message });
    }
    connection.buffer = [];
    // KEPT, where chapter 2.7 discarded them. Scoped to the cursors this
    // connection actually presented, so the bound is this service's rather than
    // one inherited from the shape of the api's response.
    connection.marks = scopeMarks(marks, cursors);
    // Step 5.
    connection.phase = "live";
    logger.log("info", "resume.completed", {
      connection_id: connection.id,
      backfilled: Object.values(backfilled).reduce(
        (n, page) => n + page.messages.length,
        0,
      ),
      truncated: truncated.length,
    });
  }

  /** CHAPTER 3.21 (T033): a client's typing signal, on its way out.
   *
   * **THREE THINGS THE CLIENT DOES NOT GET TO DECIDE**, and each is one line:
   *
   *   the user           `connection.identity.userExternalId`, never the payload.
   *                      `typingSendSchema` has no `user` field at all, so this is
   *                      belt and braces — but the field is what a reader checks,
   *                      and a schema is not where they look (FR-006).
   *   the environment    the connection's, for the same reason. It travels on the
   *                      fabric and not on the wire, so a receiving gateway can
   *                      check it against the connection it is about to act on.
   *   the audience       whoever is subscribed to the channel's subject, which is
   *                      not this function's business at all.
   *
   * **A SIGNAL FOR A CHANNEL THE CONNECTION DOES NOT HOLD PUBLISHES NOTHING AND
   * SAYS NOTHING** (FR-007). Not an error frame: an error would tell a client
   * whether a channel exists, which is the probe chapter 3.15 closed on the REST
   * surface. `channelIds` is the membership this connection was granted, kept
   * current by chapter 3.20's two branches, so the check is a set lookup rather
   * than a question for the api.
   *
   * No await on delivery, no ack, nothing stored. `publish` swallows its own
   * failures and logs them (FR-015): a lost typing frame costs one renewal
   * interval and corrects itself, and it must never fail the socket that sent
   * it. */
  async function signalTyping(
    connection: Connection,
    channelId: string,
  ): Promise<void> {
    if (!connection.channelIds.has(channelId)) return;
    await typing?.publish({
      environment: connection.identity.environmentId,
      channel: channelId,
      user: connection.identity.userExternalId,
    });
  }

  async function handle(connection: Connection, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendError(connection.socket, "invalid_frame", "frame is not JSON");
      return;
    }
    const frame = frameSchema.safeParse(parsed);
    if (!frame.success) {
      sendError(
        connection.socket,
        "invalid_frame",
        frame.error.issues[0]?.message ?? "frame failed schema validation",
      );
      return;
    }
    if (!isInboundFrame(frame.data)) {
      // Everything else in the union is server → client. A client uttering
      // one is a protocol violation, not a malformed frame (EIR-WS-06).
      sendError(
        connection.socket,
        "unknown_frame_type",
        `clients may not send ${frame.data.type}`,
      );
      connection.socket.close(4002, CLOSE_CODES[4002]);
      return;
    }

    // Chapter 3.21. THE SECOND INBOUND FRAME, and it leaves before the send
    // limiter below: a typing signal is not a send and must not spend a send's
    // budget (FR-014). It also never reaches the api — the whole path is this
    // gateway, Redis, and whoever is subscribed.
    if (frame.data.type === "typing.send") {
      await signalTyping(connection, frame.data.payload.channel);
      return;
    }

    // Chapter 3.8. THE SEND LIMIT IS SPENT ON THE FRAME, not on the api call
    // it becomes — a socket send and a REST send count against one budget
    // (FR-RTL-01), or a client could double its allowance by opening a socket.
    //
    // AND THE CONNECTION STAYS OPEN. Closing it would be the obvious move and
    // the wrong one: a closed socket makes the client reconnect, a reconnect
    // costs a handshake, and a handshake spends the ESTABLISHMENT allowance —
    // a limiter that punishes the limited into hitting a second limit. The
    // error frame says no to this frame and nothing more; the next one, after
    // the window turns over, goes through on the connection that is still there.
    //
    // The limit is the one this socket was born with (`connection.sendLimit`),
    // not one re-read per frame: the gateway has no database, and a Postgres
    // read on the hot path of the thing the limit protects would be a strange
    // way to protect it. A policy changed mid-connection reaches the client
    // when it reconnects (research R12).
    if (limits !== undefined) {
      const decision = await limits.spend(
        connection.identity.environmentId,
        "send",
        connection.sendLimit,
      );
      if (decision.over) {
        // `rate_limited` — declared in chapter 1.3, emitted here for the first
        // time. The numbers a 429 would carry in headers have nowhere to live
        // on a frame, so the retry window goes in the message text; the code is
        // what a client branches on.
        sendError(
          connection.socket,
          "rate_limited",
          `send rate limit exceeded; retry in ${decision.retryAfterSeconds}s`,
        );
        logger.log("info", "send.rate_limited", {
          connection_id: connection.id,
          environment_id: connection.identity.environmentId,
        });
        return;
      }
    }

    const { channel, text, idem_key } = frame.data.payload;
    try {
      const committed = await api.sendMessage(connection.identity, {
        channel_id: channel,
        text,
        idempotency_key: idem_key,
      });
      const { seq } = committed;
      // The ack carries the sequence the API committed — after the commit,
      // never before (FR-MSG-05, unchanged since 2.2; the socket is a new
      // door onto the same write path).
      send(connection.socket, { type: "message.ack", payload: { seq } });
      // …and only THEN does anyone else hear about it. Durability, then the
      // sender's confirmation, then everybody's copy: no step overtakes the
      // one before it (§5.1's ordering, now spanning machines).
      //
      // A RECOGNISED RETRY IS NOT REPUBLISHED. 2.3 made the retry safe for
      // storage; that did not make it safe for delivery, and a client that
      // retries on a flaky link would otherwise put the same message on
      // every member's screen twice. `text === null` is the same argument:
      // a tombstone recovered by an old key is not a creation.
      if (!committed.duplicate && committed.text !== null) {
        await fanout?.publish({
          id: committed.id,
          channel: committed.channel_id,
          seq: committed.seq,
          user: committed.user,
          text: committed.text,
          created_at: committed.created_at,
        });
      }
    } catch (error) {
      logger.log("error", "send.failed", {
        connection_id: connection.id,
        error: String(error),
      });
      // Chapter 3.2. A 401 here means the token this connection was opened
      // with has aged out: the socket is still up (FR-AUT-11 says expiry must
      // not terminate it) and still RECEIVES, because delivery never asks the
      // api anything. Writing does. Until FR-AUT-11's second clause exists — a
      // frame that lets a client hand over a refreshed token on the open
      // connection — the honest instruction is "reconnect", and saying so is
      // more useful than an "internal error" the client cannot act on.
      if (error instanceof ApiError && error.status === 401) {
        sendError(
          connection.socket,
          "unauthorized",
          "the token this connection was opened with has expired; " +
            "reconnect with a fresh one to send again",
        );
        return;
      }
      // ── THE API'S OWN REFUSAL, FORWARDED (chapter 3.15) ────────────────────
      //
      // A 4xx from the api is a fact about this request, and the api already named it:
      // `user_banned` for a banned sender, `channel_archived` for a closed channel,
      // `not_a_member`, `invalid_request`. Flattening those to `internal_error` told a
      // client to retry something that will never succeed, and hid two of this feature's
      // own refusals behind "send failed".
      //
      // ONLY 4xx, AND ONLY A REGISTERED CODE. A 5xx is not the client's business and its
      // body is not a contract; an unregistered string would put a code on the wire that
      // `codes.ts` does not define, which is the thing chapter 3.14's registry exists to
      // prevent. Anything that fails either test stays `internal_error`.
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.code !== undefined &&
        isErrorCode(error.code)
      ) {
        sendError(
          connection.socket,
          error.code,
          error.publicMessage ?? "the request was refused",
        );
        return;
      }
      sendError(connection.socket, "internal_error", "send failed");
    }
  }

  const heartbeat = setInterval(() => {
    for (const connection of registry.all()) {
      if (connection.missedPings >= MAX_MISSED_PINGS) {
        // A dead socket that looks alive is a resume that never triggers
        // (EIR-WS-04). 2.7 needs death to be detected promptly.
        connection.socket.close(1001, "ping timeout");
        registry.remove(connection.id);
        continue;
      }
      connection.missedPings += 1;
      connection.socket.ping();
    }
  }, pingIntervalMs);

  return {
    registry,
    meter,
    // ASYNC, because of what it now has to wait for (research R11, FR-RTL-05). A
    // final report on the way out takes the graceful case's loss to zero and
    // leaves R10's one-interval bound for the case that cannot be helped. A
    // flush that is not awaited is the same non-guarantee one line further down:
    // the process leaves before the request does.
    close: async () => {
      clearInterval(heartbeat);
      meter.stop();
      await meter.reportOnce(new Date());
      wss.close();
    },
  };
}
