import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLogger } from "@relay/service-kit";
import type { Message } from "@relay/protocol";

import { createFanout, subjectFor, type Fanout } from "./fanout.js";

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

const CHANNEL = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

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

/** One gateway instance's worth of fabric, with its deliveries recorded. */
function instance(): { fanout: Fanout; deliveries: Array<[string, Message]> } {
  const deliveries: Array<[string, Message]> = [];
  const fanout = createFanout({ url, logger });
  fanout.onDelivery((channelId, message) =>
    deliveries.push([channelId, message]),
  );
  return { fanout, deliveries };
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

  it("names subjects per channel, so an instance hears only what it can deliver", () => {
    expect(subjectFor(CHANNEL)).toBe(`chan:${CHANNEL}`);
  });
});
