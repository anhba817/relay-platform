import { describe, expect, it } from "vitest";

import { messageCreatedEvent, subjectFor } from "./event";

// The envelope (chapter 3.3), Docker-free. What a consumer eventually receives
// is decided here and nowhere else — the relay moves bytes, it does not author
// them (ADR-04, research R7).

const ENV = "3f2a0000-0000-0000-0000-000000000001";
const MESSAGE = {
  id: "57d5cdf0-e145-4bca-b7fa-a7a43e8ffbb6",
  channel_id: "ce419dc5-b06e-441c-ab38-49451f87210e",
  seq: 1,
  user: "tuan",
  text: "B2, north ramp",
  created_at: "2026-08-08T13:31:09.229Z",
};

describe("subjectFor", () => {
  it("puts the environment last, as SAD §6.1's example does", () => {
    expect(subjectFor("message.created", ENV)).toBe(
      `events.msg.created.${ENV}`,
    );
  });
});

describe("messageCreatedEvent", () => {
  const build = () =>
    messageCreatedEvent({
      eventId: "8f14e45f-ceea-4f6a-9b2c-1d2e3f4a5b6c",
      environmentId: ENV,
      message: MESSAGE,
    });

  it("carries the five fields the contract promises", () => {
    const { payload } = build();
    expect(Object.keys(payload).sort()).toEqual([
      "data",
      "environment_id",
      "id",
      "occurred_at",
      "type",
    ]);
    expect(payload.type).toBe("message.created");
    expect(payload.environment_id).toBe(ENV);
    expect(payload.id).toBe("8f14e45f-ceea-4f6a-9b2c-1d2e3f4a5b6c");
  });

  it("is deterministic — the same row rebuilds to the same bytes (invariant 10)", () => {
    // The reason this holds is the reason it matters: nothing inside generates
    // an id or reads the clock. The event id arrives from the transaction that
    // wrote the row, so a republish after a crash sends the SAME deduplication
    // key rather than a fresh one — and a key that changed on retry would make
    // every consumer's dedupe useless.
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it("takes occurred_at from the message, not from the clock", () => {
    expect(build().payload.occurred_at).toBe(MESSAGE.created_at);
  });

  it("publishes the PUBLIC shape of a message, never internal identifiers", () => {
    // Consumers are customers. They get external ids and the field names the
    // REST API uses; `user_id` never crosses this boundary.
    const { payload } = build();
    expect(payload.data).toEqual(MESSAGE);
    expect(JSON.stringify(payload)).not.toContain("user_id");
    expect(JSON.stringify(payload)).not.toContain("environmentId");
  });

  it("addresses the event on the subject its environment owns", () => {
    expect(build().subject).toBe(`events.msg.created.${ENV}`);
  });

  it("refuses to build an event with no id or no environment", () => {
    // A payload missing its deduplication key is worse than no event: it looks
    // deliverable and cannot be deduplicated.
    expect(() =>
      messageCreatedEvent({
        eventId: "",
        environmentId: ENV,
        message: MESSAGE,
      }),
    ).toThrow(/event id/i);
    expect(() =>
      messageCreatedEvent({
        eventId: "abc",
        environmentId: "",
        message: MESSAGE,
      }),
    ).toThrow(/environment/i);
  });
});

describe("a legacy senderless message in the webhook payload (chapter 3.17, T054a)", () => {
  // THE ONE PATH THAT LEAVES THE PLATFORM. FR-WHK-02 delivers `message.created` to a
  // customer's own HTTPS endpoint and FR-WHK-03 retries a failed delivery for up to two
  // hours — so an event for a legacy senderless row can be delivered, and REdelivered,
  // after this chapter ships. A subscriber's parser meets it whatever the api now
  // refuses to create.
  //
  // `MessageCreatedData.user` STAYS `string | null` (T054b, FR-012a). Nothing can create
  // a new null: FR-MSG-15 requires a sender and the compiler enforces it. The type is
  // not describing what the platform emits — it describes what a subscriber may still
  // receive from a queue that was already full when the rule changed. Narrowing it to
  // `string` would be a type that says "this cannot happen" about something in flight.
  it("carries user: null rather than dropping the event", () => {
    const event = messageCreatedEvent({
      eventId: "9a0b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d",
      environmentId: ENV,
      message: { ...MESSAGE, user: null },
    });
    // `messageCreatedEvent` returns a `PendingEvent` — a subject and the envelope —
    // so the payload a subscriber parses is two levels in.
    const payload = event.payload.data;
    // NOT DROPPED, unlike the resume. The webhook's contract permits a null where
    // `messageSchema.user` (`z.string().min(1)`) does not, so the two paths differ in
    // what they can express and agree on the decision: never invent a sender.
    expect(payload.user).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("user_id");
  });
});
