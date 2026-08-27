import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { subjectForChannel, type Message } from "@relay/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";
import { mintUserToken } from "../auth/user-token";

// The api as a PUBLISHER (chapter 3.18). Everything here asserts on a real Redis
// subscriber rather than on a response, because the publish is a second output
// channel and a response cannot see it — which is also why the isolation
// gauntlet, whose oracle compares response bodies, cannot grow to cover this.
describe("the api's fan-out publish", () => {
  let app: INestApplication;
  let url: string;
  let channelId: string;
  let userToken: string;
  let key: string;
  let sub: Redis;

  /** Frames seen on a subject, in arrival order. A subscriber rather than a spy:
   * what matters is what reaches the fabric, not what a mock was asked to do. */
  const seen = new Map<string, Message[]>();

  const watch = async (channel: string) => {
    seen.set(channel, []);
    await sub.subscribe(subjectForChannel(channel));
  };

  /** Wait for silence, not for a frame. A publish that has not happened yet and
   * a publish that never will look identical for the first few milliseconds, so
   * a window is the only honest assertion for a negative. */
  const quietFor = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
  };

  beforeAll(async () => {
    const db = createDb(createPool());
    const env = await createEnvironment(db, { name: "fanout-itest" });
    const repo = new Repository(db, env.id);
    const user = await repo.createUser("tuan", "Tuan");
    // Two positional arguments, not one object — and `kind: "bot"` requires a
    // `description`, which the database enforces with a check constraint
    // (chapter 3.17). An application credential may send only as a bot user.
    await repo.upsertUser("publish-bot", {
      display_name: "Publish Bot",
      kind: "bot",
      description: "sends on behalf of a customer's backend",
    });
    channelId = (await repo.createChannel("fleet", "public")).id;
    await repo.addMember(channelId, user.id);
    // `.credential`, not `.plaintext`: the secret exists outside a hash exactly
    // once, and `CreatedApiKey` names it `credential`.
    key = (await createApiKey(db, { environmentId: env.id })).credential;
    const secret = (await environmentSigningSecret(db, env.id))!.signingSecret;
    userToken = (
      await mintUserToken(secret, {
        user: "tuan",
        environmentId: env.id,
        ttlSeconds: 3600,
      })
    ).token;

    sub = new Redis(process.env["RELAY_REDIS_URL"] ?? "redis://localhost:6379");
    sub.on("error", () => {});
    sub.on("message", (subject: string, raw: string) => {
      for (const [channel, frames] of seen) {
        if (subject === subjectForChannel(channel)) {
          frames.push(JSON.parse(raw) as Message);
        }
      }
    });

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    sub.disconnect();
  });

  it("publishes nothing for a send through the INTERNAL route (FR-006, SC-003)", async () => {
    // THE GATEWAY PUBLISHES FOR THAT PATH. Two callers reach
    // `messages.service.send()` — this route and the public one — so a publish
    // placed in the service instead of the controller would put every
    // socket-sent message on every member's screen twice. This is the test that
    // catches it, and it catches it by COUNT: "one frame arrived" would be
    // satisfied by the correct behaviour and by the doubled behaviour alike.
    //
    // IT PASSES VACUOUSLY UNTIL T024 EXISTS. The publish is not written yet, so
    // nothing publishes anywhere and the answer to "what would have to be false
    // for this to fail?" is currently "everything". T026a is the run that means
    // something: it moves the publish into `messages.service.ts` and watches
    // this go red.
    await watch(channelId);
    const res = await fetch(`${url}/internal/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ channel_id: channelId, text: "over the socket" }),
    });
    expect(res.status).toBe(201);

    await quietFor(300);
    expect(seen.get(channelId)).toHaveLength(0);
  });

  it("the public route's send commits, whatever it publishes", async () => {
    // A control. If this ever fails, the suite's own plumbing is broken and no
    // conclusion below it means anything.
    const res = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        text: "over REST",
        user: "publish-bot",
        idempotency_key: randomUUID(),
      }),
    });
    expect(res.status).toBe(201);
  });
});
