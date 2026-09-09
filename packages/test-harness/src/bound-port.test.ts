import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// EVERY SERVICE A TEST CAN SPAWN MUST REPORT THE PORT IT BOUND.
//
// `PORT=0` is how a spawned service avoids the fixed-port collisions this repository
// spent four suites removing. It only works if the child says which port it got, and
// a child that logs the value it was PASSED prints `0`.
//
// The api has read the bound address back since the isolation harness. The gateway
// did not, for eleven chapters, and nothing said so — every suite that spawned a
// gateway handed it a fixed port, so the logged value was the value passed in and
// correct by accident. The e2e journey found it the moment it asked: `api up on
// 37763`, then `gateway 1 never became healthy`, which is a health probe against
// port zero.
//
// WHY SOURCE-READING AND NOT A RUNNING PROBE. `main.ts` is excluded from coverage
// (`**/main.ts`) because it is reached by running the service rather than asserting
// on it, and a test that spawns both services to check one log line costs more than
// the whole unit lane. What has to be true is a property of the source: the port
// logged is derived from `address()` and not from the environment.

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Every service with a `main.ts` a test could spawn. Derived, not listed: a new
 * service added under `services/` arrives here without anyone remembering. */
function serviceMains(): string[] {
  return readdirSync(join(ROOT, "services"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join("services", e.name, "src", "main.ts"))
    .filter((p) => existsSync(join(ROOT, p)));
}

/** A SERVICE THAT BINDS NOTHING, DECLARED BY NAME.
 *
 * The derivation above found the dispatcher the moment it arrived, which is what it is
 * for — and then asserted a property the dispatcher cannot have. It is not a server: no
 * `listen`, no `createServer`, no `PORT`. It consumes a stream and posts to the api, and
 * a test that spawns it probes nothing.
 *
 * DECLARED RATHER THAN FILTERED OUT BY A PATTERN, and asserted in BOTH directions
 * below. A `.filter()` on the derivation would silently absorb the next service that
 * forgets to read its address back; an entry here that starts listening fails too. That
 * is the driver-exemption lesson this repository has already paid for once: a list
 * checked one way can only grow, and a stale entry holds a standing exemption over a
 * file that no longer needs one. */
const BINDS_NOTHING: ReadonlyArray<readonly [string, string]> = [
  [
    "services/dispatcher/src/main.ts",
    "a stream consumer with no inbound surface: it fetches from JetStream and posts to " +
      "the api over the internal seam, so there is no port for a test to be handed",
  ],
];

const LISTENERS = serviceMains().filter(
  (rel) => !BINDS_NOTHING.some(([name]) => name === rel),
);

describe("a spawned service reports the port it bound", () => {
  it("finds a main.ts for more than one service", () => {
    // A derivation that finds one file passes vacuously for the other.
    expect(serviceMains().length).toBeGreaterThan(1);
  });

  it("declares every service that binds nothing, and no others", () => {
    // BOTH DIRECTIONS. An exempted file that has started listening is the failure this
    // half catches, and it is the half a `.filter()` cannot have: the entry would go on
    // excusing a service that now needs the assertion.
    for (const [rel, why] of BINDS_NOTHING) {
      expect(serviceMains(), `${rel} is declared here and is not a service`).toContain(rel);
      expect(why.length, `${rel} is exempted with no reason`).toBeGreaterThan(20);
      const text = readFileSync(join(ROOT, rel), "utf8");
      expect(text, `${rel} binds a port now and must not be exempt`).not.toMatch(
        /\.listen\(|createServer\(|process\.env(?:\.PORT|\["PORT"\])/,
      );
    }
    // And the exemption cannot swallow the suite: something still has to be asserted.
    expect(LISTENERS.length, "every service is exempt").toBeGreaterThan(1);
  });

  it.each(LISTENERS)("%s reads the bound address back", (rel) => {
    const text = readFileSync(join(ROOT, rel), "utf8");
    expect(text, `${rel} never calls address()`).toMatch(/\.address\(\)/);
  });

  it.each(LISTENERS)("%s does not log the port it asked for", (rel) => {
    const text = readFileSync(join(ROOT, rel), "utf8");
    // THE FAILURE THIS CATCHES, written as the pattern that caused it:
    //   const port = Number(process.env.PORT ?? 4001);
    //   ... logger.log("info", "listening", { port });
    // The name bound directly from the environment must not be the one logged. Both
    // services call it `requested` now, which is the convention this asserts.
    const fromEnv = /const\s+(\w+)\s*=\s*Number\(process\.env(?:\.PORT|\["PORT"\])/.exec(text);
    expect(fromEnv, `${rel} does not read PORT the way this test reads it`).not.toBeNull();
    const name = fromEnv![1]!;
    expect(name, `${rel} logs ${name}, read straight from the environment`)
      .not.toBe("port");
  });
});
