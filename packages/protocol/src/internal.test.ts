import { describe, expect, it } from "vitest";

import {
  ALL_ANALYTICS_SUBJECT,
  ALL_EVENTS_SUBJECT,
  analyticsSubjectFor,
  internalUsageReportEntrySchema,
  internalUsageReportRequestSchema,
  internalUsageReportResponseSchema,
  subjectFor,
  webhookAttemptSubject,
} from "./internal.js";

// The subject grammar is ADR-02's, and a consumer that filters on a subject it
// assembled itself receives nothing the day the grammar drifts — silently. So
// the grammar is held here rather than trusted: the shape of a subject, the one
// abbreviation, the failure that must be loud, and the guarantee that whatever
// comes out is still reachable from the wildcard every consumer subscribes to.

/** `events.>` in NATS terms: everything below the prefix, at any depth. */
function matchesWildcard(subject: string, wildcard: string): boolean {
  const prefix = wildcard.replace(/>$/, "");
  return subject.startsWith(prefix) && subject.length > prefix.length;
}

describe("subjectFor builds ADR-02's `events.{domain}.{action}.{env}`", () => {
  it("puts the environment last", () => {
    expect(subjectFor("message.created", "env_123")).toBe(
      "events.msg.created.env_123",
    );
  });

  it("abbreviates `message` to `msg`, as ADR-02's own example does", () => {
    const subject = subjectFor("message.created", "env_123");
    expect(subject.split(".")[1]).toBe("msg");
  });

  it("passes a domain with no abbreviation through unchanged", () => {
    expect(subjectFor("channel.created", "env_123")).toBe(
      "events.channel.created.env_123",
    );
  });

  it("throws on a missing part instead of producing `events..created.`", () => {
    expect(() => subjectFor("", "env_123")).toThrow(/event type is required/);
    expect(() => subjectFor("message.created", "")).toThrow(
      /environment id is required/,
    );
  });

  it("produces subjects the consumer's wildcard matches", () => {
    for (const type of ["message.created", "channel.created"]) {
      expect(matchesWildcard(subjectFor(type, "env_123"), ALL_EVENTS_SUBJECT)).toBe(
        true,
      );
    }
  });
});

// The analytics grammar (chapter 3.6). Held for the same reason as the one above
// — Part 4's ingester will filter on it and does not exist yet — plus one this
// grammar has and that one does not: the environment id becomes a SUBJECT TOKEN,
// and a subject token is parsed by the broker rather than escaped by it.
describe("analyticsSubjectFor builds `analytics.{domain}.{action}.{env}`", () => {
  const ENV = "9f3c1e7a-0b2d-4c8e-9a1f-6d5b4c3a2e10";

  it("puts the environment last, as the events grammar does", () => {
    expect(analyticsSubjectFor("webhook", "attempt", ENV)).toBe(
      `analytics.webhook.attempt.${ENV}`,
    );
  });

  it("names the one action this chapter publishes", () => {
    expect(webhookAttemptSubject(ENV)).toBe(analyticsSubjectFor("webhook", "attempt", ENV));
  });

  it("produces subjects the ingester's wildcard matches", () => {
    expect(matchesWildcard(webhookAttemptSubject(ENV), ALL_ANALYTICS_SUBJECT)).toBe(
      true,
    );
  });

  it("does not collide with the events stream's wildcard", () => {
    // Two streams, two prefixes. A subject reachable from both would mean the
    // EVENTS consumers start receiving attempt records, which is the coupling
    // research R4 separated the streams to avoid.
    expect(matchesWildcard(webhookAttemptSubject(ENV), ALL_EVENTS_SUBJECT)).toBe(
      false,
    );
  });

  it("refuses an environment id that is not a uuid", () => {
    // THIS IS THE TENANT-ISOLATION CASE, not input tidiness. A subject is
    // dot-delimited and NATS reads `*` and `>` as wildcards, so a value carrying
    // either would publish one tenant's attempt records where another tenant's
    // filter can reach them — and nothing would fail at publish time.
    for (const bad of [
      "",
      "env_123",
      "not-a-uuid",
      // The dangerous three: a dot creates a deeper subject than intended, and
      // the two wildcards create a subscription rather than a destination.
      "9f3c1e7a-0b2d-4c8e-9a1f-6d5b4c3a2e10.extra",
      "*",
      ">",
    ]) {
      expect(() => analyticsSubjectFor("webhook", "attempt", bad)).toThrow(
        /environment id must be a uuid/,
      );
    }
  });

  it("throws on a missing domain or action rather than producing `analytics..`", () => {
    expect(() => analyticsSubjectFor("", "attempt", ENV)).toThrow(/domain is required/);
    expect(() => analyticsSubjectFor("webhook", "", ENV)).toThrow(/action is required/);
  });
});

describe("the usage report (chapter 3.11)", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    connection_id: "0f9c8b7a-6d5e-4c3b-8a19-8f7e6d5c4b3a",
    environment_id: "8b21c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    period: "2026-08-01",
    minutes: 17,
    ...over,
  });

  it("accepts one connection's total for one period", () => {
    const r = internalUsageReportRequestSchema.safeParse({
      connections: [entry()],
    });
    expect(r.success).toBe(true);
  });

  it("accepts two entries for one connection across a month boundary", () => {
    // The socket that was open at midnight on the first owes minutes to two
    // periods, and each is credited independently.
    const r = internalUsageReportRequestSchema.safeParse({
      connections: [entry({ minutes: 17 }), entry({ period: "2026-09-01", minutes: 3 })],
    });
    expect(r.success).toBe(true);
  });

  it("refuses a period that is not the first of a month", () => {
    // A report naming the 14th would credit a period nothing reads.
    for (const period of ["2026-08-14", "2026-08", "2026-08-01T00:00:00Z"]) {
      expect(internalUsageReportEntrySchema.safeParse(entry({ period })).success)
        .toBe(false);
    }
  });

  it("refuses a negative or fractional total", () => {
    expect(internalUsageReportEntrySchema.safeParse(entry({ minutes: -1 })).success)
      .toBe(false);
    expect(internalUsageReportEntrySchema.safeParse(entry({ minutes: 1.5 })).success)
      .toBe(false);
  });

  it("accepts zero, which is what a connection reports in its first minute", () => {
    expect(internalUsageReportEntrySchema.safeParse(entry({ minutes: 0 })).success)
      .toBe(true);
  });

  it("refuses an unknown field, like every other schema on this contract", () => {
    expect(
      internalUsageReportEntrySchema.safeParse(entry({ seconds: 60 })).success,
    ).toBe(false);
  });

  it("refuses an empty batch", () => {
    // A report with nothing in it is a bug in the caller, not a no-op worth
    // spending a transaction on.
    expect(
      internalUsageReportRequestSchema.safeParse({ connections: [] }).success,
    ).toBe(false);
  });

  it("answers with the delta actually applied, and nothing else", () => {
    expect(internalUsageReportResponseSchema.safeParse({ credited: 0 }).success)
      .toBe(true);
    expect(
      internalUsageReportResponseSchema.safeParse({ credited: 4, refused: 0 })
        .success,
    ).toBe(false);
  });
});
