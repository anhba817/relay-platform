import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  /** `const x = createY({` — the fabrics, derived rather than listed, so a fifth
   * arrives here without anyone remembering. */
  function built(): string[] {
    return [...SOURCE.matchAll(/\bconst (\w+) = create[A-Z]\w*\(\{/g)].map((m) => m[1]!);
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
    expect(built().length, "no `const x = createY({` found in main.ts").toBeGreaterThan(1);
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
