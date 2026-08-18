import { describe, expect, it } from "vitest";

import { createLogger, type Logger } from "@relay/service-kit";

import type { PublishedMessage, Publisher } from "../outbox/publisher";
import { publishAttempt, type AttemptRecord } from "./analytics";

// The attempt record's SHAPE and its SILENCE (chapter 3.6).
//
// Two claims are worth a unit test, and both are about what the payload is not.
// FR-004 says an attempt record carries identifiers, statuses and durations and
// nothing else; contract invariant 4 says a publish failure changes nothing for
// the caller. Neither needs a broker to check, and a test that needed one would be
// a test nobody runs while writing the code.

/** Captures what was handed to the broker, without being one. */
function recorder(): Publisher & { sent: PublishedMessage[] } {
  const sent: PublishedMessage[] = [];
  return {
    sent,
    async publish(message) {
      sent.push(message);
    },
    async close() {},
  };
}

function exploding(error = new Error("nats: no responders")): Publisher {
  return {
    async publish() {
      throw error;
    },
    async close() {},
  };
}

/** The sink receives one JSON STRING per line, so it is parsed back rather than
 * inspected as an object — which also proves the fields survive serialisation,
 * the only form anybody reads a log line in. */
function captured(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger("analytics-test", (line) => {
    lines.push(JSON.parse(String(line)) as Record<string, unknown>);
  });
  return { logger, lines };
}

const ENV = "9f3c1e7a-0b2d-4c8e-9a1f-6d5b4c3a2e10";

const base: AttemptRecord = {
  deliveryId: "1c2d3e4f-0000-4000-8000-000000000001",
  endpointId: "1c2d3e4f-0000-4000-8000-000000000002",
  environmentId: ENV,
  eventId: "1c2d3e4f-0000-4000-8000-000000000003",
  attempt: 3,
  status: 503,
  latencyMs: 214,
  outcome: "rescheduled",
  attemptedAt: new Date("2026-08-18T09:14:22.481Z"),
};

const silent = createLogger("analytics-test", () => {});

