import { describe, expect, it } from "vitest";

import { messageCreatedEvent } from "./event";
import { publishPending, type Publisher } from "./publisher";

// Invariant 12: the publishing destination is replaceable without touching the
// code that writes events (spec FR-014). ADR-06 calls the outbox "the
// abstraction seam that makes ADR-02 reversible" — which is only true if the
// producing side can be exercised with no broker in the room at all. This file
// is that claim, made Docker-free.

const ENV = "3f2a0000-0000-0000-0000-000000000001";

/** A destination that is not a broker. Written HERE rather than shipped in the
 * module, because a fake living in production code is a fake somebody
 * eventually wires up by accident. */
function recordingPublisher(): Publisher & {
  sent: { subject: string; id: string; payload: unknown }[];
} {
  const sent: { subject: string; id: string; payload: unknown }[] = [];
  return {
    sent,
    async publish(message) {
      sent.push(message);
    },
    async close() {},
  };
}

const pending = (id: string) =>
  messageCreatedEvent({
    eventId: id,
    environmentId: ENV,
    message: {
      id: "57d5cdf0-e145-4bca-b7fa-a7a43e8ffbb6",
      channel_id: "ce419dc5-b06e-441c-ab38-49451f87210e",
      seq: 1,
      user: "tuan",
      text: "B2, north ramp",
      created_at: "2026-08-08T13:31:09.229Z",
    },
  });

describe("the publisher port", () => {
  it("is satisfied by something that has never heard of a broker", async () => {
    const publisher = recordingPublisher();
    const event = pending("8f14e45f-ceea-4f6a-9b2c-1d2e3f4a5b6c");

    await publishPending(publisher, {
      subject: event.subject,
      payload: event.payload,
    });

    expect(publisher.sent).toEqual([
      {
        subject: event.subject,
        id: event.payload.id,
        payload: event.payload,
      },
    ]);
  });

  it("carries exactly three things: where, which, and what", async () => {
    // If a broker-specific field ever appears in this signature, swapping the
    // broker stops being a configuration change and starts being a rewrite of
    // everything that produces events.
    const publisher = recordingPublisher();
    const event = pending("aaaaaaaa-0000-0000-0000-000000000001");
    await publishPending(publisher, {
      subject: event.subject,
      payload: event.payload,
    });
    expect(Object.keys(publisher.sent[0]!).sort()).toEqual([
      "id",
      "payload",
      "subject",
    ]);
  });

  it("uses the event's own id as the deduplication key", async () => {
    // Not the outbox row's id: that number is meaningless outside this database
    // and would leak the platform's event volume to every customer (research R7).
    const publisher = recordingPublisher();
    const event = pending("bbbbbbbb-0000-0000-0000-000000000002");
    await publishPending(publisher, {
      subject: event.subject,
      payload: event.payload,
    });
    expect(publisher.sent[0]!.id).toBe("bbbbbbbb-0000-0000-0000-000000000002");
  });

  it("lets a failing destination fail loudly, so the row stays unpublished", async () => {
    // The relay marks a row published only after the publisher resolves. A
    // publisher that swallowed its own errors would turn at-least-once into
    // at-most-once silently — the exact failure this chapter exists to remove.
    const broken: Publisher = {
      async publish() {
        throw new Error("broker unreachable");
      },
      async close() {},
    };
    const event = pending("cccccccc-0000-0000-0000-000000000003");
    await expect(
      publishPending(broken, {
        subject: event.subject,
        payload: event.payload,
      }),
    ).rejects.toThrow(/unreachable/);
  });
});
