import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import {
  channelsReferencingMediaIn,
  createApiKey,
  createEnvironment,
  Repository,
} from "../db/repository";
import { DEFAULT_FANOUT_REDIS_URL } from "../fanout/publisher";
import { ensureBucket, storeConfig } from "./store";

// FR-MED-07's SECOND SENTENCE: a placeholder resolves without polling.
//
// **THE FRAME IS READ OFF THE FABRIC, NOT OFF A SOCKET.** What this chapter builds in
// the api is a producer; the gateway's half — routing the third arm to a client — is
// `session.ts`'s switch and its own suite. Subscribing to `revision:{channel}` here
// asserts the thing the api is responsible for, and asserting it one layer further out
// would make every failure ambiguous between the two services.
//
// **AND IT ASSERTS SILENCE AS WELL AS ARRIVAL.** Three of these tests are about a frame
// that must NOT be published. A quiet window is taken only after a positive control has
// arrived on the same subscription, never instead of one: absence is not a condition and
// a flat sleep before an assertion is a bet that the lane is idle.
describe("a media transition reaches every channel that references the object", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let env: { id: string };
  let key: { credential: string };
  let repo: Repository;
  let sub: Redis;
  const store = storeConfig();
  // THE PREFIX IS PART OF THE CREDENTIAL, NOT DECORATION. `authenticate.middleware.ts`
  // routes on `rk_svc_` before it compares anything, so a value without it is refused
  // with the same 401 an UNSET variable produces — the two are indistinguishable from
  // the caller, which is 4.9's finding about what an unset credential costs.
  const WORKER = "rk_svc_media_updated_itest_0123456789abcdef";
  const frames: { subject: string; body: Record<string, unknown> }[] = [];
  /** A well-formed `ready` verdict. The schema wants both verified facts, and a body
   * missing one answers 400 at the door — which reads exactly like the route refusing
   * the verdict rather than refusing the request. */
  const READY = { verdict: "ready", verified_bytes: 1024, verified_type: "image/png" };

  const slot = async (): Promise<string> => {
    const res = await fetch(`${url}/v1/media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ filename: "p.png", mime_type: "image/png", bytes: 1024 }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { media_id: string }).media_id;
  };

  const send = async (channelId: string, mediaId: string): Promise<string> => {
    const res = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user: "verdict-bot",
        text: "a photo",
        attachments: [{ type: "media", media_id: mediaId }],
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  /** The worker's seam. `recordMediaVerdict` is what it calls; this drives the ROUTE,
   * because the producer hangs off the route's own `applied` and a test that called the
   * function directly would prove nothing about the thing under test. */
  const verdict = (mediaId: string, body: Record<string, unknown>) =>
    fetch(`${url}/internal/media/${mediaId}/verdict`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${WORKER}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  /** Poll to a deadline for what must arrive. */
  const awaitFrames = async (n: number, ms = 3000): Promise<typeof frames> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && frames.length < n) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return frames;
  };

  beforeAll(async () => {
    // THE WORKER'S CREDENTIAL, SET BEFORE THE APP IS BUILT. Unset, every verdict
    // answers 401 and the producer under test is never reached — 4.9 measured what an
    // unset internal credential costs when nothing asserts it: three gauntlet attacks
    // returned at their first line and reported green, at 0ms each. `media-verdict.itest.ts`
    // sets the same two and this suite follows it rather than inheriting an environment.
    process.env["RELAY_INTERNAL_CREDENTIAL_WORKER"] = WORKER;

    await ensureBucket(store);
    db = createDb(createPool());
    env = await createEnvironment(db, { name: "media-updated-itest" });
    key = await createApiKey(db, { environmentId: env.id });
    repo = new Repository(db, env.id);
    await repo.upsertUser("verdict-bot", {
      display_name: "Verdict Bot",
      kind: "bot",
      description: "drives media verdicts in an integration test",
    });

    sub = new Redis(process.env["RELAY_FANOUT_REDIS_URL"] ?? DEFAULT_FANOUT_REDIS_URL);
    sub.on("error", () => {});
    await sub.psubscribe("revision:*");
    sub.on("pmessage", (_p, subject, raw) => {
      frames.push({ subject, body: JSON.parse(raw) as Record<string, unknown> });
    });

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await sub?.quit();
  });

  // T030e. THE CONTROL FOR ANALYSIS PASS 4's CRITICAL. `MESSAGE_PUBLISHER` is declared
  // by `MessagesModule` and not exported; without `InternalModule` declaring its own,
  // this route answers `Nest can't resolve dependencies` on its FIRST request — after
  // lint, typecheck and every unit test pass. Only a running app asks that question.
  it("the verdict route resolves its dependencies at all", async () => {
    const res = await verdict("b61bfdfb-b42e-4e95-a1ed-2bedd3a4ed21", READY);
    expect([200, 404, 422]).toContain(res.status);
    expect(res.status, "a 500 here is a wiring failure, not a verdict").not.toBe(500);
  });

  // T034
  it("publishes one frame naming the object and its new state", async () => {
    const channel = await repo.createChannel(`one-${Date.now()}`, "public");
    const id = await slot();
    await send(channel.id, id);
    frames.length = 0;

    const res = await verdict(id, {
      verdict: "ready",
      verified_bytes: 1024,
      verified_type: "image/png",
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const got = await awaitFrames(1);
    expect(got).toHaveLength(1);
    expect(got[0]!.subject).toBe(`revision:${channel.id}`);
    expect(got[0]!.body).toEqual({
      kind: "media",
      media_id: id,
      channel: channel.id,
      state: "ready",
    });
  });

  // T035
  it("publishes `rejected`, and carries no reason with it", async () => {
    const channel = await repo.createChannel(`rej-${Date.now()}`, "public");
    const id = await slot();
    await send(channel.id, id);
    frames.length = 0;

    expect((await verdict(id, { verdict: "rejected", reason: "scan_failed" })).status).toBe(200);

    const got = await awaitFrames(1);
    expect(got).toHaveLength(1);
    expect(got[0]!.body["state"]).toBe("rejected");
    // FR-010. The cause is a closed set of two and this fabric reaches every subscriber
    // of the channel; FR-MED-06's three refusals are byte-identical for the same reason.
    expect(got[0]!.body).not.toHaveProperty("reason");
  });

  // T036 / SC-003 at N = 2. 44 objects on the development lane are referenced from two
  // channels — forwarding is the ordinary way an object acquires a second reference.
  it("publishes once per referencing channel when an object is in two", async () => {
    const a = await repo.createChannel(`two-a-${Date.now()}`, "public");
    const b = await repo.createChannel(`two-b-${Date.now()}`, "public");
    const id = await slot();
    await send(a.id, id);
    await send(b.id, id);
    expect(await channelsReferencingMediaIn(db, env.id, id)).toHaveLength(2);
    frames.length = 0;

    expect((await verdict(id, READY)).status).toBe(200);

    const got = await awaitFrames(2);
    expect(got).toHaveLength(2);
    expect(new Set(got.map((f) => f.subject))).toEqual(
      new Set([`revision:${a.id}`, `revision:${b.id}`]),
    );
  });

  // T039a. One object, two messages, ONE channel. `selectDistinct` over channels is what
  // makes this one frame; a client rendering per message finds its own by media id.
  it("publishes once when one channel holds two messages for the object", async () => {
    const channel = await repo.createChannel(`dup-${Date.now()}`, "public");
    const id = await slot();
    await send(channel.id, id);
    await send(channel.id, id);
    frames.length = 0;

    expect((await verdict(id, READY)).status).toBe(200);

    const got = await awaitFrames(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(frames).toHaveLength(1);
    expect(got[0]!.subject).toBe(`revision:${channel.id}`);
  });

  // T037 / FR-006. THE COMMON CASE: 4,725 of the lane's 5,403 objects are referenced by
  // nothing. The verdict must succeed and announce nothing.
  it("announces nothing for an object nobody attached, and the verdict still succeeds", async () => {
    const id = await slot();
    frames.length = 0;

    expect((await verdict(id, READY)).status).toBe(200);

    // A POSITIVE CONTROL FIRST, so the quiet window is evidence rather than a bet on an
    // idle lane: a second object that IS attached must arrive on the same subscription.
    const channel = await repo.createChannel(`ctl-${Date.now()}`, "public");
    const control = await slot();
    await send(channel.id, control);
    expect((await verdict(control, READY)).status).toBe(200);
    await awaitFrames(1);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.body["media_id"]).toBe(control);
  });

  // T038 / FR-005 / SC-005. The event follows the state change, not the request.
  it("announces nothing on a duplicate verdict", async () => {
    const channel = await repo.createChannel(`dupv-${Date.now()}`, "public");
    const id = await slot();
    await send(channel.id, id);

    expect((await verdict(id, READY)).status).toBe(200);
    await awaitFrames(1);
    frames.length = 0;

    // A SECOND `ready` FOR A `ready` OBJECT IS AN ORDINARY RETRY and answers 200 — the
    // compare-and-set updates no rows and says so. What must not happen is a frame.
    expect((await verdict(id, READY)).status).toBe(200);

    const control = await slot();
    await send(channel.id, control);
    expect((await verdict(control, READY)).status).toBe(200);
    await awaitFrames(1);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.body["media_id"]).toBe(control);
  });

  // T039 / FR-011. NO CODE WAS WRITTEN FOR THIS. FR-MED-10's unlink already empties the
  // array — 2,867 tombstoned messages on the lane carry zero attachments — so a
  // tombstone cannot match the containment predicate. The test exists because the
  // property is invisible in the types and one UPDATE that forgot to clear attachments
  // would break this path and 4.12's delivery gate at the same time.
  it("does not count a tombstoned message's channel", async () => {
    const channel = await repo.createChannel(`tomb-${Date.now()}`, "public");
    const id = await slot();
    const messageId = await send(channel.id, id);
    expect(await channelsReferencingMediaIn(db, env.id, id)).toHaveLength(1);

    await repo.deleteMessage(channel.id, messageId, {});
    expect(await channelsReferencingMediaIn(db, env.id, id)).toHaveLength(0);
  });

  // T030b. The arm T046's per-arm probe will try to delete. 4.12 measured that removing
  // a media tenancy scope turns nothing red unless a test asks this exact question.
  it("returns nothing for the right object under the wrong tenant", async () => {
    const channel = await repo.createChannel(`scope-${Date.now()}`, "public");
    const id = await slot();
    await send(channel.id, id);

    expect(await channelsReferencingMediaIn(db, env.id, id)).toHaveLength(1);
    const other = await createEnvironment(db, { name: "media-updated-itest-other" });
    expect(await channelsReferencingMediaIn(db, other.id, id)).toHaveLength(0);
  });
});
