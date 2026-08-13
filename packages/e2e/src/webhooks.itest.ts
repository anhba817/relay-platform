import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { boot, type System } from "./harness.js";

// Invariant 14, first half (chapter 3.5): with the dispatcher absent, end users
// are served exactly as before.
//
// This is the journey that shows what the service split BOUGHT. Inside the api,
// "webhooks do not delay end users" would be a claim about event loops and
// connection pools — something you argue for. Across a process boundary it is a
// claim about processes, and you settle it by not starting one.
//
// The dispatcher is never started in this file. It does not exist for the
// duration, and the platform is expected not to notice.
//
// THE OTHER HALF — that a dispatcher starting later drains the backlog — lives
// in the dispatcher's own suite, which can start and stop one. Asserting it here
// would mean this journey managing a service the harness does not own, and a
// journey that boots half a platform to prove something a unit of it can prove
// is a slower test with a weaker claim.

const require_ = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A customer's server. Nothing should reach it while the dispatcher is absent,
 * and that silence is the assertion. */
function customerEndpoint() {
  const received: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      received.push(body);
      res.writeHead(200).end("ok");
    });
  });
  return {
    received,
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, () => {
          const addr = server.address();
          resolve(
            `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
          );
        }),
      ),
    close: () => server.close(),
  };
}

function apiInternals() {
  const dist = join(REPO, "services", "api", "dist");
  const client = require_(join(dist, "db", "client.js")) as {
    createDb: (p: unknown) => unknown;
    createPool: () => unknown;
  };
  const seeder = require_(join(dist, "db", "repository.js")) as {
    Repository: new (
      db: unknown,
      env: string,
    ) => {
      createEndpoint: (i: {
        url: string;
        eventTypes: string[];
        secretCiphertext: string;
      }) => Promise<{ id: string }>;
    };
  };
  const secrets = require_(join(dist, "webhooks", "secret.js")) as {
    encryptSecret: (s: string) => string;
    mintSigningSecret: () => string;
  };
  return { db: client.createDb(client.createPool()), seeder, secrets };
}

describe("journey: webhooks never stand between the platform and its users", () => {
  let system: System;
  let endpoint: ReturnType<typeof customerEndpoint>;
  let endpointUrl: string;

  beforeAll(async () => {
    endpoint = customerEndpoint();
    endpointUrl = await endpoint.listen();
    // No dispatcher. The api and one gateway come up; nothing consumes
    // deliveries, and nothing is supposed to need to.
    system = await boot({ gateways: 1 });
  }, 120_000);

  afterAll(async () => {
    await system?.stop();
    endpoint?.close();
  });

  it("invariant 14: an end user is served while the dispatcher does not exist", async () => {
    // `dispatcher` here is the FLEET DISPATCHER — a person, from chapter 2.8's
    // cast — not this chapter's service. Renamed locally, because a file about
    // the webhook dispatcher that also has a variable called `dispatcher`
    // meaning something else is a trap for whoever reads it next.
    const {
      environmentId,
      channel,
      dispatcher: fleetDispatcher,
      tuan,
    } = await system.seedConversation();

    // The clients are constructed, not connected — the journey connects them to
    // the gateways it wants them on.
    await fleetDispatcher.connect(system.gateways[0]!);
    await tuan.connect(system.gateways[0]!);

    // A configured endpoint, so there IS webhook work for the absent service to
    // be failing to do. Seeded through the repository on purpose: this journey
    // is about the delivery path, and the management surface has its own suite.
    const { db, seeder, secrets } = apiInternals();
    const repo = new seeder.Repository(db, environmentId);
    await repo.createEndpoint({
      url: `${endpointUrl}/hook`,
      eventTypes: ["message.created"],
      secretCiphertext: secrets.encryptSecret(secrets.mintSigningSecret()),
    });

    const text = `north ramp ${randomUUID().slice(0, 6)}`;
    fleetDispatcher.send(channel, text);

    // The whole assertion: message delivery does not consult the webhook path,
    // does not wait for it, and does not care that the service which would run
    // it was never started.
    await tuan.waitFor(
      (frame) =>
        frame.type === "message.created" &&
        (frame.payload as { text?: string }).text === text,
      `tuan hears "${text}" with no dispatcher running`,
      15_000,
    );

    expect(tuan.timeline(channel).some((m) => m.text === text)).toBe(true);

    // And the customer's endpoint heard nothing, because nothing is dispatching.
    // If this ever fails, some other process is delivering webhooks and every
    // other assertion in this file is measuring the wrong thing.
    expect(endpoint.received).toHaveLength(0);
  }, 60_000);
});
