import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { mintUserToken } from "../auth/user-token";
import { sql } from "drizzle-orm";

import { createDb, createPool, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";

// CHAPTER 4.19 — every text a message ever held, including the last one.
//
// WHY THIS FILE AND NOT `messages.itest.ts`, WHICH ALREADY HAS EVERY FIXTURE. That file
// is published by 18 pages of the tutorial, so a block of new tests turns the one-line
// assertion change this chapter owes it into a large published hunk. The price of the
// separation is the channel/user/token sequence below, rebuilt because
// `messages.itest.ts` exports nothing — its `send`, `patch` and `edits` helpers are
// `const`s inside describe closures. The decision is in `plan.md`'s complexity table.
//
// AND IT BOOTS A NEST APP FROM THE START, on `audit/route.itest.ts`'s template. Three of
// the five tests below are repository-level and two need real HTTP: a repository test
// proves a check exists and only a route test proves it fires.
describe("message versions", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let repo: Repository;
  let environmentId: string;
  let credential: string;
  let channelId: string;
  let authorId: string;
  /** A token for a person signed into the tenant's product. The route must refuse it. */
  let userToken: string;

  const edits = (messageId: string, token = credential): Promise<Response> =>
    fetch(`${url}/v1/channels/${channelId}/messages/${messageId}/edits`, {
      headers: { authorization: `Bearer ${token}` },
    });

  /** A message authored by a PERSON, which is what the edit path requires.
   *
   * An application credential may send only as a bot user, and FR-013a gives the edit
   * to the author alone — so a fixture that sent as the key could not then edit. The
   * premise check found this and `quickstart.md` carries the correction; this file is
   * new and had no reason to know. */
  const sendAsAuthor = async (text: string): Promise<string> =>
    (await repo.sendMessage(channelId, { text, userId: authorId })).id;

  beforeAll(async () => {
    const pool = createPool();
    await migrate(pool);
    db = createDb(pool);
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();

    const env = await createEnvironment(db, { name: "message-versions" });
    environmentId = env.id;
    ({ credential } = await createApiKey(db, { environmentId }));

    repo = new Repository(db, environmentId, {
      kind: "application",
      id: "versions-suite",
      requestId: crypto.randomUUID(),
    });
    const author = await repo.createUser("versions-author", "Author");
    authorId = author.id;
    channelId = (await repo.createChannel("versions", "public")).id;
    await repo.addMember(channelId, authorId);

    const secret = (await environmentSigningSecret(db, environmentId))!.signingSecret;
    userToken = (
      await mintUserToken(secret, {
        user: "versions-author",
        environmentId,
        ttlSeconds: 3600,
      })
    ).token;
  });

  afterAll(async () => {
    // NOTHING IS DELETED, and this time the table would refuse it — which is the
    // chapter's own subject. The rows are scoped to an environment this suite minted,
    // which is `fixtures.ts`'s standing convention for the same reason.
    await app.close();
  });

  it("yields three texts for a message edited twice and then deleted (FR-001, SC-001)", async () => {
    const id = await sendAsAuthor("will be edited");
    await repo.editMessage(channelId, id, { text: "edited once", userId: authorId });
    await repo.editMessage(channelId, id, { text: "edited twice", userId: authorId });
    await repo.deleteMessage(channelId, id, {});

    const versions = await repo.listMessageEdits(channelId, id);

    // THREE, WHERE THE PLATFORM GAVE TWO BEFORE THIS CHAPTER. The third is the text the
    // message held at the moment the moderator removed it — the one a dispute turns on,
    // and the one that was in no table.
    expect(versions.map((v) => v.prior_text)).toEqual([
      "will be edited",
      "edited once",
      "edited twice",
    ]);
    expect(versions.map((v) => v.ended_by)).toEqual(["edit", "edit", "deletion"]);
  });

  it("yields one text for a message deleted with no edits (FR-001, SC-002)", async () => {
    // THE CASE THE ARITHMETIC IS WORST IN — zero of one, where an edited message at
    // least kept its earlier texts — and the case a test written over an edited message
    // would never reach.
    const id = await sendAsAuthor("never edited, then removed");
    await repo.deleteMessage(channelId, id, {});

    const versions = await repo.listMessageEdits(channelId, id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.prior_text).toBe("never edited, then removed");
    expect(versions[0]!.ended_by).toBe("deletion");
  });

  it("records no second version for a repeated deletion (FR-004, SC-004)", async () => {
    const id = await sendAsAuthor("deleted twice");
    await repo.editMessage(channelId, id, { text: "deleted twice, edited", userId: authorId });
    await repo.deleteMessage(channelId, id, {});

    // AN ABSOLUTE COUNT, TWICE, AND NOT A DELTA. A delta of zero is satisfied by
    // nothing happening, so the first version of this assertion would have passed with
    // FR-001 entirely unimplemented. Pinning what the FIRST call left is what makes the
    // second call's claim mean anything.
    expect(await repo.listMessageEdits(channelId, id)).toHaveLength(2);
    const second = await repo.deleteMessage(channelId, id, {});
    expect(second.alreadyDeleted).toBe(true);
    expect(await repo.listMessageEdits(channelId, id)).toHaveLength(2);
  });

  it("serves the three versions through the route, not only the repository (FR-002)", async () => {
    const id = await sendAsAuthor("over http");
    await repo.editMessage(channelId, id, { text: "over http, edited", userId: authorId });
    await repo.deleteMessage(channelId, id, {});

    const res = await edits(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      edits: Array<Record<string, string>>;
    };

    // A REPOSITORY TEST PROVES A CHECK EXISTS; ONLY A ROUTE TEST PROVES IT FIRES.
    expect(body.edits.map((e) => e.prior_text)).toEqual(["over http", "over http, edited"]);
    expect(body.edits.map((e) => e.ended_by)).toEqual(["edit", "deletion"]);

    // THE FIELD SET IS THE CONTRACT, and `ended_at` carries the same value as
    // `edited_at` on every row — one column under two names, because `edited_at` is
    // published and cannot be removed under CON-05 while being the wrong word for a
    // row that ended in a deletion.
    expect(Object.keys(body.edits[0]!).sort()).toEqual([
      "edited_at",
      "ended_at",
      "ended_by",
      "prior_text",
    ]);
    expect(body.edits[0]!.ended_at).toBe(body.edits[0]!.edited_at);
  });

  it("carries the removal instant on the history row, and null on a live one (FR-007, SC-003)", async () => {
    const removed = await sendAsAuthor("about to go");
    const live = await sendAsAuthor("still here");
    await repo.deleteMessage(channelId, removed, {});

    const res = await fetch(`${url}/v1/channels/${channelId}/messages?limit=100`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<Record<string, unknown>>;
    };
    const byId = new Map(body.messages.map((m) => [m["id"] as string, m]));

    // A PRESENT KEY HOLDING NULL, NOT AN ABSENT ONE, and `in` rather than a truthiness
    // check is the whole assertion: `m.deleted_at` is `undefined` for a field that was
    // never added and `null` for a live message, and the two read identically through
    // `??`. `messages.itest.ts:1416`'s comment makes the same point one route over.
    expect("deleted_at" in byId.get(live)!).toBe(true);
    expect(byId.get(live)!["deleted_at"]).toBeNull();

    const instant = byId.get(removed)!["deleted_at"];
    expect(typeof instant).toBe("string");

    // AND IT IS THE SAME INSTANT THE OUTBOX EVENT CARRIES — the row the webhook is
    // built from, written inside the deletion's own transaction. Three things describe
    // one removal: that event, the real-time `message.deleted` frame, and this. The
    // first two have carried the instant since 3.23 and history had not, so a client
    // that was offline learned the message was gone and not when.
    //
    // NOT THE `DELETE` RESPONSE, which answers 204 with an empty body and carries
    // nothing at all — three artifacts named it as one of the two surfaces that do,
    // until this chapter's seventh analysis pass ran it.
    const [event] = (
      await db.execute<{ payload: { data: { deleted_at: string } } }>(
        sql`SELECT payload FROM outbox
            WHERE payload->'data'->>'id' = ${removed}
              AND subject LIKE 'events.msg.deleted%'
            LIMIT 1`,
      )
    ).rows;
    expect(event!.payload.data.deleted_at).toBe(instant);
  });

  it("refuses a user token with wrong_credential_type (FR-005, SC-006)", async () => {
    const id = await sendAsAuthor("not for a person");

    const res = await edits(id, userToken);
    expect(res.status).toBe(403);
    // BY CODE, NOT BY STATUS. `webhooks.itest.ts` passed for three chapters asserting a
    // status and a message while the body said `internal_error`, and only the code
    // could have caught it.
    expect(((await res.json()) as { code: string }).code).toBe("wrong_credential_type");
  });
});
