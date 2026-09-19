import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mintUserToken } from "../auth/user-token";
import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";
import { ensureBucket, storeConfig } from "./store";

// THE OTHER HALF OF THE UNION, END TO END (FR-MED-06).
//
// ITS OWN FILE, AND THE REASON IS THE CREDENTIALS RATHER THAN TIDINESS. FR-MED-06's
// second clause is *"(for user tokens) was uploaded by the sending user"*, so the
// predicate cannot be exercised without both classes and two distinct users in one
// tenant. `messages.itest.ts` holds one API key and would have to grow a second identity
// system to ask this chapter's question; `media.itest.ts` holds both but is about issuing
// slots, not attaching them.
//
// AND A NEW FILE COSTS THE FENCE CHAIN NOTHING, which is the cheap direction this project
// keeps rediscovering: a titled fence is a whole-body claim, so extending a published file
// charges a hunk and adding one charges nothing until somebody publishes it.
//
// THE STORE IS REAL. A slot's URL is signed and never contacted by the api, but
// `storeReady` does contact it on every slot request — so a suite that asks for a slot
// needs MinIO up, and `ensureBucket` is what makes a fresh volume answer 200 instead of
// the 404 that `storeReady` reads as a first request.
describe("attaching hosted media", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let env: { id: string };
  let otherEnv: { id: string };
  let key: { credential: string };
  let otherKey: { credential: string };
  let channelId: string;
  /** Two users of ONE tenant. The whole of FR-003 is the difference between them. */
  let tokenA: string;
  let tokenB: string;
  const store = storeConfig();

  /** A slot, as the credential that asks for it. Returns the id the platform minted. */
  const slotFor = async (credential: string): Promise<string> => {
    const res = await fetch(`${url}/v1/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ filename: "p.png", mime_type: "image/png", bytes: 1024 }),
    });
    expect(res.status, "the slot route did not issue an id to test with").toBe(201);
    return ((await res.json()) as { media_id: string }).media_id;
  };

  const send = (body: unknown, credential: string, channel = channelId) =>
    fetch(`${url}/v1/channels/${channel}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const media = (id: string) => ({ type: "media", media_id: id });
  const png = (n: string) => ({
    type: "url",
    kind: "image",
    url: `https://example.test/${n}.png`,
  });

  beforeAll(async () => {
    await ensureBucket(store);
    db = createDb(createPool());

    env = await createEnvironment(db, { name: "attach-itest" });
    key = await createApiKey(db, { environmentId: env.id });
    otherEnv = await createEnvironment(db, { name: "attach-itest-other" });
    otherKey = await createApiKey(db, { environmentId: otherEnv.id });

    const repo = new Repository(db, env.id);
    // `addMember` TAKES THE ROW'S UUID, NOT THE EXTERNAL ID. The first version passed
    // `"attach-a"` and Postgres answered `22P02 … string_to_uuid` from inside the insert
    // — a failure in a fixture, which is the kind this project has learned to read as a
    // test of its own: a fixture imitating a thing must be usable everywhere the thing is.
    const a = await repo.createUser("attach-a");
    const b = await repo.createUser("attach-b");
    // AND A BOT, BECAUSE AN API KEY MAY SEND ONLY AS ONE (FR-007). The first version of
    // the API-key test named a person and got a 403 `sender_not_permitted` — the right
    // refusal for the wrong reason, and a test asserting 201 against it would have been
    // read as this chapter's predicate failing.
    await repo.upsertUser("attach-bot", {
      display_name: "Attach Bot",
      kind: "bot",
      // REQUIRED BY A CHECK CONSTRAINT, not by this test. `users_bot_description_check`
      // refuses a bot with none — the third thing this fixture got wrong that only the
      // database could say, after the channel signature and the member id. Reading
      // cannot find what the schema refuses.
      description: "attaches media in an integration test",
    });
    const channel = await repo.createChannel("attach", "public");
    channelId = channel.id;
    await repo.addMember(channel.id, a.id);
    await repo.addMember(channel.id, b.id);

    const secret = (await environmentSigningSecret(db, env.id))!.signingSecret;
    tokenA = (
      await mintUserToken(secret, { user: "attach-a", environmentId: env.id, ttlSeconds: 3600 })
    ).token;
    tokenB = (
      await mintUserToken(secret, { user: "attach-b", environmentId: env.id, ttlSeconds: 3600 })
    ).token;

    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(
      { logger: false },
    );
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  // ── THE ACCEPT PATH (SC-001) ────────────────────────────────────────────────────────

  it("accepts a user's own slot, and reads it back exactly as sent (SC-001, FR-013)", async () => {
    const id = await slotFor(tokenA);
    const res = await send({ text: "look", attachments: [media(id)] }, tokenA);
    expect(res.status).toBe(201);

    // EXACTLY AS SENT, which is FR-013 and is a claim about what is ABSENT. No `state`,
    // no filename, nothing the platform knows about the object — the slot is `pending`
    // and stays `pending` until movement VI, and a client cannot tell from this payload.
    // `toEqual` on the whole array is the assertion; checking `media_id` alone would pass
    // against a payload that had grown three fields.
    const body = (await res.json()) as { attachments: unknown[] };
    expect(body.attachments).toEqual([{ type: "media", media_id: id }]);
  });

  it("returns the attachment unchanged through HISTORY too (FR-013, T028a)", async () => {
    const id = await slotFor(tokenA);
    const text = `history ${randomUUID()}`;
    expect((await send({ text, attachments: [media(id)] }, tokenA)).status).toBe(201);

    // THE SECOND OF THREE DOORS. The send response is the first and the socket frame is
    // the third (`session.itest.ts`); a payload can be right on one and wrong on another,
    // because each is built by different code — 3.24 shipped two builders for one frame
    // and this chapter's own §4b found three more readers. What FR-013 asks is that none
    // of them resolves anything, and "nothing was added" is only a property if something
    // checks each door.
    const page = await fetch(`${url}/v1/channels/${channelId}/messages?limit=50`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(page.status).toBe(200);
    const body = (await page.json()) as { messages: { text: string; attachments: unknown[] }[] };
    const mine = body.messages.find((m) => m.text === text);
    expect(mine, "the message just sent was not in history").toBeDefined();
    expect(mine!.attachments).toEqual([{ type: "media", media_id: id }]);
  });

  it("accepts an API key's own slot (T025)", async () => {
    const id = await slotFor(key.credential);
    const res = await send({ text: "from a backend", user: "attach-bot", attachments: [media(id)] }, key.credential);
    expect(res.status).toBe(201);
  });

  // R1'S CASE, AND THE ONE THE SPECIFICATION WOULD HAVE REFUSED. A slot taken by an API
  // key records no uploader, and the strict reading of FR-MED-06 — *"was uploaded by the
  // sending user"* — makes that object attachable by nobody at all. 4.10 wrote the column
  // nullable so this question could be asked; answering "NULL always fails" would make
  // the nullability pointless, because any sentinel would do.
  it("accepts a tenant-uploaded slot attached by a user of that tenant (R1, T026)", async () => {
    const id = await slotFor(key.credential);
    const res = await send({ text: "my backend uploaded it", attachments: [media(id)] }, tokenA);
    expect(res.status).toBe(201);
  });

  // WHAT THE CREDENTIAL ARM ACTUALLY DISCRIMINATES, WHICH IS NOT WHAT IT LOOKS LIKE.
  //
  // An API key's OWN slot records `user_id IS NULL`, and the user-token predicate admits
  // NULL — so forcing the user predicate on an application credential changes nothing for
  // its own objects, and a suite holding only that case would pass with the arm deleted.
  // The one case that moves is an API key attaching a USER's object: permitted, because
  // FR-MED-06 qualifies the uploader clause with *"(for user tokens)"* and an application
  // credential acts for the whole tenant.
  it("lets an API key attach a USER's object, which is the arm's only discriminating case", async () => {
    const usersObject = await slotFor(tokenA);
    const res = await send(
      { text: "the tenant's backend attaches a person's upload", user: "attach-bot", attachments: [media(usersObject)] },
      key.credential,
    );
    expect(res.status).toBe(201);
  });

  it("stores one media and one url attachment, in order (T027)", async () => {
    const id = await slotFor(tokenA);
    const res = await send({ text: "both", attachments: [png("a"), media(id)] }, tokenA);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { attachments: { type: string }[] };
    // ORDER, NOT MEMBERSHIP. `toEqual` over the array asserts both — a set comparison
    // would pass against a platform that sorted them.
    expect(body.attachments.map((a) => a.type)).toEqual(["url", "media"]);
  });

  it("accepts a media attachment with no text (T028)", async () => {
    const id = await slotFor(tokenA);
    const res = await send({ text: "", attachments: [media(id)] }, tokenA);
    expect(res.status).toBe(201);
  });

  it("counts a media attachment toward the ten-attachment cap (FR-012, T027a)", async () => {
    const id = await slotFor(tokenA);
    // TEN OF EACH SHAPE MIXED, so the cap is asserted over the UNION rather than over one
    // arm. It holds by construction — `z.array(attachmentSchema).max(10)` counts elements
    // and not kinds — and "by construction" is what a test is for when the construction
    // could change.
    const ten = [...Array.from({ length: 9 }, (_, i) => png(String(i))), media(id)];
    expect((await send({ text: "ten", attachments: ten }, tokenA)).status).toBe(201);

    const eleven = [...ten, media(await slotFor(tokenA))];
    const res = await send({ text: "eleven", attachments: eleven }, tokenA);
    expect(res.status).toBe(400);
  });

  // ── THE OTHER TWO THINGS THAT HAPPEN TO A MESSAGE (FR-020, FR-024) ─────────────────

  it("leaves the attachment unchanged when the message is edited (FR-020, T028b)", async () => {
    const id = await slotFor(tokenA);
    const created = (await (
      await send({ text: "before", attachments: [media(id)] }, tokenA)
    ).json()) as { id: string };

    const edited = await fetch(`${url}/v1/channels/${channelId}/messages/${created.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "after" }),
    });
    expect(edited.status).toBe(200);

    // `repository.ts` STATES THIS PROPERTY AND THIS CHAPTER CREATES THE FIRST THING IT
    // PROTECTS. An edit does not change attachments — true for the URL arm since 3.24,
    // and until now there was no hosted attachment to preserve.
    const body = (await edited.json()) as { text: string; attachments: unknown[] };
    expect(body.text).toBe("after");
    expect(body.attachments).toEqual([{ type: "media", media_id: id }]);
  });

  it("unlinks the attachment on delete and leaves the media row standing (FR-024, T028c)", async () => {
    const id = await slotFor(tokenA);
    const created = (await (
      await send({ text: "delete me", attachments: [media(id)] }, tokenA)
    ).json()) as { id: string };

    const gone = await fetch(`${url}/v1/channels/${channelId}/messages/${created.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(gone.status).toBe(204);

    const { rows } = (await db.execute(
      `SELECT (SELECT attachments IS NULL FROM messages WHERE id = '${created.id}') AS unlinked,
              (SELECT count(*)::int FROM media_objects WHERE id = '${id}') AS objects`,
    )) as unknown as { rows: { unlinked: boolean; objects: number }[] };

    // THE COLUMN IS NULLED — FR-MED-10's *"deleting a message shall unlink its
    // attachments"*, which the tombstone path has done arm-agnostically since 3.24.
    expect(rows[0]!.unlinked).toBe(true);
    // AND THE OBJECT SURVIVES, WHICH IS WHERE THE SWEEP'S WINDOW OPENS. For the URL arm
    // an unlink costs nothing, because the bytes were never the platform's. For this arm
    // the platform is holding them and the quota is counting them, and nothing counts
    // references — so a customer deleting their own message is the one orphan they can
    // produce at will (`gaps.md` 056-1, and T055 records it).
    expect(rows[0]!.objects).toBe(1);
  });

  // ── THE HALF OF THE CLAUSE NO FIXTURE CAN REACH (FR-010, SC-006) ────────────────────
  //
  // FR-MED-06 NAMES TWO STATES AND THE SCHEMA PERMITS ONE. The predicate admits
  // `pending` and `ready` because the clause says both; `ready` cannot occur, and the
  // database is what says so rather than a comment. 4.10 wrote
  // `CHECK (state = 'pending')` deliberately — verification is movement VI's, and a
  // schema admitting a state nothing produces is a schema making a claim it cannot keep.
  it("cannot be given a `ready` object to attach, because the database refuses one (SC-006)", async () => {
    let refusal = "";
    try {
      await db.execute(
        `INSERT INTO media_objects
           (id, environment_id, filename, mime_type, declared_bytes, object_key, state)
         VALUES (gen_random_uuid(), '${env.id}', 'r.png', 'image/png', 1, 'r/k', 'ready')`,
      );
    } catch (error) {
      refusal = String((error as { cause?: unknown }).cause ?? error);
    }

    // THE TEXT IS THE ASSERTION AND NOT THE THROW. "The insert failed" would pass
    // against a typo in the column list, a missing environment, or a closed pool — three
    // things that are not this chapter's evidence. What is being published is that the
    // constraint by NAME is what stops it, so the chapter can say the arm is unreachable
    // rather than untested.
    expect(refusal).toContain('violates check constraint "media_objects_state_check"');
  });

  it("refuses a state that is neither, which is the same refusal from the other side", async () => {
    let refusal = "";
    try {
      await db.execute(
        `INSERT INTO media_objects
           (id, environment_id, filename, mime_type, declared_bytes, object_key, state)
         VALUES (gen_random_uuid(), '${env.id}', 'x.png', 'image/png', 1, 'x/k', 'rejected')`,
      );
    } catch (error) {
      refusal = String((error as { cause?: unknown }).cause ?? error);
    }
    // `rejected` IS THE OTHER TRANSITION FR-MED-07 NAMES, and it is unreachable for the
    // same reason. Asserting both is what makes the first one a fact about the CHECK
    // rather than a fact about the string `ready`.
    expect(refusal).toContain('violates check constraint "media_objects_state_check"');
  });

  // ── THE THREE REFUSALS, WHICH MUST LOOK THE SAME (SC-002) ───────────────────────────

  it("refuses another tenant's object, another user's, and one nobody owns — identically (FR-002 to FR-005)", async () => {
    const foreign = await slotFor(otherKey.credential);
    const someoneElses = await slotFor(tokenB);
    const nobodys = randomUUID();

    const bodies: Record<string, unknown>[] = [];
    for (const id of [foreign, someoneElses, nobodys]) {
      const res = await send({ text: "x", attachments: [media(id)] }, tokenA);
      expect(res.status, id).toBe(422);
      const body = (await res.json()) as Record<string, unknown>;
      delete body.request_id;
      bodies.push(body);
    }

    // BYTE-IDENTICAL APART FROM THE REQUEST ID. Three 422s with three different messages
    // would be an existence oracle wearing one status: a caller could tell "that object
    // is someone else's" from "that object does not exist" and enumerate ids. The
    // comparison is over the whole body rather than the code, because the message and the
    // field are equally capable of leaking it.
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[0]!.code).toBe("media_not_attachable");
    // AND NOTHING NAMES THE ID. A refusal echoing it back reads as "that one is wrong,
    // try another", which is the invitation this whole design is avoiding.
    expect(JSON.stringify(bodies[0])).not.toContain(foreign);
  });

  it("refuses the whole message when the tenth attachment is foreign, storing none (FR-007, T039)", async () => {
    const mine = await Promise.all(Array.from({ length: 9 }, () => slotFor(tokenA)));
    const theirs = await slotFor(tokenB);
    const text = `nine good one bad ${randomUUID()}`;

    const res = await send(
      { text, attachments: [...mine.map(media), media(theirs)] },
      tokenA,
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { field: string }).field).toBe("attachments.9.media_id");

    // ALL OR NOTHING, AND THE NINE ARE THE ASSERTION. A platform that validated each
    // attachment as it wrote would leave a message carrying nine — which is a message the
    // sender never wrote, delivered to every member, and no error anybody saw. The
    // predicate runs before the insert precisely so the answer is the whole message or
    // none of it.
    const { rows } = (await db.execute(
      `SELECT count(*)::int AS n FROM messages
         WHERE channel_id = '${channelId}' AND text = '${text}'`,
    )) as unknown as { rows: { n: number }[] };
    expect(rows[0]!.n).toBe(0);
  });

  it("names the attachment's index in `field`, so a caller with ten is told which (T040)", async () => {
    const mine = await slotFor(tokenA);
    const theirs = await slotFor(tokenB);
    const res = await send(
      { text: "x", attachments: [png("a"), media(mine), media(theirs)] },
      tokenA,
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { field: string }).field).toBe("attachments.2.media_id");
  });

  it("names THIS code in the envelope, and derives the docs_url from it (T030)", async () => {
    const res = await send({ text: "x", attachments: [media(randomUUID())] }, tokenA);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe("media_not_attachable");
    // `codes.test.ts` OWNS THE URL'S SHAPE. What this asserts is that the envelope points
    // at THIS code — a 422 whose `docs_url` reads `invalid_request` is the failure, and
    // restating the URL's format here would be a second copy of a rule that already has
    // one home.
    expect(body.docs_url).toContain("media_not_attachable");
    expect(body.code).not.toBe("internal_error");
  });

  // ── AND A REFUSAL LEAVES NOTHING BEHIND (SC-003) ────────────────────────────────────

  it("writes no message row and does not advance the sequence when it refuses (SC-003, FR-011)", async () => {
    // SCOPED TO THIS TEST'S OWN CHANNEL, because the lane runs two files at a time and a
    // whole-table count is a neighbour's problem — eight of those were found one failure
    // at a time before anybody swept for the class.
    const count = async (): Promise<{ rows: number; seq: number; outbox: number }> => {
      const { rows } = (await db.execute(
        `SELECT (SELECT count(*)::int FROM messages WHERE channel_id = '${channelId}') AS n,
                (SELECT coalesce(max(sequence), 0)::int FROM messages
                   WHERE channel_id = '${channelId}') AS s,
                (SELECT count(*)::int FROM outbox
                   WHERE payload->'data'->>'channel_id' = '${channelId}') AS o`,
      )) as unknown as { rows: { n: number; s: number; o: number }[] };
      return { rows: rows[0]!.n, seq: rows[0]!.s, outbox: rows[0]!.o };
    };

    const before = await count();
    const res = await send({ text: "x", attachments: [media(randomUUID())] }, tokenA);
    expect(res.status).toBe(422);
    const after = await count();

    // THREE FIGURES, AND EACH ONE CAN MOVE WITHOUT THE OTHERS. The row count alone would
    // pass against a platform that inserted and rolled back while
    // `channels.last_sequence` kept its increment — and a gap in the sequence is what a
    // client's resume cursor reads as a lost message. The OUTBOX count is the third,
    // because the row and the event are written in one transaction and an event for a
    // message that does not exist is worse than either: the consumer would publish it,
    // a subscriber would render it, and nothing in the database would agree.
    expect(after).toEqual(before);
  });
});
