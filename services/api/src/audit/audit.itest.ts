import { randomUUID } from "node:crypto";

import { and, eq, sql as sqlTag } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditActionsHeld,
  auditPage,
  auditPageQuery,
  type AuditRow,
} from "../db/audit-reads";
import { createDb, createPool, DEFAULT_DATABASE_URL, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import {
  createEnvironment,
  Repository,
  type Environment,
} from "../db/repository";
import { auditLog } from "../db/schema";
import { createAuditReader, type AuditReader } from "./audit.reader";
import { buildAuditQuerySchema } from "./audit.schema";
import { ACTION, MODERATION_ROUTES } from "./moderation-routes";
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
let other: Environment;
let reader: AuditReader;

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

/** This environment's entries, oldest first.
 *
 * THROUGH `db/audit-reads.ts`, THE SAME READ THE ROUTE USES — which is what makes this
 * file's driver exemption honest. The exemption exists for two statements, the `UPDATE`
 * and the `DELETE` that FR-004 requires be attempted; every read here goes through the
 * product's own path. `auditPage` returns newest first, so this reverses.
 *
 * Scoped, because the lane is shared and a whole-table count is a neighbour's problem
 * (045, eight instances). */
const entries = async (): Promise<AuditRow[]> =>
  (
    await auditPage(db, env.id, {
      from: new Date(0),
      to: new Date(Date.UTC(2100, 0, 1)),
      limit: 10_000,
    })
  ).reverse();

beforeAll(async () => {
  await migrate(pool);
  env = await createEnvironment(db, { name: "audit" });
  other = await createEnvironment(db, { name: "audit-other" });
  reader = createAuditReader(db);
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

/** A wide window, so a test asserting WHICH entries come back is never also asserting
 *  that the default 24 hours happened to cover them. */
const WIDE = {
  from: new Date(Date.UTC(2026, 0, 1)),
  to: new Date(Date.UTC(2100, 0, 1)),
};

/** Parse a query the way the route does, so these tests exercise the same bounds a
 *  caller meets rather than a hand-built object the schema would have refused. */
const parse = (raw: Record<string, unknown>, actions?: Iterable<string>) =>
  buildAuditQuerySchema(
    new Set(
      actions ??
        Object.entries(MODERATION_ROUTES)
          .filter(([, kind]) => kind !== "not-moderation")
          .map(([route]) => route),
    ),
  ).parse(raw);

describe("a tenant reads its own history and no other (FR-006, constitution I)", () => {
  it("returns exactly its own entries when both environments did the same thing", async () => {
    // THE SAME ACTIONS IN BOTH, so the read cannot pass by one side being empty — which
    // is the shape 4.8's own leak check had to plant rows to avoid.
    const mine = repoFor(actor());
    const theirs = new Repository(db, other.id, actor());
    const a = await mine.createUser("iso-mine", "Mine");
    const b = await theirs.createUser("iso-theirs", "Theirs");
    await mine.banUser(a.id);
    await theirs.banUser(b.id);

    const page = await reader.page(env.id, parse({ ...isoStrings(WIDE), limit: "200" }));
    const targets = page.entries.map((e) => e.target.id);
    expect(targets).toContain("iso-mine");
    expect(targets).not.toContain("iso-theirs");
    // AND THE WHOLE BODY, not only the rows: a foreign identifier reaching a cursor or
    // an echo is a leak exactly as a row is (`listAttack`'s rule, applied here).
    expect(JSON.stringify(page)).not.toContain("iso-theirs");
    expect(JSON.stringify(page)).not.toContain(other.id);
  });
});

describe("the filter's VOCABULARY is scoped too, which no other test asked", () => {
  it("does not tell a tenant which actions other tenants have taken", async () => {
    // T046's ARM 2, WHICH WAS INVISIBLE. Deleting the tenancy predicate from
    // `auditActionsHeld` left the audit suites 21 of 21 and the gauntlet 62 of 62 — no
    // test had two tenants whose action vocabularies differ, so an unscoped
    // `SELECT DISTINCT action` read as correct. 4.12 measured the same shape on three
    // scopes at once; this is one scope with no neighbour covering for it.
    //
    // IT IS A SMALLER LEAK THAN A ROW AND IT IS STILL A LEAK: the set of action KINDS a
    // competitor's moderators perform is information about how they run their product.
    const mine = new Repository(db, env.id, actor());
    const theirs = new Repository(db, other.id, actor());

    // An action only the OTHER tenant performs. The archive pair is this suite's
    // choice because nothing in `env` archives a channel except the filter test, which
    // runs in its own describe and may not have run yet — so the claim is made with a
    // channel this test creates.
    const c = await theirs.createChannel("vocab-theirs", "public", "V");
    await theirs.archiveChannel(c.id);
    const u = await mine.createUser("vocab-mine", "V");
    await mine.banUser(u.id);

    const held = new Set(await auditActionsHeld(db, env.id));
    expect(held.has(ACTION.ban), "this tenant's own action is missing").toBe(true);
    expect(
      held.has(ACTION.archiveChannel),
      "another tenant's action appeared in this tenant's vocabulary",
    ).toBe(false);
  });
});

describe("the filter promises that nothing else comes back (FR-006)", () => {
  it("returns only the named action, whatever else the tenant has done", async () => {
    // THE COMPLEMENT IS THE CLAIM. Chapter 4.8: what a filter promises is that nothing
    // ELSE comes back, and the count of what does is the plant's business.
    const repo = repoFor(actor());
    const u = await repo.createUser("filt", "Filt");
    const c = await repo.createChannel("filt-chan", "public", "Filt");
    await repo.banUser(u.id);
    await repo.archiveChannel(c.id);

    const page = await reader.page(
      env.id,
      parse({ ...isoStrings(WIDE), limit: "200", action: ACTION.archiveChannel }),
    );
    expect(page.entries.length).toBeGreaterThan(0);
    expect([...new Set(page.entries.map((e) => e.action))]).toEqual([
      ACTION.archiveChannel,
    ]);
  });

  it("refuses an action the vocabulary does not hold, and admits one the column does", () => {
    // BOTH DIRECTIONS. A vocabulary that admitted everything would make the first half
    // vacuous, and one frozen at the classified set would refuse a value a customer can
    // see in their own page — which is the case the second half pins.
    expect(() => parse({ action: "POST /v1/nothing" })).toThrow();
    const retired = "POST /v1/channels/:channelId/retired";
    expect(parse({ action: retired }, [retired]).action).toBe(retired);
  });
});

describe("EIR-API-06's fields are present and mean something", () => {
  it("pages with has_more and a next_cursor that fetches the rest", async () => {
    // TWO PAGES, NOT ONE. `has_more: false` on a single short page is true for a route
    // that never sets the field at all.
    const repo = repoFor(actor());
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const u = await repo.createUser(`page-${i}-${randomUUID().slice(0, 6)}`, "P");
      await repo.banUser(u.id);
      made.push(u.external_id);
    }

    const first = await reader.page(env.id, parse({ ...isoStrings(WIDE), limit: "2" }));
    expect(first.entries).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).not.toBeNull();

    const second = await reader.page(
      env.id,
      parse({ ...isoStrings(WIDE), limit: "200", cursor: first.next_cursor! }),
    );
    expect(second.has_more).toBe(false);
    expect(second.next_cursor).toBeNull();
    // AND NO ROW IN BOTH PAGES, which is what a keyset cursor on a non-unique column
    // would get wrong — the three bans above can land in one millisecond.
    const firstIds = new Set(first.entries.map((e) => e.id));
    expect(second.entries.filter((e) => firstIds.has(e.id))).toEqual([]);
    // every one of the three is on one page or the other
    const seen = new Set([...first.entries, ...second.entries].map((e) => e.target.id));
    for (const id of made) expect(seen.has(id), `${id} fell between pages`).toBe(true);
    // `prev_cursor` is non-null exactly when the caller arrived holding a cursor
    expect(first.prev_cursor).toBeNull();
    expect(second.prev_cursor).not.toBeNull();
  });
});

describe("the refusals, by what they say and not only by that they happen", () => {
  it("refuses a limit outside the published bound, naming the field", () => {
    for (const limit of ["0", "201"]) {
      const result = buildAuditQuerySchema(new Set()).safeParse({ limit });
      expect(result.success, `limit=${limit} was accepted`).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["limit"]);
    }
    expect(buildAuditQuerySchema(new Set()).parse({ limit: "200" }).limit).toBe(200);
  });

  it("refuses a malformed cursor with invalid_request rather than a page", async () => {
    // NEVER A SILENT FALL BACK TO THE TOP OF THE WINDOW, which would serve a page the
    // caller did not ask for and look like working software (chapter 2.4's rule).
    const refusal = await reader
      .page(env.id, parse({ ...isoStrings(WIDE), cursor: "not-a-cursor" }))
      .then(() => null)
      .catch((e: unknown) => e as { code?: string; status?: number; field?: string });
    expect(refusal?.code ?? (refusal as unknown as { response?: { code?: string } })?.response?.code).toBe(
      "invalid_request",
    );
  });

  it("refuses a window whose end is not after its start", () => {
    const at = new Date(Date.UTC(2026, 5, 1)).toISOString();
    const result = buildAuditQuerySchema(new Set()).safeParse({ from: at, to: at });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["to"]);
  });
});

