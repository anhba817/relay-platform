import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import {
  messageSchema,
  subjectForChannel,
  type Message,
} from "@relay/protocol";
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
  let environmentId: string;
  let sub: Redis;

  /** Frames seen on a subject, in arrival order, raw and parsed. A subscriber
   * rather than a spy: what matters is what reaches the fabric, not what a mock
   * was asked to do. Raw is kept because T018 asserts on the exact key set. */
  const seen = new Map<string, string[]>();

  const watch = async (channel: string) => {
    seen.set(channel, []);
    await sub.subscribe(subjectForChannel(channel));
  };

  /** Wait for at least `n` frames, or fail saying how many arrived. A count,
   * not a first-arrival: "one frame arrived" is satisfied by the correct
   * behaviour and by a doubled publish alike. */
  const untilRaw = async (channel: string, n: number, ms = 3_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const got = seen.get(channel) ?? [];
      if (got.length >= n) return got;
      if (Date.now() > deadline) {
        throw new Error(
          `expected ${n} frame(s) on ${subjectForChannel(channel)}, saw ${got.length}`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  const until = async (channel: string, n: number, ms = 3_000) =>
    (await untilRaw(channel, n, ms)).map((r) => JSON.parse(r) as Message);

  /** The public route, as a customer's backend calls it. `user` is required for
   * an application credential (chapter 3.17) and `idempotency_key` must be a
   * UUID on this route, where the socket frame takes any string. */
  const restSend = async (body: { text: string }, channel = channelId) =>
    fetch(`${url}/v1/channels/${channel}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        ...body,
        user: "publish-bot",
        idempotency_key: randomUUID(),
      }),
    });

  /** The frame the GATEWAY would publish for a socket send, built from the
   * internal route's response the way `session.ts:651` builds it. The gateway is
   * not running here, so this is the socket path's payload without the socket. */
  let internalResponseAsFrame: Message;

  const internalSend = async (text: string) => {
    const res = await fetch(`${url}/internal/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ channel_id: channelId, text }),
    });
    const committed = (await res.json()) as {
      id: string;
      channel_id: string;
      seq: number;
      user: string;
      text: string;
      created_at: string;
    };
    internalResponseAsFrame = {
      id: committed.id,
      channel: committed.channel_id,
      seq: committed.seq,
      user: committed.user,
      text: committed.text,
      created_at: committed.created_at,
    };
    return res;
  };

  /** A channel nobody is a member of and no socket is watching. */
  const lonelyChannel = async () => {
    const db = createDb(createPool());
    const repo = new Repository(db, environmentId);
    return repo.createChannel(`lonely-${randomUUID().slice(0, 8)}`, "public");
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
    environmentId = env.id;
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
        if (subject === subjectForChannel(channel)) frames.push(raw);
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
    expect((await restSend({ text: "over REST" })).status).toBe(201);
  });

  it("publishes a REST send to the channel's subject (FR-004)", async () => {
    // The clause this whole chapter exists for. `docs/05-sad.md:138` has drawn
    // this edge since before the api existed; nothing built it.
    await watch(channelId);
    const text = `FR-004 ${randomUUID()}`;
    expect((await restSend({ text })).status).toBe(201);

    const frames = await until(channelId, 1);
    expect(frames.map((f) => f.text)).toContain(text);
  });

  it("publishes a payload the delivery side will accept (T018)", async () => {
    // Against `messageSchema` ITSELF, not against a list of mistakes. One
    // `safeParse` covers a seventh key, `channel_id` in place of `channel`, a
    // missing `user`, a non-positive `seq` and a `created_at` that is not RFC
    // 3339 — and the far end DROPS what does not match, so any of those would
    // deliver nothing while the send still answered 201.
    await watch(channelId);
    const text = `T018 ${randomUUID()}`;
    await restSend({ text });
    const [raw] = await untilRaw(channelId, 1);

    const parsed = messageSchema.safeParse(JSON.parse(raw!));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(Object.keys(JSON.parse(raw!)).sort()).toEqual([
      "channel",
      "created_at",
      "id",
      "seq",
      "text",
      "user",
    ]);
  });

  it("publishes what a socket send publishes, field for field (FR-009, SC-008)", async () => {
    // A CLIENT CANNOT TELL WHICH ENTRANCE A MESSAGE USED. Compared field by
    // field with `id`, `seq` and `created_at` controlled — those three differ by
    // construction. Not compared byte for byte: `session.ts:45` re-serialises
    // every frame before it reaches a socket, so the api's bytes never leave the
    // gateway and FR-009 was narrowed to say so.
    //
    // The two payloads come from INDEPENDENT sends. A shared helper would move
    // both halves of the pair and the comparison would see nothing (3.17's T044).
    // THE SAME TEXT DOWN BOTH DOORS, so the only differences left are the ones
    // a send always has: a new id, a new sequence, a new timestamp — and the
    // sender, which CANNOT match by construction. An application credential may
    // speak only as a bot user (chapter 3.17) and the internal route speaks as
    // the token's person, so demanding one `user` is demanding something the
    // platform forbids. The first version of this test did exactly that and
    // failed on it.
    const text = `both doors ${randomUUID()}`;
    await watch(channelId);
    await restSend({ text });
    await internalSend(text);
    const [viaRest] = await until(channelId, 1);

    // The socket path's payload, built from the internal route's response the
    // way `session.ts:651` builds it — the gateway is not running here.
    const viaSocket = internalResponseAsFrame;

    // What a client can see: the same six keys, in a shape `messageSchema`
    // accepts, carrying the same channel and the same text.
    expect(Object.keys(viaRest!).sort()).toEqual(Object.keys(viaSocket).sort());
    expect(messageSchema.safeParse(viaRest).success).toBe(true);
    expect(messageSchema.safeParse(viaSocket).success).toBe(true);
    expect(viaRest!.channel).toBe(viaSocket.channel);
    expect(viaRest!.text).toBe(viaSocket.text);

    // And what differs, named rather than stripped: each door records its own
    // sender, and neither could record the other's.
    expect(viaRest!.user).toBe("publish-bot");
    expect(viaSocket.user).toBe("tuan");
    expect(viaRest!.id).not.toBe(viaSocket.id);
    expect(viaRest!.seq).not.toBe(viaSocket.seq);
  });

  it("publishes nothing for any refused send (SC-004)", async () => {
    // FOUR REFUSALS, and each one states what would have to be false for it to
    // fail: that the publish sits on the success path. It does — `send()` throws
    // out of `MessagesService` and the line is never reached — so a `finally`
    // is the only way to get this wrong, which is why FR-008 forbids one.
    await watch(channelId);

    // 1. A key naming a PERSON. An application credential may speak only as a
    //    bot of its tenant (chapter 3.17): 403 `sender_not_permitted`.
    const asPerson = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ text: "as a person", user: "tuan", idempotency_key: randomUUID() }),
    });
    expect(asPerson.status).toBe(403);

    // 2. A sender that does not exist at all: 400 naming `user`.
    const asNobody = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ text: "as nobody", user: "not-a-user", idempotency_key: randomUUID() }),
    });
    expect(asNobody.status).toBe(400);

    // 3. No sender named: 400, same field.
    const unattributed = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ text: "unattributed", idempotency_key: randomUUID() }),
    });
    expect(unattributed.status).toBe(400);

    // 4. An ARCHIVED channel: the send is refused after the sender resolves,
    //    which is the case a publish placed too early would get wrong.
    const doomed = (await lonelyChannel()).id;
    // `POST`, not `DELETE`. `DELETE :channelId/archive` is `unarchive` — it
    // removes the archive rather than applying it — and the first version of
    // this test used it, unarchived an open channel, got a 200, and then watched
    // the send succeed. The path reads like the verb and is not.
    const archived = await fetch(`${url}/v1/channels/${doomed}/archive`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(archived.status).toBeLessThan(300);
    await watch(doomed);
    const toArchived = await fetch(`${url}/v1/channels/${doomed}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ text: "into the archive", user: "publish-bot", idempotency_key: randomUUID() }),
    });
    expect(toArchived.status).toBeGreaterThanOrEqual(400);

    await quietFor(400);
    expect(seen.get(channelId)).toHaveLength(0);
    expect(seen.get(doomed)).toHaveLength(0);
  });

  it("publishes nothing for a FOREIGN tenant's channel (FR-008a)", async () => {
    // THE ONLY REFUSAL CONSTITUTION I CALLS NON-NEGOTIABLE, and the one no
    // existing suite can see. `POST /v1/channels/:channelId/messages` is
    // isolation target `isolation/targets.ts:185` and the gauntlet attacks it
    // with foreign ids on every build — but its oracle compares RESPONSE
    // BODIES, and its own comment says so: "nothing of the victim's came back,
    // not that a status was 4xx". A publish is a second output channel.
    //
    // So this subscribes to the VICTIM's subject and attacks with the victim's
    // channel id. A frame there would be cross-tenant exposure that every
    // response-shaped test in the repository would call green.
    const db = createDb(createPool());
    const victimEnv = await createEnvironment(db, { name: "fanout-victim" });
    const victimRepo = new Repository(db, victimEnv.id);
    const victim = await victimRepo.createUser("victim", "Victim");
    const victimChannel = (await victimRepo.createChannel("theirs", "public")).id;
    await victimRepo.addMember(victimChannel, victim.id);

    await watch(victimChannel);
    const res = await fetch(`${url}/v1/channels/${victimChannel}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ text: "not yours", user: "publish-bot", idempotency_key: randomUUID() }),
    });
    // 404, not 403: a channel of another tenant is indistinguishable from one
    // that does not exist (constitution I, and chapter 2.2's envelope).
    expect(res.status).toBe(404);

    await quietFor(400);
    expect(seen.get(victimChannel)).toHaveLength(0);
  });

  it("publishes for a channel with no connected member, and still answers 201", async () => {
    // A frame nobody is subscribed to is GONE, and that is correct rather than a
    // loss: at-most-once is ADR-07's decision and resume is the recovery.
    const lonely = (await lonelyChannel()).id;
    const res = await restSend({ text: "nobody is listening" }, lonely);
    expect(res.status).toBe(201);
    // Nothing asserted about arrival: there is no subscriber, so there is
    // nothing to arrive. What is asserted is that the send did not fail for it.
  });
});
