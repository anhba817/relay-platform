import { MEDIA_STORED_TYPE, mediaStoredRecordSchema } from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
import { describe, expect, it } from "vitest";

import type { Publisher } from "../outbox/publisher";
import { publishStorageDelta, type StorageFacts } from "./storage-event";

// FR-MED-12's PRODUCER, AND MOSTLY ITS FAILURE PATH (chapter 4.16).
//
// **THE HAPPY PATH IS DRIVEN END TO END** by `storage-metering.itest.ts`, which sends a real
// record across a real broker into a real ClickHouse. What that suite cannot produce on demand
// is a broker that refuses — and the refusal is the interesting half, because this function's
// whole design is that **a lost record is the accepted cost**: the publish happens after the
// commit and outside the transaction, so a failure here must not reach the caller, whose work
// is already committed and has nothing useful to undo.

// **VERSION AND VARIANT NIBBLES, AND THE FIRST DRAFT HAD NEITHER.** The reflex fixture
// `11111111-1111-1111-1111-111111111111` is not a valid UUID to `z.uuid()`, which enforces
// RFC 4122's version (1–8) and variant (8/9/a/b) digits — so the schema assertion below
// failed on the fixture rather than on the producer, twice over. Worth knowing that this
// platform's two validators disagree on purpose: `assertEnvironmentId` in
// `storage-reconcile.ts` takes any hex-and-dashes shape, because its job is that nothing
// unvalidated reaches a ClickHouse statement and `toUUID()` accepts those, while the wire
// schema is a contract with a reader and holds the stricter line.
const facts: StorageFacts = {
  environmentId: "11111111-1111-4111-8111-111111111111",
  mediaId: "22222222-2222-4222-9222-222222222222",
  cause: "reserved",
  kind: "image",
  bytesDelta: 4096,
  occurredAt: new Date("2026-09-30T12:00:00.000Z"),
};

const collect = () => {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    log: (level, msg, fields) => {
      lines.push({ level, msg, ...(fields === undefined ? {} : { fields }) });
    },
  };
  return { lines, logger };
};

describe("the storage delta a verdict or a slot produces", () => {
  it("publishes a record the consumer's own schema accepts", async () => {
    // THE SCHEMA, NOT A HAND-WRITTEN SHAPE. `mediaStoredRecordSchema` is what the ingester
    // parses, so asserting against it is asserting against the reader rather than against a
    // second copy of the writer's intent — which is the defect 4.5 found when three artifacts
    // agreed with each other about a payload the shipped consumer destroyed.
    const sent: unknown[] = [];
    const publisher: Publisher = {
      publish: async (m) => void sent.push(m),
      close: async () => undefined,
    };
    const { lines, logger } = collect();

    await publishStorageDelta(publisher, logger, facts);

    expect(lines).toEqual([]);
    const message = sent[0] as { subject: string; id: string; payload: unknown };
    expect(message.subject).toBe(`analytics.media.stored.${facts.environmentId}`);
    // ONE ID PER FACT, so a redelivery is deduplicated rather than counted twice — and the
    // media id ALONE would collide, because a rejection follows a reservation for the same
    // object. The cause is in the id for that reason.
    expect(message.id).toBe(`${facts.mediaId}:reserved`);
    const parsed = mediaStoredRecordSchema.safeParse(message.payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.type).toBe(MEDIA_STORED_TYPE);
    expect(parsed.data?.occurred_at).toBe("2026-09-30T12:00:00.000Z");
  });

  it("carries the sign rather than deriving it from the cause", async () => {
    // `0016` argues this in full: `stored_delta` one table over takes its sign from
    // `multiIf(event = 'created', 1, …)`, and a reader that infers the sign puts the rule in
    // a second place. A rejection's bytes come back out, and the producer says so.
    const sent: unknown[] = [];
    const publisher: Publisher = {
      publish: async (m) => void sent.push(m),
      close: async () => undefined,
    };
    const { logger } = collect();
    await publishStorageDelta(publisher, logger, {
      ...facts,
      cause: "rejected",
      bytesDelta: -4096,
    });
    const payload = (sent[0] as { payload: { event: string; bytes_delta: number } }).payload;
    expect(payload).toMatchObject({ event: "rejected", bytes_delta: -4096 });
  });

  it("logs a failed publish and does NOT rethrow, because the caller has committed", async () => {
    // **THE ARM THE COVERAGE RUN FOUND**: this file measured 66.66% statements with no pin
    // to notice, and the missing third was the `catch`. It is not a defensive branch — it is
    // the whole of what "a lost record is the accepted cost" means in code, and until this
    // test existed nothing checked that the cost was paid quietly rather than thrown at a
    // request that has already answered 201.
    const publisher: Publisher = {
      publish: async () => {
        throw new Error("no responders");
      },
      close: async () => undefined,
    };
    const { lines, logger } = collect();

    await expect(publishStorageDelta(publisher, logger, facts)).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("error");
    expect(lines[0]?.msg).toBe("storage_delta.publish_failed");
    // THE CAUSE IS NAMED IN THE LINE, because a counter of failures with no reason is a
    // number somebody stares at. The media id and the cause are both there, which is what
    // lets an operator find the object whose bytes the meter is now permanently wrong about.
    expect(lines[0]?.fields).toMatchObject({
      media_id: facts.mediaId,
      cause: "reserved",
    });
    expect(String(lines[0]?.fields?.["error"])).toContain("no responders");
  });
});
