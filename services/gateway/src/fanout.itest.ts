import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLogger } from "@relay/service-kit";
import type { Message, RevisionFabric } from "@relay/protocol";

import { createFanout, type Fanout } from "./fanout.js";

// Chapter 2.6's real test: the one behaviour a single-process test CANNOT
// show. Two fabric clients stand in for two gateway instances — same code,
// same Redis, no knowledge of each other. If a message published by one
// arrives at the other, the split brain is closed.
//
// This file is a `.itest.ts`, so the Docker-free lane never sees it (the
// two-lane gate, chapter 2.1). It needs the compose Redis:
//   docker compose up -d redis
//   RELAY_REDIS_PORT=16379 pnpm --filter @relay/gateway test:integration

const url = `redis://localhost:${process.env.RELAY_REDIS_PORT ?? "6379"}`;
const logger = createLogger("fanout-itest");

// Fresh subjects per run (chapter 2.7's fix). Redis pub/sub has no
// namespaces, so two suites publishing to a hard-coded subject on one broker
// read each other's frames — which is exactly what happened the first time
// resume.itest.ts ran beside this file. 2.1 solved the same problem for
// Postgres with a per-suite environment; the fix here is the same idea in
// the only namespace pub/sub has: the channel id.
const CHANNEL = randomUUID();
const OTHER = randomUUID();

function messageOn(channel: string, seq: number): Message {
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    channel,
    seq,
    user: "linh",
    text: `message ${seq}`,
    created_at: new Date().toISOString(),
  };
}

/** Redis pub/sub is fire-and-forget, so a test cannot poll a queue — it
 * waits for the callback, with a deadline. A failure here is a real
 * failure: the frame did not cross. */
function nextDelivery(
  instance: { deliveries: Array<[string, Message]> },
  timeoutMs = 2000,
): Promise<[string, Message]> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      const delivery = instance.deliveries.shift();
      if (delivery) {
        clearInterval(tick);
        resolve(delivery);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error("no delivery within the deadline"));
      }
    }, 10);
  });
}

/** The revision fabric's equivalent (chapter 3.23). Separate queue, separate deadline,
 * because the finding these tests exist to catch is a revision arriving on the OTHER
 * callback — and a helper that watched both could not tell them apart. */
function nextRevision(
  instance: { revisions: Array<[string, RevisionFabric]> },
  timeoutMs = 2000,
): Promise<[string, RevisionFabric]> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      const revision = instance.revisions.shift();
      if (revision) {
        clearInterval(tick);
        resolve(revision);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error("no revision within the deadline"));
      }
    }, 10);
  });
}

/** One gateway instance's worth of fabric, with its deliveries recorded. */
function instance(): {
  fanout: Fanout;
  deliveries: Array<[string, Message]>;
  revisions: Array<[string, RevisionFabric]>;
} {
  const deliveries: Array<[string, Message]> = [];
  const revisions: Array<[string, RevisionFabric]> = [];
  const fanout = createFanout({ url, logger });
  fanout.onDelivery((channelId, message) =>
    deliveries.push([channelId, message]),
  );
  fanout.onRevision((channelId, revision) =>
    revisions.push([channelId, revision]),
  );
  return { fanout, deliveries, revisions };
}

