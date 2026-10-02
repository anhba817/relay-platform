import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, DEFAULT_DATABASE_URL, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import {
  createEnvironment,
  Repository,
  type Environment,
} from "../db/repository";
import { auditLog } from "../db/schema";
import { ACTION } from "./moderation-routes";
import { RECORDS_NOTHING, type ActorContext } from "./actor";

// FR-MOD-03's write side, read through the repository rather than through the route.
//
// `GET /v1/audit-log` is user story 2's and the MVP is phases 1 to 3: a story whose
// independent test needs the next story's code is not independently testable.

// Guardrail: integration tests run against the LOCAL compose stack only.
const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error(
    `integration tests refuse non-local databases (got host "${url.hostname}")`,
  );
}

const pool = createPool();
const db: Db = createDb(pool);
let env: Environment;

/** The key id and the request id this suite's application actor presents. */
const KEY_ID = "key-" + randomUUID();

const actor = (over: Partial<ActorContext> = {}): ActorContext => ({
  kind: "application",
  id: KEY_ID,
  requestId: randomUUID(),
  ...over,
});

/** A repository for one request, because the actor context is per request. */
const repoFor = (a: ActorContext | typeof RECORDS_NOTHING): Repository =>
  new Repository(db, env.id, a);

/** This environment's entries, oldest first. Scoped, like every read in this suite —
 * the lane is shared and a whole-table count is a neighbour's problem (045). */
const entries = async (): Promise<
  {
    action: string;
    actorKind: string;
    actorId: string | null;
    targetKind: string;
    targetId: string;
    requestId: string;
    occurredAt: Date;
    id: string;
  }[]
> =>
  db
    .select({
      action: auditLog.action,
      actorKind: auditLog.actorKind,
      actorId: auditLog.actorId,
      targetKind: auditLog.targetKind,
      targetId: auditLog.targetId,
      requestId: auditLog.requestId,
      occurredAt: auditLog.occurredAt,
      id: auditLog.id,
    })
    .from(auditLog)
    .where(eq(auditLog.environmentId, env.id))
    .orderBy(asc(auditLog.occurredAt), asc(auditLog.id));

beforeAll(async () => {
  await migrate(pool);
  env = await createEnvironment(db, { name: "audit" });
});

afterAll(async () => {
  await pool.end();
});

describe("a ban and its reversal leave two entries (FR-MOD-03, SC-001)", () => {
  it("records the actor, the action, the target and the order", async () => {
    const banActor = actor();
    const unbanActor = actor();
    const repo = repoFor(banActor);
    const user = await repo.createUser("ana", "Ana");

    await repo.banUser(user.id);
    await repoFor(unbanActor).unbanUser(user.id);

    const rows = await entries();
    expect(rows).toHaveLength(2);
    // THE WHOLE ROW, not a field at a time. A per-field assertion passes while the
    // other seven hold whatever the last edit left in them.
    expect(rows.map((r) => [r.action, r.actorKind, r.actorId, r.targetKind, r.targetId])).toEqual([
      [ACTION.ban, "application", KEY_ID, "user", "ana"],
      [ACTION.unban, "application", KEY_ID, "user", "ana"],
    ]);
    expect(rows.map((r) => r.requestId)).toEqual([
      banActor.requestId,
      unbanActor.requestId,
    ]);
    // ORDER IS THE CLAIM, so it is asserted on the instants and not inferred from the
    // array the query returned in that order by construction.
    expect(rows[0]!.occurredAt.getTime()).toBeLessThanOrEqual(
      rows[1]!.occurredAt.getTime(),
    );
  });

  it("writes nothing for a ban that changed nothing (FR-008)", async () => {
    const repo = repoFor(actor());
    const user = await repo.createUser("bao", "Bao");
    await repo.banUser(user.id);
    const after = (await entries()).length;

    await repo.banUser(user.id);
    expect(await entries()).toHaveLength(after);
  });

  it("writes nothing for an unban that lifted nothing (FR-008)", async () => {
    // THE HALF THAT COULD NOT HAVE BEEN WRITTEN BEFORE THIS CHAPTER. `unbanUser` had no
    // `isNull` guard, so this call used to update a row and report the same `void` as a
    // real reversal — it could not tell the two apart and neither could a test.
    const repo = repoFor(actor());
    const user = await repo.createUser("chi", "Chi");
    const after = (await entries()).length;

    await repo.unbanUser(user.id);
    expect(await entries()).toHaveLength(after);
  });
});

describe("the request id joins the two logs (FR-MOD-03)", () => {
  it("is the id the api assigned the request, not one the entry minted", async () => {
    // THE ENTRY'S `request_id` IS THE JOIN TO THE REQUEST LOG and nothing asserted it
    // before this chapter. The two logs answer different questions about one request:
    // what the platform did, and what the caller asked for.
    const a = actor();
    const repo = repoFor(a);
    const user = await repo.createUser("dao", "Dao");
    await repo.banUser(user.id);

    const [row] = await db
      .select({ requestId: auditLog.requestId })
      .from(auditLog)
      .where(
        and(eq(auditLog.environmentId, env.id), eq(auditLog.targetId, "dao")),
      );
    expect(row?.requestId).toBe(a.requestId);
  });
});