function isoStrings(w: { from: Date; to: Date }): { from: string; to: string } {
  return { from: w.from.toISOString(), to: w.to.toISOString() };
}

describe("the read is an index range, which is the claim the reader is built on", () => {
  it("puts the cursor comparison in the Index Cond and leaves no Filter", async () => {
    // T032a, AND IT ALREADY CAUGHT ONE DEFECT. The first version of `auditPage` wrote the
    // keyset predicate as `occurred_at < $1 OR (occurred_at = $1 AND id < $2)` with a
    // comment claiming the planner treats that identically to a row value. It does not:
    // the OR form lands in a `Filter:` and the scan discards every row of every earlier
    // page — `Rows Removed by Filter: 51` on page 2 and `201` on page 5 — which is
    // O(page depth) and the exact cost keyset pagination exists to avoid.
    //
    // `Index Cond` IS THE QUESTION, NOT `Index Scan` (chapter 4.13): a predicate the
    // planner cannot push down still returns an index scan, carrying the filter beside it.
    //
    // `enable_seqscan = off` BECAUSE CHOOSING THE INDEX IS A PROPERTY OF THE CORPUS. On a
    // table this lane has barely filled, a sequential scan is the planner making the right
    // call, and asserting its choice would be asserting the size of somebody else's test
    // data. The question this asks is whether the index CAN serve the predicate.
    const cursor = {
      occurredAt: new Date(Date.UTC(2026, 6, 1, 12)),
      id: "00000000-0000-4000-8000-000000000000",
    };
    const { sql: text, params } = auditPageQuery(db, env.id, {
      from: WIDE.from,
      to: WIDE.to,
      limit: 51,
      after: cursor,
    }).toSQL();

    const plan = await db.transaction(async (tx) => {
      await tx.execute(sqlTag`set local enable_seqscan = off`);
      await tx.execute(sqlTag`set local enable_bitmapscan = off`);
      const rows = await tx.execute(
        sqlTag.raw(`EXPLAIN ${text.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1]))}`),
      );
      return (rows as unknown as { rows?: { "QUERY PLAN": string }[] }).rows ?? (rows as unknown as { "QUERY PLAN": string }[]);
    });
    const printed = plan.map((r) => r["QUERY PLAN"]).join("\n");

    expect(printed, printed).toMatch(/Index (Only )?Scan.*audit_log_read_idx/);
    // THE PAIR IS IN THE INDEX CONDITION, not beside it.
    expect(printed, printed).toMatch(/Index Cond:[\s\S]*ROW\(occurred_at, id\)/);
    // AND NOTHING IS BEING DISCARDED. This is the assertion that would have failed
    // against the OR form while every other line of the plan looked right.
    expect(printed, printed).not.toMatch(/Filter:/);
  });
});

/** A literal for EXPLAIN, which takes no parameters. Values come from this test, never
 *  from a caller — the route's own statement is parameterised. */
function literal(v: unknown): string {
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