describe("fan-out across instances", () => {
  let g1: ReturnType<typeof instance>;
  let g2: ReturnType<typeof instance>;

  beforeAll(() => {
    g1 = instance();
    g2 = instance();
  });

  afterAll(async () => {
    await g1.fanout.close();
    await g2.fanout.close();
  });

  it("delivers a message published on one instance to a subscriber on another", async () => {
    await g2.fanout.subscribe(CHANNEL);
    await g1.fanout.publish(messageOn(CHANNEL, 1));

    const [channelId, message] = await nextDelivery(g2);
    expect(channelId).toBe(CHANNEL);
    expect(message.seq).toBe(1);
    expect(message.text).toBe("message 1");
    // Attribution survives the hop — the field chapter 2.6 had to add
    // before this frame could exist at all.
    expect(message.user).toBe("linh");
  });

  it("does not deliver channels an instance has no member of", async () => {
    await g1.fanout.publish(messageOn(OTHER, 2));
    await expect(nextDelivery(g2, 300)).rejects.toThrow("deadline");
    // …and the subscribed channel still works, so the silence above was
    // scoping, not a broken connection.
    await g1.fanout.publish(messageOn(CHANNEL, 3));
    const [, message] = await nextDelivery(g2);
    expect(message.seq).toBe(3);
  });

  it("keeps the subscription while a second local member holds it", async () => {
    // Two sockets on one instance, same channel: the first subscribe
    // opened it, the second must not be able to close it.
    await g2.fanout.subscribe(CHANNEL);
    await g2.fanout.unsubscribe(CHANNEL);

    await g1.fanout.publish(messageOn(CHANNEL, 4));
    const [, message] = await nextDelivery(g2);
    expect(message.seq).toBe(4);

    // The last holder leaving DOES close it.
    await g2.fanout.unsubscribe(CHANNEL);
    await g1.fanout.publish(messageOn(CHANNEL, 5));
    await expect(nextDelivery(g2, 300)).rejects.toThrow("deadline");
  });

  it("drops a payload the contract does not allow instead of forwarding it", async () => {
    await g2.fanout.subscribe(CHANNEL);
    // Something else — an older instance, a stray script, a compromised
    // dependency — puts junk on the subject. It must not reach a client.
    const raw = instance();
    await raw.fanout.publish(messageOn(CHANNEL, 6));
    const [, good] = await nextDelivery(g2);
    expect(good.seq).toBe(6);

    await new Promise<void>((resolve) => {
      const redis = raw.fanout;
      void redis.publish({
        ...messageOn(CHANNEL, 7),
        seq: -1, // schema demands a positive integer
      });
      setTimeout(resolve, 100);
    });
    await expect(nextDelivery(g2, 300)).rejects.toThrow("deadline");
    await raw.fanout.close();
  });

  it("delivers an edit on the revision subject and NOT on the message one", async () => {
    // Chapter 3.23, ADR-24. The `updated` arm's payload is a `Message`, which is exactly
    // why this test names both callbacks. Route on the wrong one and an edit is shown to
    // every member as a brand new message — and nothing about its shape would say so.
    await g2.fanout.subscribe(CHANNEL);
    g2.deliveries.length = 0;
    await g1.fanout.publishRevision({
      kind: "updated",
      message: { ...messageOn(CHANNEL, 8), text: "corrected" },
    });

    const [channelId, revision] = await nextRevision(g2);
    expect(channelId).toBe(CHANNEL);
    expect(revision.kind).toBe("updated");
    expect(revision.kind === "updated" && revision.message.text).toBe("corrected");
    // THE HALF THAT FALSIFIES: no creation was delivered.
    expect(g2.deliveries).toEqual([]);
    await g2.fanout.unsubscribe(CHANNEL);
  });

  it("delivers a deletion, which cannot be a message at all", async () => {
    await g2.fanout.subscribe(CHANNEL);
    g2.deliveries.length = 0;
    await g1.fanout.publishRevision({
      kind: "deleted",
      message: {
        id: "00000000-0000-0000-0000-000000000009",
        channel: CHANNEL,
        seq: 9,
        user: "linh",
        deleted_at: new Date().toISOString(),
      },
    });

    const [, revision] = await nextRevision(g2);
    expect(revision.kind).toBe("deleted");
    expect(revision.message.seq).toBe(9);
    expect(g2.deliveries).toEqual([]);
    await g2.fanout.unsubscribe(CHANNEL);
  });

  it("one subscribe covers both subjects, and one unsubscribe drops both", async () => {
    // The reference count is shared by construction. The test that carries it is the
    // NEGATIVE one: after the last holder leaves, a revision must go nowhere. Two counts
    // would leave the revision subject subscribed after the message one closed.
    // ITS OWN CHANNEL, because this is the one test in the file that asserts a subject is
    // CLOSED — and `CHANNEL`'s reference count is whatever the tests above left it at.
    // The first draft used `CHANNEL` and would have gone green on a held count.
    const own = randomUUID();
    await g2.fanout.subscribe(own);
    await g1.fanout.publishRevision({ kind: "updated", message: messageOn(own, 10) });
    const [, revision] = await nextRevision(g2);
    expect(revision.message.seq).toBe(10);

    await g2.fanout.unsubscribe(own);
    await g1.fanout.publishRevision({ kind: "updated", message: messageOn(own, 11) });
    await expect(nextRevision(g2, 300)).rejects.toThrow("deadline");
    // …and the message subject is gone too, which is what makes them one count.
    await g1.fanout.publish(messageOn(own, 12));
    await expect(nextDelivery(g2, 300)).rejects.toThrow("deadline");
  });

  it("drops a revision the contract does not allow", async () => {
    // A deletion carrying a text is the malformed case that matters: it is what a producer
    // reaching for `messageSchema` would emit, and `strictObject` is what refuses it.
    await g2.fanout.subscribe(CHANNEL);
    const raw = instance();
    await raw.fanout.publishRevision({
      kind: "deleted",
      message: {
        id: "00000000-0000-0000-0000-000000000013",
        channel: CHANNEL,
        seq: 13,
        user: "linh",
        deleted_at: new Date().toISOString(),
        // @ts-expect-error the point of the test: a key the schema forbids
        text: "",
      },
    });
    await expect(nextRevision(g2, 300)).rejects.toThrow("deadline");

    // …and a well-formed one on the same subject still arrives, so the silence above was
    // the schema and not a dead subscription.
    await raw.fanout.publishRevision({ kind: "updated", message: messageOn(CHANNEL, 14) });
    const [, good] = await nextRevision(g2);
    expect(good.message.seq).toBe(14);
    await raw.fanout.close();
    await g2.fanout.unsubscribe(CHANNEL);
  });

  // THE SUBJECT GRAMMAR'S TEST MOVED IN CHAPTER 3.18, to
  // `packages/protocol/src/fanout.test.ts`, along with `subjectFor` itself. It
  // was a pure string assertion sitting in a suite that needs a running Redis;
  // it needed neither. What stays here is everything that genuinely needs the
  // fabric — two clients, a real subject, and a delivery.
});