describe("an entry cannot be changed or removed (FR-004, FR-MOD-03)", () => {
  it("refuses UPDATE and DELETE, and the row survives both", async () => {
    // DEMONSTRATED, NOT ASSERTED. FR-004 asks for the mechanism to be exercised, and a
    // comment saying the table is append-only is not a test (chapter 4.17).
    const repo = repoFor(actor());
    const user = await repo.createUser("em", "Em");
    await repo.banUser(user.id);
    const [row] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(eq(auditLog.environmentId, env.id), eq(auditLog.targetId, "em")),
      );
    const id = row!.id;

    // THE CAUSE, NOT THE MESSAGE. Drizzle wraps a failed statement in an error whose
    // own text is `Failed query: update "audit_log" …` — so `toThrow(/append-only/)`
    // reports red against a trigger that fired correctly, and `toThrow()` with no
    // pattern would report green against any failure at all, a syntax error included.
    // The trigger's own words are on `cause`, and they are what this asserts.
    const refusal = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
        return "no refusal at all";
      } catch (e) {
        return String((e as { cause?: unknown }).cause ?? e);
      }
    };
    expect(
      await refusal(
        db.update(auditLog).set({ actorId: "tampered" }).where(eq(auditLog.id, id)),
      ),
    ).toMatch(/audit entries are append-only \(FR-MOD-03\)/);
    expect(
      await refusal(db.delete(auditLog).where(eq(auditLog.id, id))),
    ).toMatch(/audit entries are append-only \(FR-MOD-03\)/);

    // THE ROW IS STILL THERE AND STILL SAYS WHAT IT SAID. A `BEFORE DELETE` trigger that
    // raises leaves the row; it does not leave a hole, and the refusal alone does not
    // prove that.
    const [after] = await db
      .select({ actorId: auditLog.actorId })
      .from(auditLog)
      .where(eq(auditLog.id, id));
    expect(after?.actorId).toBe(KEY_ID);
  });
});

describe("the credential decides for a message deletion (FR-002a)", () => {
  it("writes one entry when an application credential deletes another author's message", async () => {
    const repo = repoFor(actor());
    const author = await repo.createUser("author-app", "Author");
    const channel = await repo.createChannel("del-app", "public", "Del");
    await repo.addMember(channel.id, author.id);
    const sent = await repo.sendMessage(channel.id, {
      text: "by the author",
      userId: author.id,
    });
    const before = (await entries()).length;

    // No `userId`: `undefined` MEANS THE TENANT, which is the convention this repository
    // already uses and the case FR-MOD-02 grants.
    await repo.deleteMessage(channel.id, sent.id, {});

    const rows = await entries();
    expect(rows).toHaveLength(before + 1);
    expect([rows.at(-1)!.action, rows.at(-1)!.targetKind, rows.at(-1)!.targetId]).toEqual(
      [ACTION.deleteMessage, "message", sent.id],
    );
  });

  it("writes none when a user deletes their own message", async () => {
    // BOTH DIRECTIONS, BECAUSE EITHER ALONE PASSES FOR A ROUTE THAT ALWAYS WRITES OR
    // NEVER DOES. This is the one that stops a compliance log filling with ordinary user
    // activity — chapter 3.23's FR-013 is not a moderation action.
    const author = await repoFor(actor()).createUser("author-self", "Author");
    const channel = await repoFor(actor()).createChannel("del-self", "public", "Del");
    await repoFor(actor()).addMember(channel.id, author.id);
    const sent = await repoFor(actor()).sendMessage(channel.id, {
      text: "mine",
      userId: author.id,
    });
    const before = (await entries()).length;

    const userRepo = repoFor(
      actor({ kind: "user", id: "author-self" }),
    );
    await userRepo.deleteMessage(channel.id, sent.id, {
      userId: author.id,
      userExternalId: "author-self",
    });

    expect(await entries()).toHaveLength(before);
  });
});

describe("a repository that records nothing records nothing", () => {
  it("performs the action and writes no entry", async () => {
    // THE SKIP IS A TESTED BEHAVIOUR, NOT AN ACCIDENT. `recordAction` returns early when
    // there is no actor, and the guard against a production site reaching that state is
    // a source walk in `db/repository.itest.ts`. This is the other half: the early
    // return does what it says, and the action still happens.
    const repo = repoFor(RECORDS_NOTHING);
    const user = await repo.createUser("quiet", "Quiet");
    const before = (await entries()).length;

    await repo.banUser(user.id);

    expect(await entries()).toHaveLength(before);
    expect((await repo.getUserByExternalId("quiet"))?.banned_at).not.toBeNull();
  });
});
