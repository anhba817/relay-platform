import { describe, expect, it, vi } from "vitest";

import type { ClaimResult } from "../db/repository";
import type { OutboxEvent } from "../outbox/event";
import { decideOutcome } from "./runtime";

// The decision table, Docker-free (chapter 3.4). Ten of this chapter's twelve
// invariants need a real broker and a real database to mean anything; these two
// need neither, because the decision is a pure function of what was parsed and
// what the claim reported. `decideOutcome` takes its claim as an argument for
// exactly this reason — it has no database of its own to reason about, so the
// table can be read here rather than inferred from a suite that takes a hundred
// seconds to run.
//
// What the integration lane proves is that the runtime WIRES this up to NATS
// and Postgres correctly. What this file proves is that the table it wires up
// is the right one.

const EVENT: OutboxEvent = {
  id: "8f14e45f-ceea-4f6a-9b2c-1d2e3f4a5b6c",
  type: "message.created",
  environment_id: "3f2a0000-0000-0000-0000-000000000001",
  occurred_at: "2026-08-08T13:31:09.229Z",
  data: {
    id: "57d5cdf0-e145-4bca-b7fa-a7a43e8ffbb6",
    channel_id: "ce419dc5-b06e-441c-ab38-49451f87210e",
    seq: 1,
    user: "tuan",
    text: "B2, north ramp",
    created_at: "2026-08-08T13:31:09.229Z",
  },
};

/** A claim that wins the ledger row: it runs the effect inside itself and
 * reports "handled" — `claimEvent`'s successful path, without the transaction
 * it would need a database for. A throwing effect propagates, which is how the
 * real one rolls the claim back. */
function winsTheRow(): (effect: () => Promise<void>) => Promise<ClaimResult> {
  return async (effect) => {
    await effect();
    return "handled";
  };
}

/** A claim that loses it: somebody already handled this event, so the effect is
 * never run and the result is "duplicate" (`ON CONFLICT DO NOTHING`). */
function losesTheRow(): (effect: () => Promise<void>) => Promise<ClaimResult> {
  return async () => "duplicate";
}

describe("decideOutcome", () => {
  it("invariant 10: a handler that throws is retried, never acknowledged", async () => {
    // Not acknowledging IS the request for redelivery — the runtime has no
    // other way to ask. Acknowledging here would lose the event permanently,
    // because the claim rolled back with the handler and no ledger row records
    // that it was ever handled.
    const outcome = await decideOutcome({
      parsed: EVENT,
      claim: winsTheRow(),
      handler: async () => {
        throw new Error("the customer's endpoint was down");
      },
    });

    expect(outcome).toBe("retry");
  });

  it("invariant 11: a duplicate claim is acknowledged, not handled again", async () => {
    // The event genuinely has been handled — by a previous delivery to this
    // same consumer that crashed after committing, which is chapter 3.4's whole
    // subject. Acknowledging is correct precisely BECAUSE the handler did not
    // run: the effect is already durable, and running it twice is the failure
    // SAD risk R5 names (double webhooks, double metering).
    const handler = vi.fn(async () => {});

    const outcome = await decideOutcome({
      parsed: EVENT,
      claim: losesTheRow(),
      handler,
    });

    expect(outcome).toBe("acknowledge");
    expect(handler).not.toHaveBeenCalled();
  });

  it("terminates an unparseable payload instead of retrying it", async () => {
    // The same bytes fail the same way every time. Retrying spends five
    // delivery attempts and an acknowledgement deadline each to reach the
    // conclusion available on the first.
    const outcome = await decideOutcome({
      parsed: null,
      claim: winsTheRow(),
      handler: async () => {},
    });

    expect(outcome).toBe("terminate");
  });

  it("never lets an unparseable payload reach the claim or the handler", async () => {
    // A poison message must not write a ledger row. If it did, the event id
    // would be marked handled and a later fix to the schema could never replay
    // it — terminated is recoverable, falsely claimed is not.
    const claim = vi.fn(winsTheRow());
    const handler = vi.fn(async () => {});

    await decideOutcome({ parsed: null, claim, handler });

    expect(claim).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("acknowledges an event whose claim and handler both succeed", async () => {
    const handler = vi.fn(async () => {});

    const outcome = await decideOutcome({
      parsed: EVENT,
      claim: winsTheRow(),
      handler,
    });

    expect(outcome).toBe("acknowledge");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("runs the handler INSIDE the claim, so the two share a fate", async () => {
    // The ordering is the mechanism, not an implementation detail: the ledger
    // row and the effect commit together or not at all. A handler invoked
    // outside the claim would leave a claim behind when it threw, and the
    // redelivery would be waved through as a duplicate — an event silently
    // never handled, which is worse than one handled twice.
    const order: string[] = [];
    const claim = async (effect: () => Promise<void>): Promise<ClaimResult> => {
      order.push("claim:start");
      await effect();
      order.push("claim:end");
      return "handled";
    };

    await decideOutcome({
      parsed: EVENT,
      claim,
      handler: async () => {
        order.push("handler");
      },
    });

    expect(order).toEqual(["claim:start", "handler", "claim:end"]);
  });

  it("passes the broker's delivery count to the handler", async () => {
    // A handler may LOG the attempt. The context is the only way it can see
    // one, and chapter 3.4's recorder puts it in the log line.
    const handler = vi.fn(async () => {});

    await decideOutcome({
      parsed: EVENT,
      attempt: 3,
      claim: winsTheRow(),
      handler,
    });

    expect(handler).toHaveBeenCalledWith(EVENT, { attempt: 3 });
  });

  it("treats a delivery with no stated attempt as the first one", async () => {
    const handler = vi.fn(async () => {});

    await decideOutcome({ parsed: EVENT, claim: winsTheRow(), handler });

    expect(handler).toHaveBeenCalledWith(EVENT, { attempt: 1 });
  });
});
