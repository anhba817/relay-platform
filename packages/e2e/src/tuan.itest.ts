import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Frame, Message } from "@relay/protocol";

import { boot, type Client, type System } from "./harness.js";

// THE TUAN TEST (chapter 2.8) — journey 4, executable.
//
// docs/07's Rule 2: "the journeys are the milestones. These aren't
// metaphors — they are the integration suites, and they are the SRS phase
// exit criteria." SRS §7.3 states Phase 1's criterion in one sentence: "Two
// clients exchange messages through the public API, surviving a forced
// disconnect with correct ordering and no duplicates." Every clause of that
// sentence is an assertion below.
//
//   docker compose up -d --wait postgres redis
//   pnpm build
//   RELAY_POSTGRES_PORT=… RELAY_REDIS_PORT=… pnpm --filter @relay/e2e test:integration
//
// Read the right margin: each step names the chapter that made it possible.
// Remove that chapter's work and a named assertion here fails.

const countOf = (timeline: Message[], text: string): number =>
  timeline.filter((m) => m.text === text).length;

const seqsOf = (timeline: Message[]): number[] => timeline.map((m) => m.seq);

const isStrictlyAscending = (seqs: number[]): boolean =>
  seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!);

const sorted = (seqs: number[]): number[] => [...seqs].sort((a, b) => a - b);

