import "reflect-metadata";

import { errorFrameSchema } from "@relay/protocol";
import { createLogger } from "@relay/service-kit";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";
import { LOGGER } from "./logger";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The same three promises the frameworkless skeleton made — the framework
// swap must be invisible from the wire. Overriding the LOGGER provider is
// the DI payoff: the test swaps the sink without touching the app's code.
async function boot(
  lines?: string[],
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (lines) {
    builder
      .overrideProvider(LOGGER)
      .useValue(createLogger("api", (l) => lines.push(l)));
  } else {
    builder.overrideProvider(LOGGER).useValue(createLogger("api", () => {}));
  }
  const app = (await builder.compile()).createNestApplication({
    logger: false,
  });
  await app.listen(0);
  return { app, url: await app.getUrl() };
}

describe("api skeleton", () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("answers /healthz with its shape and a fresh request id per response", async () => {
    const booted = await boot();
    app = booted.app;
    const res = await fetch(`${booted.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", service: "api" });
    expect(typeof body.uptime_s).toBe("number");

    const id1 = res.headers.get("x-request-id");
    const id2 = (await fetch(`${booted.url}/healthz`)).headers.get(
      "x-request-id",
    );
    expect(id1).toMatch(UUID_RE);
    expect(id2).toMatch(UUID_RE);
    expect(id1).not.toBe(id2);
  });

  it("shapes its 404 exactly like the protocol's error payload (EIR-API-04)", async () => {
    const booted = await boot();
    app = booted.app;
    const res = await fetch(`${booted.url}/no-such-route`);
    expect(res.status).toBe(404);
    const body: unknown = await res.json();
    // One error shape, one home: the REST envelope must parse against the
    // wire contract's error payload schema — alignment by construction.
    const parsed = errorFrameSchema.shape.payload.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.code).toBe("not_found");
  });

  it("logs exactly one structured line per request, carrying the response's id", async () => {
    const lines: string[] = [];
    const booted = await boot(lines);
    app = booted.app;
    const res = await fetch(`${booted.url}/healthz`);
    // The log line lands on the response's `finish` event — settle it.
    await new Promise((r) => setTimeout(r, 20));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      service: "api",
      msg: "request",
      path: "/healthz",
      status: 200,
    });
    expect(entry.request_id).toBe(res.headers.get("x-request-id"));
  });
});
