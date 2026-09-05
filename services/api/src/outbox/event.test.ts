import { describe, expect, it } from "vitest";

import {
  membershipEvent,
  messageCreatedEvent,
  messageDeletedEvent,
  messageUpdatedEvent,
  OUTBOX_EVENT_TYPES,
  outboxEventSchema,
  subjectFor,
} from "./event";

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
  // Chapter 3.24. TWO, because FR-006 says order holds on every path that returns a
  // message and a consumer's webhook is one — a single-attachment fixture could not see
  // an order at all.
  attachments: [
    { type: "url" as const, kind: "image" as const, url: "https://example.test/one.png" },
    { type: "url" as const, kind: "audio" as const, url: "https://example.test/two.mp3" },
  ],
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

// Chapter 3.20. The second and third event types FR-WHK-02 names, and the boundary
// that decides what a customer's webhook can contain.

const MEMBERSHIP = {
  channel_id: "ce419dc5-b06e-441c-ab38-49451f87210e",
  user: "tuan",
};

/** A tombstone as a consumer receives it (chapter 3.23). No `text` key — that is
 * FR-020, and `strictObject` refuses one. */
const DELETED = {
  id: MESSAGE.id,
  channel_id: MESSAGE.channel_id,
  seq: MESSAGE.seq,
  user: MESSAGE.user,
  deleted_at: "2026-09-03T09:15:00.000Z",
};

describe("the outbox event type set", () => {
  // ASSERTED AS A SET AND AS A COUNT, which is chapter 3.19's `codes.test.ts`
  // precedent: either alone lets a fourth type arrive unnoticed. FR-WHK-02 names
  // eight and FIVE exist since chapter 3.23; the other three arrive with the features
  // that can produce them.
  //
  // THE ORDER IS THE ARRAY'S, and the two new names sit beside `message.created`
  // rather than at the end — they are the same domain, and `toEqual` on an array is
  // order-sensitive, so this assertion is also a claim about how the source reads.
  it("is exactly the five types that have producers", () => {
    expect([...OUTBOX_EVENT_TYPES]).toEqual([
      "message.created",
      "message.updated",
      "message.deleted",
      "channel.member_added",
      "channel.member_removed",
    ]);
    expect(OUTBOX_EVENT_TYPES).toHaveLength(5);
  });

  it("gives every type a subject without a mapping entry", () => {
    // `subjectFor` abbreviates a domain only when DOMAIN_ABBREVIATION has it, so
    // `channel` passes through unchanged. Checked rather than assumed: a type whose
    // subject form is not its dotted name would need an entry, and the absence of a
    // failure here is what says these two do not.
    expect(subjectFor("channel.member_added", ENV)).toBe(
      `events.channel.member_added.${ENV}`,
    );
    expect(subjectFor("channel.member_removed", ENV)).toBe(
      `events.channel.member_removed.${ENV}`,
    );
  });
});

