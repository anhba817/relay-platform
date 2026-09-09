import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { CLOSE_CODES, frameSchema } from "@relay/protocol";

import { describe, expect, it } from "vitest";

import { createLogger } from "@relay/service-kit";

import { createServer } from "./main.js";

const silent = createLogger("gateway", () => {});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, () => resolve((server.address() as AddressInfo).port)),
  );
}

describe("gateway skeleton", () => {
  it("advertises exactly the vocabulary @relay/protocol exports", async () => {
    const server = createServer(silent);
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        service: string;
        protocol: { frames: string[]; close_codes: number[] };
      };
      expect(body.status).toBe("ok");
      expect(body.service).toBe("gateway");
      // Computed from the package on both sides of this assertion — but one
      // side travelled over HTTP: the advertisement matches the contract.
      const expectedFrames = frameSchema.options.map((o) => o.shape.type.value);
      expect(body.protocol.frames).toEqual(expectedFrames);
      expect(body.protocol.frames).toContain("connection.ack");
      // ELEVEN from the typing chapter's `typing.send`. The `toEqual` above is derived
      // on both sides and needed nothing; this line is the second of the two
      // hard-coded frame counts in the repository, and the only one no task
      // owned until analysis pass 17. It failed here in the UNIT lane, which
      // `test:integration` does not run and no phase gate ran until pass 18.
      expect(body.protocol.frames).toHaveLength(11);
      expect(body.protocol.close_codes).toEqual(
        Object.keys(CLOSE_CODES).map(Number),
      );
    } finally {
      server.close();
    }
  });

  it("carries a request id and answers unknown routes with the shared 404 shape", async () => {
    const server = createServer(silent);
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/socket-someday`);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-request-id")).toBeTruthy();
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("not_found");
      expect(typeof body.docs_url).toBe("string");
    } finally {
      server.close();
    }
  });

  // T042b. THE SHUTDOWN SET, NAMED EXPLICITLY AND FAILING ON AN
  // UNKNOWN MEMBER.
  //
  // Nothing verified the registration before analysis pass 6. `shutdown()` awaits
  // each module's `close()`, `main.test.ts` called `server.close()` and asserted
  // nothing about which modules closed, so a missing registration leaks one Redis
  // client per gateway — silently and for ever.
  //
  // THIS IS THE TYPING CHAPTER'S DEFECT INVERTED. There, awaiting `close()` made lint
  // see a used variable and hid a module that was never passed to
  // `attachSessions`. Here, NOT awaiting it is what nothing could see. The two
  // halves need two checks, and this is the second one's.
  //
  // Read from the source rather than executed: a shutdown that actually closes
  // seven Redis clients is not something a unit test can observe without seven
  // servers. What it CAN observe is that every module the file builds is also
  // closed, which is the property that breaks when somebody adds an eighth.
  // THE OTHER HALF OF THE PAIR BELOW, and neither substitutes for the other: a
  // module that is built and never injected is inert, and one that is built and
  // never closed leaks a Redis client per gateway. Same derivation, two properties.
  it("closes every module it builds", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "main.ts"), "utf8");
    const built = [...source.matchAll(/^ {2}const (\w+) = create(\w+)\(/gm)].map(
      (m) => m[1],
    );
    // TWO NAMED EXCEPTIONS, and named rather than pattern-excluded. `createLogger`
    // returns a writer with nothing to release and `createServer` is this file's
    // own export, not a module it owns. **The first version of this test had
    // neither and went red on the logger** — which is the check working: an unknown
    // member fails instead of being quietly skipped, and adding one to this list is
    // a decision somebody has to write down.
    const NOT_CLOSEABLE = ["logger", "server"];
    const closeable = built.filter((name) => !NOT_CLOSEABLE.includes(name ?? ""));
    // A POSITIVE CONTROL RATHER THAN A COUNT. The published version of this test
    // asserted `toHaveLength(6)`, which is a number every later chapter that adds a
    // module has to edit — and a number edited on every change is a number nobody
    // reads. The loop below is the assertion; this line only says the derivation
    // found something to loop over.
    expect(closeable.length, "no `const x = createY(` found in main.ts").toBeGreaterThan(1);
    // DERIVED, NOT NAMED. The closing site is wherever this file registers one —
    // `server.on("close", …)` here — and reading the whole source rather than a
    // named function means a refactor that moves the calls cannot silently pass.
    for (const name of closeable) {
      expect(
        new RegExp(`(void |await )${String(name)}\\.close\\(\\)`).test(source),
        `${String(name)} is built but never closed`,
      ).toBe(true);
    }
  });
});

describe("every fabric createServer builds is injected", () => {
  // A MODULE BUILT, CLOSED, AND NEVER PASSED IN IS INERT AND GREEN.
  //
  // `signalTyping` calls `typing?.publish(...)`. If `typing` never reaches
  // `attachSessions`, the optional chain makes every signal a silent no-op — and
  // nothing fails, because `close()` is awaited in the shutdown path so lint sees a
  // used variable, `/healthz` still advertises the frame, the seam still accepts
  // `typing.send`, and **every test injects the option directly rather than reading
  // it from here**. The feature is dead in the product and passing everywhere.
  //
  // That happened to `typing` in the order this book was first written and was found
  // by the sealed client, which is eleven chapters away. Four fabrics are wired this
  // way now and the fifth will be added by somebody working from the fourth.
  //
  // SOURCE-READING, for `bound-port.test.ts`'s reason: `main.ts` is excluded from
  // coverage because it is reached by running the service, and what has to be true is
  // a property of the text — every module built above the call appears inside it.
  const SOURCE = readFileSync(
    join(import.meta.dirname, "main.ts"),
    "utf8",
  );

  /** `const x = createY(` — the fabrics, derived rather than listed, so a sixth
   * arrives here without anyone remembering.
   *
   * TWO CHANGES, AND THE FIRST ONE MISSED A MODULE. The pattern required an OBJECT
   * ARGUMENT — `create[A-Z]\w*\(\{` — and the counter store takes none:
   * `createGatewayLimits()` reads its url from the environment. So the ninth Redis
   * client in this file was invisible to the check written to make exactly that
   * impossible, and it was invisible in the direction that passes. Measured: the old
   * pattern derives five names, the new one six.
   *
   * SCOPED TO `createServer`'S BODY, which is what this describe's title always
   * claimed. Dropping the `{` widens the match to `createLogger` and `createServer`
   * in the `import.meta.main` block below the function — neither a fabric, both
   * `const x = createY(`. Slicing to the text between the function and the call it
   * has to appear in is the honest boundary; an exclusion list would be the thing
   * this file exists instead of. */
  function built(): string[] {
    const start = SOURCE.indexOf("export function createServer");
    const end = SOURCE.indexOf("attachSessions({", start);
    return [...SOURCE.slice(start, end).matchAll(/\bconst (\w+) = create[A-Z]\w*\(/g)]
      .map((m) => m[1]!);
  }

  /** The object literal `attachSessions` is called with. */
  function injected(): string {
    const open = SOURCE.indexOf("attachSessions({");
    const close = SOURCE.indexOf("\n  });", open);
    return SOURCE.slice(open, close);
  }

  it("derives the fabrics and the call, and finds both", () => {
    // THE POSITIVE CONTROL. Every assertion below is about which names are missing,
    // and a derivation that found nothing satisfies all of them.
    expect(built().length, "no `const x = createY(` found in main.ts").toBeGreaterThan(1);
    // AND THE COUNT, because "more than one" was satisfied by a pattern that found
    // five of six. A number here goes red when a fabric is added without a thought
    // about this file, which is the moment to have it.
    expect(built(), "the fabrics createServer builds").toEqual([
      "fanout",
      "presence",
      "membership",
      "typing",
      "connections",
      "limits",
    ]);
    expect(injected(), "no attachSessions call found").toContain("server,");
  });

  it("passes each one into attachSessions", () => {
    const call = injected();
    const missing = built().filter(
      (name) =>
        !new RegExp(`^\\s*${name}\\s*(,|:)`, "m").test(call),
    );
    expect(
      missing,
      `built by createServer and never injected: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
