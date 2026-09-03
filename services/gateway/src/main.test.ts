import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { CLOSE_CODES, frameSchema } from "@relay/protocol";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
      // ELEVEN from chapter 3.21's `typing.send`. The `toEqual` above is derived
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

  // CHAPTER 3.22, T042b. THE SHUTDOWN SET, NAMED EXPLICITLY AND FAILING ON AN
  // UNKNOWN MEMBER.
  //
  // Nothing verified the registration before analysis pass 6. `shutdown()` awaits
  // each module's `close()`, `main.test.ts` called `server.close()` and asserted
  // nothing about which modules closed, so a missing registration leaks one Redis
  // client per gateway — silently and for ever.
  //
  // THIS IS CHAPTER 3.21'S DEFECT INVERTED. There, awaiting `close()` made lint
  // see a used variable and hid a module that was never passed to
  // `attachSessions`. Here, NOT awaiting it is what nothing could see. The two
  // halves need two checks, and this is the second one's.
  //
  // Read from the source rather than executed: a shutdown that actually closes
  // seven Redis clients is not something a unit test can observe without seven
  // servers. What it CAN observe is that every module the file builds is also
  // closed, which is the property that breaks when somebody adds an eighth.
  it("closes every module it builds (chapter 3.22)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "main.ts"), "utf8");
    const built = [...source.matchAll(/^ {2}const (\w+) = create(\w+)\(/gm)].map(
      (m) => m[1],
    );
    // TWO NAMED EXCEPTIONS, and named rather than pattern-excluded. `createLogger`
    // returns a writer with nothing to release and `createServer` is this file's
    // own export, not a module it owns. **The first version of this test had
    // neither and went red on the logger** — which is the check working: an
    // unknown member fails instead of being quietly skipped, and adding one to
    // this list is a decision somebody has to write down.
    const NOT_CLOSEABLE = ["logger", "server"];
    const closeable = built.filter((name) => !NOT_CLOSEABLE.includes(name ?? ""));
    // Six modules today: fanout, limits, presence, membership, typing,
    // connections. A seventh arriving without a `close()` turns this red instead
    // of leaking a client per gateway.
    expect(closeable).toHaveLength(6);
    const shutdown = source.slice(source.indexOf("async function shutdown"));
    for (const name of closeable) {
      expect(
        shutdown.includes(`await ${String(name)}.close()`),
        `${String(name)} is built but never closed in shutdown()`,
      ).toBe(true);
    }
  });
});
