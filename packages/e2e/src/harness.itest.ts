import { afterAll, describe, expect, it } from "vitest";

import { boot, type System } from "./harness.js";

// Feature 043 — the assertion that would have caught it (FR-001).
//
// Chapter 3.24's close-out battery failed 10 times in 20, every one of them a suite
// reporting `ECONNREFUSED 127.0.0.1:4100` at its first real request. The cause was one
// line: `stop()` signalled its children and slept 200 ms without waiting for them to
// go, so the next suite's api bound a port the previous one still held, died, and left
// the next suite talking to a predecessor that was itself on the way out.
//
// NOTHING COULD SEE IT, AND THAT IS THE POINT OF THIS FILE. `boot()` finishes with a
// health check, and a dying predecessor answers a health check perfectly well — every
// red run printed `api up on 4100` exactly like a green one. A test that asserts
// `boot()` returned proves nothing; the failure is one request later.
//
// So this suite boots, stops, boots again inside one file, and asks the SECOND system
// to answer a real request. Under the old teardown the second boot raced a listener
// that had not closed; under the current one it cannot, because `stop()` does not
// return until every child is gone.
//
// IT IS ALSO THE ONLY PLACE THE PORT CHANGE IS ASSERTED. `harness.ts` now spawns every
// child with `PORT=0` and reads the assignment out of the child's own `listening` line,
// so two consecutive systems get two different ports and neither is 4100. A fixed port
// would make this test pass by accident on a fast machine.

describe("the harness releases what it started", () => {
  let first: System | undefined;
  let second: System | undefined;

  afterAll(async () => {
    await first?.stop();
    await second?.stop();
  });

  it("boots, stops, and boots again — and the second system answers a request", async () => {
    first = await boot({ gateways: 1 });
    const firstUrl = first.apiUrl;
    await first.stop();
    first = undefined;

    // THE ASSERTION THAT ACTUALLY TESTS THE TEARDOWN, and the first version of this
    // file did not have it. That version booted, stopped, booted again and checked the
    // second system answered — and it passed against the OLD `stop()` too, because
    // `PORT=0` gives the second boot a different port and there is nothing left to
    // collide with. **A red probe is how that was found**: reverting the teardown and
    // re-running left the test green, so it was asserting the port change and not the
    // thing it was named for.
    //
    // What `stop()` promises is that its children are gone when it returns. Probe the
    // port the first system held: under the current teardown nothing answers, and under
    // a 200 ms sleep the api is still up for most of the five seconds it takes to drain.
    await expect(fetch(`${firstUrl}/healthz`)).rejects.toThrow();

    // NO SLEEP HERE, DELIBERATELY. A pause would hide the defect this asserts against:
    // the old teardown's whole problem was that it bought time instead of certainty.
    second = await boot({ gateways: 1 });

    // The request, not the boot. `waitForHealth` inside `boot()` has already passed —
    // it passed on every red run of chapter 3.24's battery too.
    const seeded = await second.seedConversation();
    expect(seeded.environmentId).toMatch(/^[0-9a-f-]{36}$/);

    // Two systems, two ports, neither the 4100 this lane used to hard-code.
    expect(second.apiUrl).not.toBe(firstUrl);
    expect(second.apiUrl).not.toContain(":4100");
    expect(firstUrl).not.toContain(":4100");
  }, 180_000);
});
