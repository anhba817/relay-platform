import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";
import { mintUserToken } from "../auth/user-token";
import {
  AnalyticalStoreError,
  createAnalyticalStore,
  type AnalyticalStore,
} from "../metering/clickhouse";
import { eraseFromAnalyticalStore } from "./erasure";

// ERASING AN END USER, AND THE WALL THE TRAVERSAL EXISTS TO CLIMB (FR-MOD-04).
//
// `DELETE /v1/users/:externalId/data` is not FR-USR-05's deletion. That verb keeps the
// row, the messages and the billing rows ON PURPOSE, and this one does not — which is
// why the two sit side by side in `users.controller.ts` rather than differing by a
// flag. `contracts/erasure.md` carries the argument.
//
// THE FIRST TEST HERE IS A PROBE AND IT IS WRITTEN TO BE RED. A first draft of this
// file called `deleteUser` and asserted what survives — the row, the messages, the
// `usage_active_users` rows — all of which this chapter preserves deliberately. That
// probe would have been green at the open, green after the traversal and green at
// close-out, and read as evidence three times. A probe that can never go red proves
// nothing.

describe("the users row cannot be deleted while its children exist", () => {
  let db: Db;
  let repo: Repository;
  /** A user with a membership — one child is enough, and `members` is the key that
   *  fires first. */
  let encumbered: { id: string };
  /** A user with no row anywhere else. The control. */
  let bare: { id: string };

  beforeAll(async () => {
    db = createDb(createPool());
    const env = await createEnvironment(db, { name: "erasure-probe" });
    // THE ACTOR IS NOT OPTIONAL HERE EVEN THOUGH THIS SUITE RECORDS NOTHING.
    // `repository.itest.ts` walks the source for two-argument constructions and
    // caught chapter 4.20 with one; the named absence is how a suite that writes no
    // audit entry says so rather than defaulting into one.
    repo = new Repository(db, env.id, {
      kind: "application",
      id: "erasure-probe",
      requestId: randomUUID(),
    });

    encumbered = await repo.createUser("probe-encumbered", "Has A Membership");
    const channel = await repo.createChannel("probe-channel", "public");
    await repo.addMember(channel.id, encumbered.id);

    bare = await repo.createUser("probe-bare", "Has Nothing");
  });

  it("refuses the row, and the error names the key that stopped it", async () => {
    // T015. All five foreign keys to `users` are `NO ACTION`, so the row is
    // unreachable until every child is gone. The constraint name is asserted rather
    // than the message text: `repository.itest.ts:141`'s convention, and the only part
    // of a driver error that is a fact about the schema rather than about the driver.
    await expect(repo.deleteUserRowRaw(encumbered.id)).rejects.toMatchObject({
      cause: { constraint: "members_user_id_users_id_fk" },
    });
  });

  it("deletes a user with no children — the control", async () => {
    // WITHOUT THIS THE REFUSAL ABOVE MEANS NOTHING. A broken call, a wrong id and a
    // foreign key all present as a rejected promise; only the pair tells them apart.
    await expect(repo.deleteUserRowRaw(bare.id)).resolves.toBe(1);
  });
});