describe("publishAttempt shapes the event contracts/attempts.md describes", () => {
  it("carries the four identifiers, the attempt, the status, the latency and the outcome", async () => {
    const publisher = recorder();
    await publishAttempt(publisher, silent, base);

    expect(publisher.sent).toHaveLength(1);
    expect(publisher.sent[0]!.payload).toEqual({
      delivery_id: base.deliveryId,
      endpoint_id: base.endpointId,
      environment_id: ENV,
      event_id: base.eventId,
      attempt: 3,
      attempted_at: "2026-08-18T09:14:22.481Z",
      status: 503,
      latency_ms: 214,
      outcome: "rescheduled",
    });
  });

  it("puts the environment on the subject as well as in the payload", async () => {
    // Invariant 2. The subject is how a future consumer filters by tenant, and a
    // subject disagreeing with its payload would route one environment's records
    // under another's filter.
    const publisher = recorder();
    await publishAttempt(publisher, silent, base);

    const { subject, payload } = publisher.sent[0]!;
    expect(subject).toBe(`analytics.webhook.attempt.${ENV}`);
    expect(subject.endsWith((payload as { environment_id: string }).environment_id)).toBe(
      true,
    );
  });

  it("deduplicates on the delivery AND the attempt, not the delivery alone", async () => {
    // Chapter 3.5's bug, in the one place it could recur. The delivery id is
    // stable across all seven attempts, so a `msgID` of the delivery alone would
    // let the broker collapse attempts 2 through 7 into the first — and every
    // dashboard built on this stream would show one attempt per failing delivery
    // for ever, with no error anywhere.
    const publisher = recorder();
    await publishAttempt(publisher, silent, { ...base, attempt: 1 });
    await publishAttempt(publisher, silent, { ...base, attempt: 2 });

    const ids = publisher.sent.map((m) => m.id);
    expect(ids).toEqual([`${base.deliveryId}:1`, `${base.deliveryId}:2`]);
    expect(new Set(ids).size).toBe(2);
  });

  it("omits `status` entirely when nothing answered, rather than sending a zero", async () => {
    // A timeout has no status. Sending 0 or 599 would be a number a dashboard
    // could average, and the average would be a fiction.
    const publisher = recorder();
    // Built by omission rather than by setting `status: undefined`, because
    // `exactOptionalPropertyTypes` makes those two different things and only one of
    // them is what a timeout looks like.
    const timedOut: AttemptRecord = { ...base };
    delete timedOut.status;
    await publishAttempt(publisher, silent, {
      ...timedOut,
      error: "timeout after 10000ms",
      latencyMs: 10_000,
    });

    const payload = publisher.sent[0]!.payload as Record<string, unknown>;
    expect("status" in payload).toBe(false);
    expect(payload["error"]).toBe("timeout after 10000ms");
    // The latency of a timeout IS the timeout, and it is still reported: "how
    // long did we wait" is a real question even when "what did they say" has no
    // answer.
    expect(payload["latency_ms"]).toBe(10_000);
  });

  it("omits `error` when there was a status", async () => {
    const publisher = recorder();
    await publishAttempt(publisher, silent, base);
    expect("error" in (publisher.sent[0]!.payload as object)).toBe(false);
  });

  it("carries no payload, secret, signature or header — whatever it is handed", async () => {
    // FR-004 and SC-006, and the reason this asserts on EXTRA fields rather than
    // on the ones it expects: the risk is not that a field goes missing, it is
    // that one is added. `shape` names every key it copies, so a caller that
    // decorates the record with a secret cannot leak it onto a stream with
    // seven-day retention. A spread would have.
    const publisher = recorder();
    await publishAttempt(publisher, silent, {
      ...base,
      // Everything a careless future caller might attach. None of it is on the
      // interface, hence the cast — a compile error is the FIRST line of defence
      // and this test is the second.
      ...({
        payload: { text: "B2, north ramp" },
        secret: "whsec_do_not_publish_this",
        signature: "v1=deadbeef",
        headers: { authorization: "Bearer rk_live_xxx" },
        url: "https://customer.example/hook",
      } as unknown as AttemptRecord),
    });

    const payload = publisher.sent[0]!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "attempt",
      "attempted_at",
      "delivery_id",
      "endpoint_id",
      "environment_id",
      "event_id",
      "latency_ms",
      "outcome",
      "status",
    ]);
    const serialised = JSON.stringify(publisher.sent[0]);
    for (const forbidden of [
      "B2, north ramp",
      "whsec_do_not_publish_this",
      "v1=deadbeef",
      "Bearer",
      "customer.example",
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe("publishAttempt swallows its own failure (contract invariant 4)", () => {
  it("does not throw when the broker refuses", async () => {
    // THE ONE THAT MATTERS. The caller has already committed an outcome, and the
    // dispatcher is waiting for an answer. If this threw, an analytics outage
    // would become a 500 on the dispatch seam, the dispatcher would not
    // acknowledge, and the delivery would be posted to the customer again — a
    // duplicate webhook caused by a metering pipeline. Constitution III names
    // that inversion as a design failure.
    const { logger, lines } = captured();
    await expect(
      publishAttempt(exploding(), logger, base),
    ).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    expect(lines[0]!["msg"]).toBe("analytics.attempt_publish_failed");
    expect(lines[0]!["delivery_id"]).toBe(base.deliveryId);
    expect(lines[0]!["attempt"]).toBe(3);
  });

  it("logs the failure without the payload it was carrying", async () => {
    const { logger, lines } = captured();
    await publishAttempt(exploding(), logger, {
      ...base,
      ...({ payload: { text: "B2, north ramp" } } as unknown as AttemptRecord),
    });

    // A log line about a failed publish is the most tempting place in the
    // codebase to dump the thing that failed to publish.
    expect(JSON.stringify(lines)).not.toContain("B2, north ramp");
  });
});