describe("journey 4 — the message that survives the tunnel", () => {
  let system: System;
  let channel: string;
  let environmentId: string;
  let dispatcher: Client;
  let tuan: Client;
  let foreign: { channel: string; text: string };
  /** Where Tuan's frame log stood when he came back — everything after this
   * index arrived through the resume. */
  let afterResume = 0;

  beforeAll(async () => {
    system = await boot({ gateways: 2 });
    const seeded = await system.seedConversation(); // 2.1
    ({ channel, environmentId, dispatcher, tuan } = seeded);
    foreign = await system.seedForeignTenant();

    // ── stage 1: type and send ───────────────────────────────────────────
    // Two personas, two INSTANCES. 2.6 exists because a single-instance
    // arrangement is blind to a whole class of bug (CON-02: any gateway
    // must serve any socket).
    try {
      await dispatcher.connect(system.gateways[0]!); // 1.4 / 2.5
      await tuan.connect(system.gateways[1]!);
    } catch (error) {
      // A handshake that never completes is usually a service saying why in
      // a log nobody read. Attach it to the failure.
      throw new Error(`${String(error)}\n${system.serviceOutput()}`, {
        cause: error,
      });
    }

    dispatcher.send(channel, "which entrance?"); // 2.2
    await tuan.expectCreated("which entrance?"); // 2.6, cross-instance

    // ── stage 2: lose signal ★ ───────────────────────────────────────────
    // The key is minted BEFORE the send (FR-SDK-06), and the transport dies
    // before any ack can return. This is the moment the platform was built
    // for.
    const ramp = tuan.mintKey(); // 2.3
    tuan.sendAndKillBeforeAck(channel, "B2, north ramp", ramp);

    // ── stage 3: the tunnel, then reconnect ──────────────────────────────
    // The dispatcher keeps talking while Tuan is gone. Those frames are
    // published to a fabric nobody is listening on for him — at-most-once,
    // by design (2.6) — so only Postgres remembers them.
    dispatcher.send(channel, "ok, coming down");
    await dispatcher.expectCreated("ok, coming down");

    // Tuan comes back on the OTHER instance (CON-02), presenting the cursor
    // he had applied before the tunnel. Same client object: an SDK does not
    // forget what it rendered just because a socket died.
    //
    // And the dispatcher does not politely stop typing while that happens.
    // This send goes out WHILE the resume is in flight, which is the race
    // 2.7 closed: the frame may be in the backfill, in the buffer, or both,
    // and the outcome must be identical either way. The window here is real
    // timing across processes, not injected — 2.7's own test is where the
    // interleaving is forced deterministically; this one runs it for real.
    const coming = tuan.reconnect(system.gateways[0]!); // 2.7
    dispatcher.send(channel, "still coming down");
    afterResume = await coming;

    // The queued send flushes with its ORIGINAL key.
    tuan.flushQueue(); // 2.3
    await tuan.waitFor(
      (f) => f.type === "message.ack",
      "message.ack",
      5_000,
      afterResume,
    );
    await tuan.expectCreated("B2, north ramp", 5_000, afterResume);
    await tuan.expectCreated("still coming down", 5_000, afterResume);
    // Let anything still in flight land before the assertions read views.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  afterAll(async () => {
    dispatcher?.close();
    tuan?.close();
    await system?.stop();
  });

  // ── stage 4: confirm ───────────────────────────────────────────────────

  it("delivers the tunnelled message exactly once, to everyone (FR-MSG-04)", () => {
    // The send that was never acked was written once, retried once with the
    // same key, and exists once — in the sender's own view and in the
    // recipient's. Break 2.3 and this is 2.
    expect(countOf(tuan.timeline(channel), "B2, north ramp")).toBe(1);
    expect(countOf(dispatcher.timeline(channel), "B2, north ramp")).toBe(1);
  });

  it("shows both clients the same messages in the same order (FR-MSG-03)", () => {
    // One order, server-assigned under 2.2's row lock — not "an order per
    // client, close enough".
    const mine = sorted(seqsOf(tuan.timeline(channel)));
    const theirs = sorted(seqsOf(dispatcher.timeline(channel)));
    expect(mine).toEqual(theirs);
    expect(mine.length).toBe(4);
  });

  it("resumes with no gap and no double (FR-RTM-03, SAD §5.2)", () => {
    const seqs = seqsOf(tuan.timeline(channel));
    // Arrival order is ascending: the backfill came in sequence order and
    // the flush added nothing out of place.
    expect(isStrictlyAscending(seqs)).toBe(true);
    // Contiguous from 1: nothing the tunnel ate is missing, and nothing
    // that arrived during the resume window went astray.
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("recovers what the tunnel ate, and re-sends nothing else (FR-RTM-03)", () => {
    const timeline = tuan.timeline(channel);
    // Everything Tuan received after coming back — the backfill plus the
    // flush, which is exactly what a resume is allowed to deliver.
    const afterTheTunnel = tuan.frames
      .slice(afterResume)
      .filter(
        (f): f is Extract<Frame, { type: "message.created" }> =>
          f.type === "message.created",
      )
      .map((f) => f.payload);

    // Heard live before the disconnect: present once in the whole story…
    expect(countOf(timeline, "which entrance?")).toBe(1);
    // …and NOT among the frames the resume delivered. This is the `seq <= H`
    // discard earning its keep: the backfill contained it, and the cursor
    // said Tuan already had it.
    expect(countOf(afterTheTunnel, "which entrance?")).toBe(0);

    // Sent while he was underground: recovered by the backfill, exactly once.
    expect(countOf(afterTheTunnel, "ok, coming down")).toBe(1);
    expect(countOf(timeline, "ok, coming down")).toBe(1);

    // Sent DURING the resume: exactly once, whichever side of the seam it
    // came down. Zero would be 2.7's gap; two would be 2.7's duplicate.
    expect(countOf(timeline, "still coming down")).toBe(1);
  });

  it("acks the retry with the original message's sequence (FR-MSG-05)", async () => {
    const acks = tuan.frames.filter((f) => f.type === "message.ack");
    const ramped = tuan
      .timeline(channel)
      .find((m) => m.text === "B2, north ramp")!;
    // The retry is answered with the sequence the FIRST attempt committed —
    // 201-equivalent semantics, indistinguishable from a first send.
    expect(acks.at(-1)).toMatchObject({ payload: { seq: ramped.seq } });
  });

  it("names the sender on every frame (chapter 2.6's fix)", () => {
    const timeline = tuan.timeline(channel);
    expect(timeline.find((m) => m.text === "B2, north ramp")!.user).toBe(
      "tuan",
    );
    expect(timeline.find((m) => m.text === "ok, coming down")!.user).toBe(
      "dispatcher",
    );
  });

  it("never mentions another tenant, on any surface (constitution I)", async () => {
    // Not a journey stage — a property. Isolation gets asserted wherever
    // correctness is asserted, so the suite seeds a second tenant with
    // traffic and confirms it stayed invisible.
    const everything = JSON.stringify(tuan.frames);
    expect(everything).not.toContain(foreign.text);
    expect(everything).not.toContain(foreign.channel);

    // And through the REST door, with this tenant's header: a foreign
    // channel is a 404, indistinguishable from one that does not exist
    // (FR-TEN-05).
    const res = await fetch(
      `${system.apiUrl}/v1/channels/${foreign.channel}/messages?limit=10`,
      { headers: { "x-relay-environment": environmentId } },
    );
    expect(res.status).toBe(404);
  });

  it("agrees with history — the read path tells the same story (FR-MSG-09)", async () => {
    // The live path and the read path are two doors onto one truth (2.4).
    // If they disagree, one of them is lying, and the suite would rather
    // know now.
    const res = await fetch(
      `${system.apiUrl}/v1/channels/${channel}/messages?limit=50&direction=newer`,
      { headers: { "x-relay-environment": environmentId } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Message[] };
    expect(body.messages.map((m) => m.seq)).toEqual(
      sorted(seqsOf(tuan.timeline(channel))),
    );
    expect(
      body.messages.filter((m) => m.text === "B2, north ramp").length,
    ).toBe(1);
  });
});