describe("messageUpdatedEvent and messageDeletedEvent (chapter 3.23)", () => {
  /** A creation built HERE, because `build` two describes up is out of scope — and the
   * comparison below needs both events from one place to mean anything. */
  const created = () =>
    messageCreatedEvent({
      eventId: "8f14e45f-ceea-4f6a-9b2c-1d2e3f4a5b6c",
      environmentId: ENV,
      message: MESSAGE,
    });

  const updated = () =>
    messageUpdatedEvent({
      eventId: "9c26f1a2-0000-4000-8000-000000000003",
      environmentId: ENV,
      occurredAt: "2026-09-03T09:15:00.000Z",
      message: MESSAGE,
    });
  const deleted = () =>
    messageDeletedEvent({
      eventId: "9c26f1a2-0000-4000-8000-000000000004",
      environmentId: ENV,
      occurredAt: "2026-09-03T09:15:00.000Z",
      message: DELETED,
    });

  it("spells both types as FR-WHK-02 spells them", () => {
    expect(updated().payload.type).toBe("message.updated");
    expect(deleted().payload.type).toBe("message.deleted");
    expect(updated().subject).toBe(`events.msg.updated.${ENV}`);
    expect(deleted().subject).toBe(`events.msg.deleted.${ENV}`);
  });

  it("leaves the edit's payload identical to a creation's (FR-008a, FR-015 (3.24))", () => {
    // FR-008a in one assertion: *"The message payload used by creation and edit events
    // MUST be left unchanged."* Compared as SETS, so a field added to one and not the
    // other fails here rather than in a customer's consumer.
    //
    // SEVEN SINCE CHAPTER 3.24, and both events gained the field together because both
    // are built from one `MessageCreatedData` — which is FR-015 as a type rather than a
    // promise.
    expect(Object.keys(updated().payload.data).sort()).toEqual([
      "attachments",
      "channel_id",
      "created_at",
      "id",
      "seq",
      "text",
      "user",
    ]);
    // AND THE TWO SETS ARE THE SAME SET, which is what FR-015 actually asks. Comparing
    // each against a literal leaves them free to drift together.
    expect(Object.keys(updated().payload.data).sort()).toEqual(
      Object.keys(created().payload.data).sort(),
    );
  });

  it("carries the attachments themselves, in order, on both (T057, FR-006 (3.24))", () => {
    // KEY SETS CANNOT SEE VALUES. Two payloads both carrying `[]` have identical key
    // sets, so the set comparison above answers FR-015's "one shape" and says nothing
    // about FR-006's "in the order they were submitted" — which holds on every path that
    // returns a message, and a consumer's webhook is one.
    const expected = ["https://example.test/one.png", "https://example.test/two.mp3"];
    for (const [label, event] of [
      ["created", created()],
      ["updated", updated()],
    ] as const) {
      const data = event.payload.data as { attachments: Array<{ url: string }> };
      expect(data.attachments.map((a) => a.url), label).toEqual(expected);
    }
  });

  it("gives the deletion NO text key at all (FR-020)", () => {
    // NOT `text: null` — a key that can hold the words somebody asked to have removed
    // is a key somebody can forget to null. The exact set is the assertion.
    const keys = Object.keys(deleted().payload.data).sort();
    expect(keys).toEqual(["channel_id", "deleted_at", "id", "seq", "user"]);
    expect(keys).not.toContain("text");
  });

  it("carries the edit's own instant, not the message's created_at", () => {
    // The one place the edit event diverges from the creation event, and it has to: an
    // event whose `occurred_at` predates the previous event about the same message
    // cannot be ordered by a consumer.
    expect(updated().payload.occurred_at).toBe("2026-09-03T09:15:00.000Z");
    expect(updated().payload.occurred_at).not.toBe(MESSAGE.created_at);
  });

  it("refuses an event with no id and an event with no environment", () => {
    // Refused rather than defaulted, like every other builder here: an event with no
    // deduplication key looks deliverable and cannot be deduplicated.
    for (const build of [messageUpdatedEvent, messageDeletedEvent]) {
      expect(() =>
        // @ts-expect-error the point of the test
        build({ eventId: "", environmentId: ENV, occurredAt: "x", message: MESSAGE }),
      ).toThrow("event id");
      expect(() =>
        // @ts-expect-error the point of the test
        build({ eventId: "id", environmentId: "", occurredAt: "x", message: MESSAGE }),
      ).toThrow("environment id");
    }
  });

  it("round-trips both through the consumer's schema", () => {
    // The producer and the consumer are two shapes of one contract. Without this, the
    // union branches added in this chapter would be checked only against fixtures this
    // file writes — and `consumer/runtime.ts` answers a failed parse with
    // `message.term()`, which stops redelivery for good.
    expect(outboxEventSchema.safeParse(updated().payload).success).toBe(true);
    expect(outboxEventSchema.safeParse(deleted().payload).success).toBe(true);
  });

  it("refuses a deletion that carries a text, through the consumer's schema", () => {
    const withText = {
      ...deleted().payload,
      data: { ...DELETED, text: "should not be here" },
    };
    expect(outboxEventSchema.safeParse(withText).success).toBe(false);
  });
});

