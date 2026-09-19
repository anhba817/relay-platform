import "reflect-metadata";

import { errorFrameSchema } from "@relay/protocol";
import { createLogger } from "@relay/service-kit";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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

  // THE PRODUCER IS OFF FOR THIS FILE, AND THE REASON IS THE ASSERTION BELOW.
  //
  // `logs exactly one structured line per request` swaps the LOGGER provider for an array,
  // so it counts EVERY line the api emits during the request — not just the access log. The
  // request-log producer added five chapters later logs its own failure through that same
  // logger, so with a broker it cannot reach there are two lines, and the test that has been
  // green since this file was written goes red for a reason it is not about.
  //
  // SET HERE AS WELL AS IN `vitest.config.mts`, AND THE TWO SAY DIFFERENT THINGS. The lane's
  // config makes the Docker-free gate Docker-free — a property of the lane, for whatever
  // boots an app in it next. This one is this file's own precondition, and it is here because
  // `vitest.coverage.config.mts` runs the same tests and does NOT set it: the coverage lane
  // needs the producer ON for the integration suites that assert on its rows. A fix that went
  // into one of those two configs and not the other is the shape chapter 4.9 paid eight
  // minutes of a coverage run to find, and this file reproduced it.
  const producer = process.env["RELAY_REQUEST_LOG"];
  beforeAll(() => {
    process.env["RELAY_REQUEST_LOG"] = "off";
  });
  afterAll(() => {
    if (producer === undefined) delete process.env["RELAY_REQUEST_LOG"];
    else process.env["RELAY_REQUEST_LOG"] = producer;
  });

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