describe("erasure, end to end", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let store: AnalyticalStore;

  /** The caller's own tenant. */
  let mine: { id: string; credential: string; repo: Repository };
  /** A second tenant holding a user with the SAME external id. FR-008's real test:
   *  an external id is unique per environment, not globally. */
  let theirs: { id: string; credential: string; repo: Repository };

  const plantConnection = async (environmentId: string, externalId: string) =>
    store.query(
      `INSERT INTO relay_analytics.connection_events
         (environment_id, ts, connection_id, event, user_external_id)
       VALUES ({env:UUID}, now64(3), generateUUIDv4(), 'opened', {uid:String})`,
      { env: environmentId, uid: externalId },
    );

  const countConnections = async (environmentId: string, externalId: string) => {
    const rows = await store.query(
      `SELECT count() FROM relay_analytics.connection_events
        WHERE environment_id = {env:UUID} AND user_external_id = {uid:String}`,
      { env: environmentId, uid: externalId },
    );
    return Number(rows[0]?.[0] ?? 0);
  };

  const tenant = async (name: string) => {
    const env = await createEnvironment(db, { name });
    return {
      id: env.id,
      credential: (await createApiKey(db, { environmentId: env.id })).credential,
      repo: new Repository(db, env.id, {
        kind: "application",
        id: name,
        requestId: randomUUID(),
      }),
    };
  };

  /** A user with something in every store the traversal touches. */
  const populate = async (t: { id: string; repo: Repository }, externalId: string) => {
    const user = await t.repo.createUser(externalId, "To Be Erased");
    const channel = await t.repo.createChannel(`ch-${externalId}`, "public");
    await t.repo.addMember(channel.id, user.id);
    await t.repo.sendMessage(channel.id, { text: "still here after", userId: user.id });
    await t.repo.setReadPosition(channel.id, user.id, 1);
    await plantConnection(t.id, externalId);
    return { user, channel };
  };

  const erase = (externalId: string, credential: string) =>
    fetch(`${url}/v1/users/${encodeURIComponent(externalId)}/data`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${credential}` },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();

    db = createDb(createPool());
    store = createAnalyticalStore();
    mine = await tenant("erasure-mine");
    theirs = await tenant("erasure-theirs");
  });

  afterAll(async () => {
    await app?.close();
  });

  it("removes the user from every store that can remove them, counted absolutely", async () => {
    // T022. ABSOLUTE COUNTS, NOT DELTAS. The lane runs two files at a time and
    // `reset-lane.mjs` does not purge data by design, so a before-and-after difference
    // is a claim about the whole table and somebody else's rows are in it.
    const id = `erase-${randomUUID().slice(0, 8)}`;
    const { user, channel } = await populate(mine, id);

    const res = await erase(id, mine.credential);
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as {
      user_external_id: string;
      stores: { store: string; outcome: string; rows?: number }[];
    };
    const outcome = (name: string) =>
      receipt.stores.find((s) => s.store === name);

    expect(receipt.user_external_id).toBe(id);
    expect(outcome("profile")?.outcome).toBe("erased");
    expect(outcome("memberships")).toMatchObject({ outcome: "erased", rows: 1 });
    expect(outcome("read_positions")).toMatchObject({ outcome: "erased", rows: 1 });
    expect(outcome("connection_events")).toMatchObject({ outcome: "erased", rows: 1 });

    // AND THE STORES THEMSELVES, because a receipt is a claim and this is the check.
    expect(await mine.repo.listMembers(channel.id)).not.toContain(user.id);
    expect(await countConnections(mine.id, id)).toBe(0);
    expect(await mine.repo.getUserByExternalId(id)).toBeNull();
  });

  it("keeps the messages and the billing rows, and says so with a number", async () => {
    // T022, the other half. `retained_anonymous` is not `erased` and must not read as
    // it: the rows stay under a named clause and the key they carry now resolves to a
    // tombstone holding nothing.
    const id = `retain-${randomUUID().slice(0, 8)}`;
    const { user } = await populate(mine, id);

    const res = await erase(id, mine.credential);
    const receipt = (await res.json()) as {
      stores: { store: string; outcome: string; rows?: number }[];
    };
    const messages = receipt.stores.find((s) => s.store === "messages");
    expect(messages?.outcome).toBe("retained_anonymous");
    expect(messages?.rows).toBeGreaterThan(0);

    // THE TOMBSTONE IS WHY THE MESSAGES CAN STAY. All five foreign keys to `users` are
    // `NO ACTION`, so keeping `messages.user_id` means the row cannot go — and the row
    // staying, emptied, is what makes every key-only reference stop naming anybody.
    // LOOKED UP BY THE REPLACEMENT ID RATHER THAN BY THE UUID, which asserts the
    // value the traversal writes instead of merely that the row is still there.
    const tombstone = await mine.repo.getUserByExternalId(`erased:${user.id}`);
    expect(tombstone, "no tombstone under the replacement id").not.toBeNull();
    expect(tombstone?.display_name).toBeNull();
    await expect(
      mine.repo.deleteUserRowRaw(user.id),
      "the tombstone deleted, so the messages lost their author",
    ).rejects.toMatchObject({ cause: { constraint: "messages_user_id_users_id_fk" } });
  });

  it("is not deleteUser, and the two are asserted side by side", async () => {
    // T021's characterisation test. Green today and green forever — its value is that
    // it goes red the day somebody collapses the two verbs into one, which is the
    // confusion `contracts/erasure.md` exists to prevent.
    const deletedId = `char-del-${randomUUID().slice(0, 8)}`;
    const erasedId = `char-era-${randomUUID().slice(0, 8)}`;
    const a = await populate(mine, deletedId);
    const b = await populate(mine, erasedId);

    await mine.repo.deleteUser(a.user.id, deletedId);
    await erase(erasedId, mine.credential);

    // DELETION KEEPS THE NAME. That is FR-USR-05 working, not a defect.
    expect(
      await mine.repo.getUserByExternalId(deletedId),
      "deleteUser cleared the external id",
    ).not.toBeNull();

    // ERASURE DOES NOT — and the row is findable only under the replacement.
    expect(
      await mine.repo.getUserByExternalId(erasedId),
      "erasure kept the external id",
    ).toBeNull();
    expect(
      await mine.repo.getUserByExternalId(`erased:${b.user.id}`),
      "erasure left no tombstone",
    ).not.toBeNull();

    // AND BOTH KEEP THE MESSAGES, which is the half a reader is most likely to get
    // backwards. Asserted through the foreign key rather than a count: if either
    // user's messages had gone, the row would delete.
    for (const u of [a.user, b.user]) {
      await expect(
        mine.repo.deleteUserRowRaw(u.id),
        "this user's messages were destroyed",
      ).rejects.toMatchObject({
        cause: { constraint: "messages_user_id_users_id_fk" },
      });
    }
  });

  it("answers 404 on the second erasure, which inverts the obvious answer", async () => {
    // T024, and the contract said 200 until T010 cleared the external id. After the
    // first call no user has that id, so 404 is the honest answer and not a bug. The
    // cost is in `contracts/erasure.md`: a retry after a timeout cannot tell *already
    // erased* from *never existed*, and a hash on the tombstone that would answer it is
    // refused because a low-entropy external id hashes to something brute-forceable.
    const id = `twice-${randomUUID().slice(0, 8)}`;
    await populate(mine, id);

    expect((await erase(id, mine.credential)).status).toBe(200);
    expect((await erase(id, mine.credential)).status).toBe(404);
  });

  it("refuses a foreign external id indistinguishably from one nobody has", async () => {
    // T023(a). Byte-identical once `request_id` is removed — 4.11's rule: a refusal
    // that names the cause reports whether somebody else's user exists.
    const foreign = `foreign-${randomUUID().slice(0, 8)}`;
    await theirs.repo.createUser(foreign, "not yours");

    const a = await erase(foreign, mine.credential);
    const b = await erase(`absent-${randomUUID().slice(0, 8)}`, mine.credential);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);

    const strip = async (r: Response) => {
      const body = (await r.json()) as Record<string, unknown>;
      delete body["request_id"];
      return body;
    };
    expect(await strip(a)).toEqual(await strip(b));

    // AND THE OTHER TENANT'S USER IS UNTOUCHED, which the status code cannot say.
    expect(await theirs.repo.getUserByExternalId(foreign)).not.toBeNull();
  });

  it("erases one tenant's user when two environments share the external id", async () => {
    // T023(b), AND THE ANALYTICAL HALF IS THE POINT. The route can refuse correctly
    // while an unscoped statement destroys a third party's rows, and no read-shaped
    // assertion would see it. Measured on the lane's worst id: unscoped, `tuan` loses
    // 152 rows from 110 other tenants and 4 correctly — 97.4% wrong.
    const shared = `shared-${randomUUID().slice(0, 8)}`;
    await populate(mine, shared);
    await populate(theirs, shared);

    expect((await erase(shared, mine.credential)).status).toBe(200);

    expect(await mine.repo.getUserByExternalId(shared)).toBeNull();
    expect(await theirs.repo.getUserByExternalId(shared)).not.toBeNull();
    expect(await countConnections(mine.id, shared)).toBe(0);
    expect(
      await countConnections(theirs.id, shared),
      "an unscoped analytical delete took the other tenant's rows",
    ).toBe(1);
  });

  it("erases a user whose external id is SQL, and every other row survives", async () => {
    // T023a, SC-014. THE PLATFORM REALLY DOES ACCEPT THIS ID — `users.schema.ts` is
    // `z.string().min(1).max(255)`, any 255 characters, and the upsert round-trips it
    // in a 201. Interpolated into the scoped statement it takes the count from 0 to the
    // whole table, because `OR` binds looser than the `AND` chain the scope is written
    // in. This is the only assertion that distinguishes a scoped statement from one
    // that merely looks scoped.
    //
    // AND THE PAYLOAD IS `' OR 1=1 --`, NOT `ev'il OR 1=1 --`, WHICH `research.md` R9
    // NAMED AND WHICH DOES NOT WORK. Measured against the server, both interpolated
    // into the scoped count:
    //
    //     ev'il OR 1=1 --    Code: 62. Syntax error: failed at position 144 (il)
    //     ' OR 1=1 --        1,116 — the whole table
    //
    // The leading quote has to CLOSE the literal cleanly. `'ev'il …` parses as the
    // string `'ev'` followed by an identifier and dies, which an interpolating
    // implementation survives as a caught error and a `not_reached` line. **A payload
    // that errors tests the error path; only one that parses tests the predicate**, and
    // a probe run against the wrong one goes red for the wrong reason and reads as
    // proof.
    const hostile = "' OR 1=1 --";
    await populate(mine, hostile);
    const bystander = `bystander-${randomUUID().slice(0, 8)}`;
    await populate(theirs, bystander);

    expect((await erase(hostile, mine.credential)).status).toBe(200);

    expect(await countConnections(mine.id, hostile)).toBe(0);
    expect(
      await countConnections(theirs.id, bystander),
      "an interpolated external id deleted another tenant's connection events",
    ).toBe(1);
  });
});

describe("the receipt is evidence", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let mine: { id: string; credential: string; repo: Repository };

  const erase = (externalId: string) =>
    fetch(`${url}/v1/users/${encodeURIComponent(externalId)}/data`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${mine.credential}` },
    });

  const receiptFor = async (externalId: string) => {
    const res = await erase(externalId);
    const body = (await res.json()) as {
      stores: { store: string; outcome: string; rows?: number; note?: string }[];
    };
    return { status: res.status, body };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();

    db = createDb(createPool());
    const env = await createEnvironment(db, { name: "erasure-receipt" });
    mine = {
      id: env.id,
      credential: (await createApiKey(db, { environmentId: env.id })).credential,
      repo: new Repository(db, env.id, {
        kind: "application",
        id: "erasure-receipt",
        requestId: randomUUID(),
      }),
    };
  });

  afterAll(async () => {
    await app?.close();
  });

  it("tells the three silences apart", async () => {
    // T028. A STORE THAT NEVER NAMED THEM, A STORE THAT NAMES THEM BY KEY, AND A STORE
    // THAT HOLDS THEIR IDENTITY AND CANNOT GIVE IT UP. All three would report "0 rows
    // erased" and all three would be true, which is exactly what the receipt exists to
    // prevent — the compliance officer needs the difference and the number hides it.
    const id = `silence-${randomUUID().slice(0, 8)}`;
    await mine.repo.createUser(id, "Three Silences");

    const { body } = await receiptFor(id);
    const by = (name: string) => body.stores.find((s) => s.store === name);

    expect(by("api_requests")?.outcome).toBe("nothing_to_erase");
    expect(by("daily_usage")?.outcome).toBe("retained_anonymous");
    expect(by("audit_log")?.outcome).toBe("cannot_erase");

    // AND THEY ARE DISTINGUISHABLE IN THE BODY, which is the assertion rather than the
    // three above: three different words, not one word three times.
    expect(
      new Set(
        ["api_requests", "daily_usage", "audit_log"].map((n) => by(n)?.outcome),
      ).size,
      "the receipt collapsed the distinction it exists to carry",
    ).toBe(3);

    // EVERY `cannot_erase` AND `retained_anonymous` CARRIES A NOTE. A word a reader
    // cannot act on is worse than a number.
    for (const name of ["daily_usage", "audit_log", "messages", "usage_active_users"])
      expect(by(name)?.note, `${name} reported a verdict with no reason`).toBeTruthy();
  });

  it("reports not_reached when the analytical store does not answer", async () => {
    // T029, THE HALF THAT CAN LIVE IN THE LANE. The truest version of this test stops
    // the container — and the lane runs two files at a time, so it would take
    // ClickHouse away from every suite beside it. 4.10 found exactly that with MinIO,
    // and `check-lane-scope.py` cannot see an ACTION scoped too wide. The run against
    // a genuinely stopped container is in `baseline.txt`, measured once, by hand.
    //
    // WHAT THIS ASSERTS IS THE OUTCOME, NOT THE PLUMBING: every failure mode of that
    // client — a timeout, a refused connection, a rejected statement — has to arrive
    // as one word, because an operator can do exactly one thing about all three.
    const dead: AnalyticalStore = {
      query: () => Promise.reject(new AnalyticalStoreError("refused", 0)),
    };
    const results = await eraseFromAnalyticalStore(mine.id, "whoever", dead);
    const ce = results.find((r) => r.store === "connection_events");
    expect(ce?.outcome).toBe("not_reached");
    expect(ce?.note).toBeTruthy();

    // AND THE OTHER TWO STILL REPORT, because neither was ever going to be attempted.
    // A store that was not asked and a store that could not be reached are different
    // facts and an outage must not blur them.
    expect(results.find((r) => r.store === "api_requests")?.outcome).toBe(
      "nothing_to_erase",
    );
    expect(results.find((r) => r.store === "daily_usage")?.outcome).toBe(
      "retained_anonymous",
    );
  });

  it("refuses a user token, which is the only thing standing between an end user and this route", async () => {
    // T036a, AND THE PROBE IS WHY THIS TEST EXISTS. Deleting `@Accepts("application")`
    // from the controller turned NOTHING red — 12 of 12 and the gauntlet 64 of 64 —
    // which is chapter 4.18's finding one route over, with the consequence inverted.
    // There the undefended case was a READ and a leak; here it is an erasure, so an
    // end-user token that reaches this handler destroys another person's data and
    // every read-shaped assertion in the suite still passes.
    //
    // THE DECORATOR IS THE DECISION, NOT A BRANCH IN THE HANDLER, so this is the only
    // place it can be tested from.
    const id = `token-${randomUUID().slice(0, 8)}`;
    await mine.repo.createUser(id, "Not Yours To Erase");
    const env = await environmentSigningSecret(db, mine.id);
    expect(env, "the environment has no signing secret").not.toBeNull();
    const { token } = await mintUserToken(env!.signingSecret, {
      user: id,
      environmentId: mine.id,
      ttlSeconds: 3600,
    });

    const res = await fetch(`${url}/v1/users/${id}/data`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status, "a user token reached the erasure route").toBe(403);

    // AND THE USER IS STILL THERE, because a status code cannot say whether the
    // handler ran before refusing.
    expect(await mine.repo.getUserByExternalId(id)).not.toBeNull();
  });

  it("refuses a user id from another environment, which no route can reach", async () => {
    // T036, ARMS A AND B. Deleting either environment scope inside `eraseUser` turned
    // nothing red, because `UsersService` resolves the external id through a
    // tenant-scoped read first and the method never receives a foreign id. That is a
    // single-mutation probe measuring the DEFENCE rather than the arm — 4.12's
    // finding, and 065 found three such reads where removing any two was invisible.
    //
    // THE ANSWER IS THE TEST THAT MAKES THE ARM VISIBLE, not the deletion that makes
    // it honest. Calling the repository directly is the only caller that can present
    // a foreign id, and it is one refactor away from being a real one.
    const foreignEnv = await createEnvironment(db, { name: "erasure-arm-probe" });
    const foreignRepo = new Repository(db, foreignEnv.id, {
      kind: "application",
      id: "arm-probe",
      requestId: randomUUID(),
    });
    const victim = await foreignRepo.createUser(
      `arm-${randomUUID().slice(0, 8)}`,
      "Another Tenant's",
    );

    await expect(
      mine.repo.eraseUser(victim.id, "whatever"),
      "eraseUser erased a user from another environment",
    ).rejects.toThrow(/no user .* in this environment/);

    expect(
      await foreignRepo.getUserByExternalId(victim.external_id),
      "the other tenant's user was erased",
    ).not.toBeNull();
  });

  it("reports cannot_erase when the delete returns and the rows are still there", async () => {
    // T065. THE ARM THAT MAKES THE VERB CHOICE MATTER. `ALTER TABLE … DELETE` returns
    // before it acts, so a receipt built on it would report rows it had not removed.
    // The lightweight form is visible to the next statement — and this asserts what
    // happens if a store ever stops behaving that way, which is the only reason the
    // verification `SELECT` exists at all.
    const stubborn: AnalyticalStore = {
      query: (sql) =>
        Promise.resolve(sql.startsWith("SELECT") ? [["7"]] : []),
    };
    const results = await eraseFromAnalyticalStore(mine.id, "whoever", stubborn);
    const ce = results.find((r) => r.store === "connection_events");
    expect(ce).toMatchObject({ outcome: "cannot_erase", rows: 7 });
    expect(ce?.note).toMatch(/still there/);
  });

  it("reports zero when the count query answers with no row at all", async () => {
    // T065/T066. THE LAST TWO BRANCHES, AND THE PROBE IS WHAT FOUND THEM. Two tests
    // took this file from 63.63% to 81.81% and the pin was written at 90 on the
    // assumption it had reached 100 — which only the both-ways pin probe caught,
    // because a pin BELOW the real number is silent in exactly the way a pin on an
    // absent file is.
    //
    // `SELECT count()` always answers with one row, so these two `?? 0` arms are
    // defensive. They are covered rather than pinned around, because the alternative
    // is a lower floor justified by a sentence nobody can check.
    const empty: AnalyticalStore = { query: () => Promise.resolve([]) };
    const results = await eraseFromAnalyticalStore(mine.id, "whoever", empty);
    expect(results.find((r) => r.store === "connection_events")).toMatchObject({
      outcome: "erased",
      rows: 0,
    });
  });

  it("names the HTTP status when the store refuses, and does not when there was none", async () => {
    // T065, and the distinction is the one the ClickHouse-stopped run exposed.
    // `AnalyticalStoreError.status` is 0 when there was no response at all — an
    // abort, a refused connection, a DNS failure — so `the analytical store answered
    // 0` is a sentence reporting a status that does not exist, to the reader least
    // able to come and ask what it means.
    const refusing: AnalyticalStore = {
      query: () => Promise.reject(new AnalyticalStoreError("Code: 62", 400)),
    };
    const silent: AnalyticalStore = {
      query: () => Promise.reject(new AnalyticalStoreError("ECONNREFUSED", 0)),
    };
    const a = (await eraseFromAnalyticalStore(mine.id, "x", refusing)).find(
      (r) => r.store === "connection_events",
    );
    const b = (await eraseFromAnalyticalStore(mine.id, "x", silent)).find(
      (r) => r.store === "connection_events",
    );
    expect(a?.outcome).toBe("not_reached");
    expect(a?.note).toMatch(/HTTP 400/);
    expect(b?.outcome).toBe("not_reached");
    expect(b?.note).toMatch(/did not answer/);
    expect(b?.note).not.toMatch(/0/);
  });

  it("destroys the media objects the user uploaded, and counts them", async () => {
    // THE RECEIPT CLAIMS A ROW COUNT FOR `media_objects` AND NOTHING EXERCISED IT.
    // Every other fixture in this file creates a user with no uploads, so the
    // traversal's media branch was never entered — `eraseUser`'s `owned.map(...)`
    // has no caller, the `destroyMediaObjects` call gets an empty array and returns
    // early, and the receipt reports `rows: 0` for a store it never touched. A green
    // suite and a claim nobody checked.
    //
    // FOUND BY THE COVERAGE RATCHET, NOT BY READING: `repository.ts` measured 179 of
    // 180 functions against a pin of 100%, persistently, across two runs whose test
    // failures were different — which is what ruled out a flaky neighbour and left
    // an arm this suite had simply never reached.
    const id = `media-${randomUUID().slice(0, 8)}`;
    const user = await mine.repo.createUser(id, "Uploader");
    const mediaId = randomUUID();
    await mine.repo.reserveMediaSlot({
      id: mediaId,
      userId: user.id,
      filename: "evidence.png",
      mimeType: "image/png",
      declaredBytes: 1024,
      objectKey: `${mine.id}/${mediaId}`,
    });
    expect(await mine.repo.mediaObjectExistsRaw(mediaId)).toBe(true);

    const { body } = await receiptFor(id);
    const media = body.stores.find((s) => s.store === "media_objects");
    expect(media).toMatchObject({ outcome: "erased", rows: 1 });

    // AND THE ROW IS ACTUALLY GONE, because a receipt is a claim.
    expect(await mine.repo.mediaObjectExistsRaw(mediaId)).toBe(false);
  });

  it("names the 73.6% its own media erasure cannot reach", async () => {
    // T030. An erasure that takes the attributed objects is correct and incomplete,
    // and `media_objects.user_id` being nullable is why. Measured: 11,173 of 15,189.
    const id = `media-note-${randomUUID().slice(0, 8)}`;
    await mine.repo.createUser(id, "Uploader");

    const { body } = await receiptFor(id);
    const media = body.stores.find((s) => s.store === "media_objects");
    expect(media?.note, "the receipt does not say what it could not reach").toMatch(
      /73\.6%/,
    );
  });
});