describe("membershipEvent", () => {
  const build = (change: "added" | "removed") =>
    membershipEvent({
      eventId: "9c26f1a2-0000-4000-8000-000000000001",
      environmentId: ENV,
      change,
      occurredAt: "2026-08-30T09:15:00.000Z",
      membership: MEMBERSHIP,
    });

  it("spells the type as FR-WHK-02 spells it, per direction", () => {
    expect(build("added").payload.type).toBe("channel.member_added");
    expect(build("removed").payload.type).toBe("channel.member_removed");
  });

  it("puts the direction in the TYPE and not in a field", () => {
    // The wire frame carries `change`; this does not. A customer subscribing to
    // removals selects one type and receives nothing else, which is what FR-WHK-02
    // spelling two names rather than one buys.
    expect(Object.keys(build("added").payload.data).sort()).toEqual([
      "channel_id",
      "user",
    ]);
  });

  it("carries the same five envelope fields the message event does", () => {
    const { payload } = build("removed");
    expect(Object.keys(payload).sort()).toEqual([
      "data",
      "environment_id",
      "id",
      "occurred_at",
      "type",
    ]);
  });

  it("takes occurred_at from the caller, never from the clock", () => {
    // A republished event must be byte-identical to its first attempt: the
    // deduplication key a consumer sees after a crash is the one it would have
    // seen without one.
    expect(build("added").payload.occurred_at).toBe("2026-08-30T09:15:00.000Z");
  });

  it("refuses a missing event id, environment id, or external id", () => {
    const ok = {
      eventId: "9c26f1a2-0000-4000-8000-000000000001",
      environmentId: ENV,
      change: "added" as const,
      occurredAt: "2026-08-30T09:15:00.000Z",
      membership: MEMBERSHIP,
    };
    expect(() => membershipEvent({ ...ok, eventId: "" })).toThrow(/event id/);
    expect(() => membershipEvent({ ...ok, environmentId: "" })).toThrow(
      /environment id/,
    );
    // THE THIRD REFUSAL IS THIS CHAPTER'S. An absent external id is refused for the
    // reason the other two are — a defaulted one is undetectable — and for one more:
    // the repository methods that build this event hold `users.id`, and a type alone
    // cannot stop `String(user.id)` being handed over.
    expect(() =>
      membershipEvent({ ...ok, membership: { ...MEMBERSHIP, user: "" } }),
    ).toThrow(/external id/);
  });

  it("carries an external id where a customer reads one, never a uuid", () => {
    // `MessageCreatedData` fixes this boundary in its own comment and this event
    // sits behind the same one. A uuid here is invisible until a customer opens
    // their webhook payload, which is why the shape is asserted rather than trusted.
    const { payload } = build("removed");
    const data = payload.data as { user: string };
    expect(data.user).toBe("tuan");
    expect(data.user).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe("outboxEventSchema — what a CONSUMER will accept", () => {
  const envelope = {
    id: "9c26f1a2-0000-4000-8000-000000000001",
    environment_id: ENV,
    occurred_at: "2026-08-30T09:15:00.000Z",
  };

  // THE TEST THIS CHAPTER EXISTS TO HAVE WRITTEN. Until it was, the schema was
  // `z.literal("message.created")` and the consumer answers a failed parse with
  // `message.term()` — redelivery stopped for good. Every membership event would
  // have been destroyed there, in a lane that runs the consumer switched off.
  it("accepts every type the producer can build", () => {
    // A LOOKUP RATHER THAN A TERNARY, because chapter 3.23 made the shapes three: a
    // creation and an edit carry a `Message` (FR-008a), a deletion carries an identity
    // with no text (FR-020), and a membership change carries neither. The ternary's
    // `else` branch would have handed the membership shape to `message.deleted` and
    // reported a schema failure as though the schema were wrong.
    const dataFor: Record<(typeof OUTBOX_EVENT_TYPES)[number], unknown> = {
      "message.created": MESSAGE,
      "message.updated": MESSAGE,
      "message.deleted": DELETED,
      "channel.member_added": { channel_id: MEMBERSHIP.channel_id, user: MEMBERSHIP.user },
      "channel.member_removed": { channel_id: MEMBERSHIP.channel_id, user: MEMBERSHIP.user },
    };
    for (const type of OUTBOX_EVENT_TYPES) {
      const result = outboxEventSchema.safeParse({
        ...envelope,
        type,
        data: dataFor[type],
      });
      expect(result.success, `${type} must parse`).toBe(true);
    }
  });

  it("round-trips what membershipEvent produces", () => {
    // The producer and the consumer are two shapes of one contract, and only a
    // test that hands one to the other checks that they agree.
    for (const change of ["added", "removed"] as const) {
      const { payload } = membershipEvent({
        eventId: "9c26f1a2-0000-4000-8000-000000000002",
        environmentId: ENV,
        change,
        occurredAt: "2026-08-30T09:15:00.000Z",
        membership: MEMBERSHIP,
      });
      expect(outboxEventSchema.safeParse(payload).success).toBe(true);
    }
  });

  it("still rejects an unknown type and a mismatched data shape", () => {
    // The union widened; it did not become permissive. A type nothing produces is
    // still terminated, which is the behaviour the consumer's comment describes.
    expect(
      outboxEventSchema.safeParse({ ...envelope, type: "user.connected", data: {} })
        .success,
    ).toBe(false);
    // And a membership envelope carrying message data is refused, which is what
    // `discriminatedUnion` buys over a loosened `type`.
    expect(
      outboxEventSchema.safeParse({
        ...envelope,
        type: "channel.member_added",
        data: MESSAGE,
      }).success,
    ).toBe(false);
  });
});
