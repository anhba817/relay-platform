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
      expect(body.protocol.frames).toHaveLength(10);
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
