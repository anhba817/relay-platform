import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDb, createPool, DEFAULT_DATABASE_URL, type Db } from "./client";
import { migrate } from "./migrate";
import {
  createEnvironment,
  MessageDeletedError,
  MessageNotFoundError,
  NotMessageAuthorError,
  Repository,
  type Environment,
} from "./repository";

// The isolation suite: attack the repository with FOREIGN tenant ids and
// prove the leak inexpressible (FR-TEN-05, NFR-SEC-09, constitution I).
// Requires the compose Postgres — this file is *.itest.ts precisely so the
// Docker-free unit lane never collects it.

// Guardrail: integration tests run against the LOCAL compose stack only.
const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error(
    `integration tests refuse non-local databases (got host "${url.hostname}") — never point this suite at a shared database`,
  );
}

const pool = createPool();
const db: Db = createDb(pool);
let envA: Environment;
let envB: Environment;
let repoA: Repository;
let repoB: Repository;

beforeAll(async () => {
  await migrate(pool);
  // Deterministic ground WITHOUT a truncate: this suite mints its own
  // environments, and 2.1 proved no other environment's rows are visible
  // through them. Isolation buys parallel-safe test files for free — see
  // the note below.
  envA = await createEnvironment(db, { name: "tenant-a" });
  envB = await createEnvironment(db, { name: "tenant-b" });
  repoA = new Repository(db, envA.id);
  repoB = new Repository(db, envB.id);
});

afterAll(async () => {
  await pool.end();
});

describe("tenant isolation is structural (FR-TEN-05)", () => {
  it("a foreign external_id resolves to nothing — not even an existence hint", async () => {
    await repoA.createUser("tuan", "Tuan");
    expect(await repoA.getUserByExternalId("tuan")).not.toBeNull();
    expect(await repoB.getUserByExternalId("tuan")).toBeNull();
  });

  it("channel reads and lists are scoped by construction", async () => {
    await repoA.createChannel("support", "public", "Support");
    expect(await repoB.getChannelByExternalId("support")).toBeNull();
    expect(await repoB.listChannels()).toEqual([]);
    expect((await repoA.listChannels()).map((c) => c.external_id)).toContain(
      "support",
    );
  });

  it("membership writes with foreign ids affect zero rows", async () => {
    const user = await repoA.getUserByExternalId("tuan");
    const channel = await repoA.getChannelByExternalId("support");
    expect(await repoA.addMember(channel!.id, user!.id)).toBe("added");
    // Asked twice is a SUCCESS and not a failure, and telling those apart is
    // what chapter 3.13 changed here: the endpoint over this call has to be
    // idempotent, and a unique violation reached the wire as `internal_error`.
    expect(await repoA.addMember(channel!.id, user!.id)).toBe("already_a_member");
    // B holds A's REAL ids — and still cannot write or read through them. The
    // answer is `not_found`, which is also what B gets for ids that exist
    // nowhere: three refusals, one word, on purpose.
    expect(await repoB.addMember(channel!.id, user!.id)).toBe("not_found");
    expect(await repoB.listMembers(channel!.id)).toEqual([]);
    expect(await repoB.channelsForUser(user!.id)).toEqual([]);
    expect(await repoA.listMembers(channel!.id)).toEqual([user!.id]);
  });

  it("uniqueness is per-tenant (DR-02): both tenants may own the same external_id", async () => {
    // B's own Tuan is a DIFFERENT row. That is the per-tenant half.
    const inB = await repoB.createUser("tuan", "A different Tuan");
    const inA = await repoA.getUserByExternalId("tuan");
    expect(inB.id).not.toBe(inA!.id);

    // THE OBSERVATION CHANGED IN CHAPTER 3.12 AND THE PROPERTY DID NOT. This
    // used to assert that a repeat within one tenant REJECTS, which observed the
    // unique index by watching it raise. `createUser` is now idempotent — the
    // members endpoint creates a user on first membership, so a repeated request
    // would otherwise have answered `internal_error` — and the index is what
    // makes that work rather than something that got removed. So the assertion
    // is now that a repeat returns THE SAME ROW: still one user per tenant per
    // external id, observed through the outcome instead of through an exception.
    const again = await repoA.createUser("tuan", "Duplicate in A");
    expect(again.id).toBe(inA!.id);
    // And the existing display name wins: a second call is not an update.
    expect(again.display_name).toBe(inA!.display_name);
  });
});

describe("the database refuses a bot with no description (chapter 3.17, FR-003)", () => {
  // TWO GUARANTEES, NOT ONE, AND THIS IS THE SECOND (T023). Zod refuses a bot with no
  // description at the boundary and that covers every request; this covers every
  // WRITER — a migration, a backfill, a psql session, a future route nobody has
  // written. Research R5 puts the two checks in two layers deliberately, and a test
  // that only exercised the boundary would leave the constraint unproven.
  it("refuses the insert directly, not only through the route", async () => {
    const user = await repoA.createUser("db-refuses-me", "Person For Now");
    // THE CONSTRAINT NAME IS ON THE CAUSE, NOT THE MESSAGE. Drizzle wraps the driver
    // error as "Failed query: ...", so asserting on `toThrow(/users_bot.../)` passes
    // for any failure of that statement — including a typo in the SQL. The name is
    // what makes this test about the constraint rather than about the query.
    await expect(
      db.execute(sql`UPDATE users SET kind = 'bot' WHERE id = ${user.id}`),
    ).rejects.toMatchObject({
      cause: { constraint: "users_bot_description_check" },
    });
  });

  it("accepts the same promotion when a description comes with it", async () => {
    const user = await repoA.createUser("db-allows-me", "Person For Now");
    await db.execute(
      sql`UPDATE users SET kind = 'bot', description = 'it says what it does'
          WHERE id = ${user.id}`,
    );
    expect((await repoA.getUserByExternalId("db-allows-me"))!.kind).toBe("bot");
  });

  it("refuses a kind outside the two the vocabulary allows", async () => {
    const user = await repoA.createUser("db-refuses-kind", "Person");
    await expect(
      db.execute(sql`UPDATE users SET kind = 'daemon' WHERE id = ${user.id}`),
    ).rejects.toMatchObject({ cause: { constraint: "users_kind_check" } });
  });
});

describe("sequence assignment is serialised per channel (ADR-03)", () => {
  it("two concurrent sends never interleave", async () => {
    const channel = await repoA.createChannel("ordering", "public");
    const writer = (await repoA.createUser("ordering-writer", "Writer")).id;
    const [a, b] = await Promise.all([
      repoA.sendMessage(channel.id, { text: "first writer", userId: writer }),
      repoA.sendMessage(channel.id, { text: "second writer", userId: writer }),
    ]);
    // Two sends, two DISTINCT consecutive sequence numbers — always.
    expect(new Set([a.seq, b.seq]).size).toBe(2);
    expect(Math.abs(a.seq - b.seq)).toBe(1);
  });
});

describe("idempotency must not disarm DR-01 (chapter 2.3)", () => {
  it("a keyless send still fails loudly on a sequence collision", async () => {
    const channel = await repoA.createChannel("dr01-guard", "public");
    const guard = (await repoA.createUser("dr01-guard-sender", "Sender")).id;
    await repoA.sendMessage(channel.id, { text: "first", userId: guard });
    // Rewind the counter so the next keyless send reuses seq 1. The
    // conflict clause must NOT swallow this: DR-01's unique constraint is
    // 2.2's safety net, and idempotency has no business disarming it.
    await db.execute(
      sql`UPDATE channels SET last_sequence = 0 WHERE id = ${channel.id}`,
    );
    await expect(
      repoA.sendMessage(channel.id, { text: "collides", userId: guard }),
    ).rejects.toThrow();
    // And nothing landed: the failed insert wrote no row.
    const rows = await repoA.listMessagesRaw(channel.id);
    expect(rows).toHaveLength(1);
  });
});

// ── A PRIVATE CHANNEL IS PRIVATE (chapter 3.15, FR-001, FR-CHN-05) ────────────
//
// `channels.type` has been a `"public" | "private"` column with a CHECK since
// chapter 2.1, and until this chapter nothing DECIDED on it. It was selected and
// returned by the create route, so it was read; no conditional anywhere branched
// on it. Chapter 3.12's fifth analysis pass caught `POST /v1/channels` about to
// accept `private` while that was still true.
//
// THESE CHANNELS ARE CREATED THROUGH THE REPOSITORY, not the API, and the reason
// is FR-009's ordering: `POST /v1/channels` accepts `private` only once the read
// paths and the send path enforce it, which is the end of the next phase.
// `createChannel(externalId, type, …)` has always taken a type.
//
// AND THE REFUSAL IS THE NOT-FOUND ERROR, not a 403. SC-002 requires send's
// answer for a private channel the caller cannot see to be byte-identical to a
// channel that does not exist, and `ChannelNotFoundError` is what the absent
// channel throws. A `403 not_a_member` would announce that the channel exists.
describe("a private channel refuses a non-member's send (FR-001)", () => {
  it("refuses a user of the tenant who is not a member, as if the channel were absent", async () => {
    const channel = await repoA.createChannel("private-send", "private");
    const stranger = await repoA.createUser("stranger", "A Stranger");

    // The same error an absent channel raises, which is the whole property.
    const absent = "00000000-0000-4000-8000-000000000000";
    const forAbsent = await repoA
      .sendMessage(absent, { userId: stranger.id, text: "nowhere" })
      .catch((error: unknown) => error);
    const forPrivate = await repoA
      .sendMessage(channel.id, { userId: stranger.id, text: "not mine" })
      .catch((error: unknown) => error);

    expect(forPrivate).toBeInstanceOf(Error);
    expect((forPrivate as Error).constructor).toBe(
      (forAbsent as Error).constructor,
    );
  });

  it("leaves the channel's message count unchanged after the refusal (SC-003)", async () => {
    // A refusal that still writes a row is not a refusal, and the status code
    // cannot tell you which one you have — only the rows can.
    const channel = await repoA.createChannel("private-count", "private");
    const stranger = await repoA.createUser("count-stranger", "Counter");
    const before = await repoA.listMessagesRaw(channel.id);

    await expect(
      repoA.sendMessage(channel.id, { userId: stranger.id, text: "should not land" }),
    ).rejects.toThrow();

    const after = await repoA.listMessagesRaw(channel.id);
    expect(after).toHaveLength(before.length);
  });

  it("accepts a member's send to the same channel", async () => {
    // The control. Two refusals for unrelated reasons are also indistinguishable,
    // which is what chapter 3.12's fourteen passing tests turned out to be
    // measuring — so the attacker has to be shown working before its failure
    // means anything.
    const channel = await repoA.createChannel("private-member", "private");
    const member = await repoA.createUser("member", "A Member");
    expect(await repoA.addMember(channel.id, member.id)).toBe("added");

    const sent = await repoA.sendMessage(channel.id, {
      userId: member.id,
      text: "mine to send",
    });
    expect(sent.seq).toBe(1);
  });

  it("accepts an application credential with no user (FR-005)", async () => {
    // `userId` absent means the TENANT is sending: it acts for the customer,
    // carries no user, and is the customer's own server. FR-005 asked for this to
    // be stated rather than assumed, and the assumption is that a private channel
    // is not private FROM ITS OWNER.
    const channel = await repoA.createChannel("private-app", "private");
    // A BOT, AND THAT IS THE WHOLE POINT NOW (chapter 3.17, FR-019a). This test is the
    // repository-level twin of `messages.itest.ts`'s "accepts an application key's send
    // to the same private channel". Before this chapter the send carried no user at all
    // and skipped the membership check for that reason; now the check is gated on the
    // sender being a PERSON, so a bot still gets through and a non-member person still
    // does not. Give it a person here and the test inverts into its own opposite.
    //
    // `createUser` cannot set `kind` — that is `upsertUser`'s job from Phase 3 — so the
    // promotion is a raw UPDATE, which is also the only writer that can satisfy
    // `users_bot_description_check` in one statement.
    const bot = (await repoA.createUser("private-app-bot", "Tenant Bot")).id;
    await db.execute(
      sql`UPDATE users SET kind = 'bot', description = 'posts on the tenant''s behalf'
          WHERE id = ${bot}`,
    );
    const sent = await repoA.sendMessage(channel.id, {
      text: "from the tenant",
      userId: bot,
    });
    expect(sent.seq).toBe(1);
  });

  it("does not check membership on a public channel", async () => {
    // FR-004's answer for the other type: any authenticated user of the tenant may
    // send to a public channel without being a member. The column becomes live
    // only because the two types differ — require membership for both and
    // `channels.type` still decides nothing.
    const channel = await repoA.createChannel("public-send", "public");
    const outsider = await repoA.createUser("public-outsider", "Outsider");
    const sent = await repoA.sendMessage(channel.id, {
      userId: outsider.id,
      text: "public is open",
    });
    expect(sent.seq).toBe(1);
  });
});

// ── THE ROLE CHECK IS IN THE DATABASE, NOT ONLY AT THE EDGE ───────────────────
//
// Chapter 3.15, T068. `channels.itest.ts` proves the zod enum refuses `admin` at
// the boundary. That is the wrong layer to trust: R8's trap is a CONSTRAINT that
// reused the organisation's vocabulary — `memberships.role` is
// `('owner','admin','member')`, one word apart from FR-CHN-04's three — and such a
// constraint would accept `admin`, refuse `moderator`, and read as correct in
// review.
//
// So this drives the repository, past the schema, and asserts the database says no.
describe("members_role_check names the channel's three (FR-011, R8)", () => {
  it("refuses `admin` — the organisation's word — at the database", async () => {
    const channel = await repoA.createChannel("role-check", "public");
    const user = await repoA.createUser("role-check-user");
    expect(await repoA.addMember(channel.id, user.id)).toBe("added");

    // The constraint name is in the CAUSE, not the message: drizzle's top-level
    // text is "Failed query: update …" and the driver's error underneath it carries
    // `constraint`. Asserting on the wrapper's message would have passed for any
    // failed update at all — including one that failed for the wrong reason.
    const error = await repoA
      .setMemberRole(channel.id, user.id, "admin")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const chain = JSON.stringify({
      message: (error as Error).message,
      cause: String((error as { cause?: unknown }).cause ?? ""),
      constraint: ((error as { cause?: { constraint?: string } }).cause ?? {})
        .constraint,
    });
    expect(chain).toContain("members_role_check");
  });

  it("accepts `moderator`, which the organisation's constraint would refuse", async () => {
    // The other half of the same trap, and the one that makes the test above mean
    // something: a constraint that refused BOTH words would pass the assertion
    // above while being just as wrong.
    const channel = await repoA.createChannel("role-check-ok", "public");
    const user = await repoA.createUser("role-check-ok-user");
    await repoA.addMember(channel.id, user.id);

    expect(await repoA.setMemberRole(channel.id, user.id, "moderator")).toBe("set");
    expect(await repoA.memberRole(channel.id, user.id)).toBe("moderator");
  });

  it("gives a member created without a role the column's default", async () => {
    const channel = await repoA.createChannel("role-default", "public");
    const user = await repoA.createUser("role-default-user");
    await repoA.addMember(channel.id, user.id);
    expect(await repoA.memberRole(channel.id, user.id)).toBe("member");
  });

  it("gives a member created WITH a role that role (FR-011b)", async () => {
    const channel = await repoA.createChannel("role-at-insert", "public");
    const user = await repoA.createUser("role-at-insert-user");
    await repoA.addMember(channel.id, user.id, "owner");
    expect(await repoA.memberRole(channel.id, user.id)).toBe("owner");
  });
});

// ── T113: THE TIE AT A PAGE BOUNDARY (chapter 3.15, FR-013) ───────────────────
//
// HERE AND NOT IN `users.itest.ts`, because constructing the tie takes a raw UPDATE:
// `last_activity_at` is written from the message's `created_at`, `now()` is the
// transaction timestamp, and every send is its own transaction — so two channels
// cannot be made to share the value through the API. This suite is on the
// driver-exempt list (the layer under test IS the query layer); the route suite is
// not, and adding a setter to the repository so it could reach one would have put a
// method in production code whose only caller is a test.
describe("the listing's keyset survives a shared last_activity_at (chapter 3.15)", () => {
  it("returns each tied channel exactly once across pages", async () => {
    const user = await repoA.createUser("tie-lister", "Tie Lister");
    const shared = new Date("2026-08-20T12:00:00.000Z");
    const ids: string[] = [];
    for (const label of ["tie-a", "tie-b", "tie-c"]) {
      const c = await repoA.createChannel(label, "public");
      await repoA.addMember(c.id, user.id);
      ids.push(c.id);
    }
    // All three at the same instant, to the millisecond.
    await db.execute(
      sql`UPDATE channels SET last_activity_at = ${shared} WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );

    const seen: string[] = [];
    let after: { activityAt: Date; id: string } | undefined;
    for (let page = 0; page < 6; page++) {
      const { rows, nextCursor } = await repoA.listChannelsForUser(user.id, {
        limit: 1,
        ...(after === undefined ? {} : { after }),
      });
      seen.push(...rows.map((r) => r.external_id));
      if (nextCursor === null) break;
      after = nextCursor;
    }

    // THREE ROWS, ONCE EACH. A keyset on the timestamp alone would either skip the
    // second tied row (using `<`) or return the first one for ever (using `<=`);
    // both failures are invisible without a tie in the fixture.
    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(new Set(["tie-a", "tie-b", "tie-c"]));
  });

  it("orders tied channels by id descending, so the order is total", async () => {
    const user = await repoA.createUser("tie-order", "Tie Order");
    const shared = new Date("2026-08-19T12:00:00.000Z");
    const made: string[] = [];
    for (const label of ["order-a", "order-b"]) {
      const c = await repoA.createChannel(label, "public");
      await repoA.addMember(c.id, user.id);
      made.push(c.id);
    }
    await db.execute(
      sql`UPDATE channels SET last_activity_at = ${shared} WHERE id IN (${sql.join(
        made.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
    const { rows } = await repoA.listChannelsForUser(user.id, { limit: 10 });
    const tied = rows.filter((r) => r.external_id.startsWith("order-"));
    // Whichever uuid sorts higher comes first — the point is that SOME total order
    // exists and the query commits to it, not which id wins.
    const expected = [...made].sort().reverse();
    expect(tied.map((r) => r.id)).toEqual(expected);
  });
});

// ── THE TOMBSTONE, AND THE CLAMP (chapter 3.15, FR-016, FR-019) ───────────────
//
// THE TOMBSTONES BELOW ARE STILL PLANTED BY HAND, and that is now a choice rather than a
// necessity. These tests were written in chapter 3.15 against a state the platform could
// not produce: FR-MSG-08 was unimplemented, `messages.deleted_at` and a null `text` were
// in the schema, `backfill.controller` passed `text` straight through so a null already
// reached the wire, and **nothing in the platform wrote either**. The comment here said
// so, in the present tense.
//
// **CHAPTER 3.23 BUILT THE WRITER** (`repository.deleteMessage`, FR-006 (3.23)), so the
// sentence stopped being true — the class of decay this repository keeps paying for, and
// the reason `specs/041-chapter-3-23/check-prose.py` fails on the old wording. What that
// chapter did NOT do is rewrite these tests to use the writer: a hand-planted fixture and
// a written one are two different subjects, and 3.23's own `deleteMessage` tests assert
// that the two agree column for column. Changing these would have moved both halves of
// the pair and left nothing comparing them.
//
// The clamp's fixture below is still genuinely unreachable through the API.
//
// The listing's rule was implemented and tested here before its writer existed, which
// 3.15 said was so that "the day FR-MSG-08's chapter ships, the count and the preview
// already agree." They did.
describe("the listing's tombstone rule and its clamp (chapter 3.15)", () => {
  it("reports a tombstoned last message with a null text, and still counts it", async () => {
    const user = await repoA.createUser("tomb-reader", "Tomb Reader");
    const channel = await repoA.createChannel("tombstoned", "public");
    await repoA.addMember(channel.id, user.id);
    await repoA.sendMessage(channel.id, { text: "kept", userId: user.id });
    const last = await repoA.sendMessage(channel.id, { text: "doomed", userId: user.id });

    // What FR-MSG-08 will do when it exists.
    await db.execute(
      sql`UPDATE messages SET text = NULL, deleted_at = now() WHERE id = ${last.id}`,
    );

    const { rows } = await repoA.listChannelsForUser(user.id, { limit: 10 });
    const row = rows.find((r) => r.external_id === "tombstoned")!;

    // THE ROW AT `last_sequence`, NOT THE LAST ROW WITH TEXT. Walking back would be a
    // second query per channel and would disagree with the count beside it.
    expect(row.last_message?.sequence).toBe(last.seq);
    expect(row.last_message?.text).toBeNull();
    expect(row.last_message?.user).not.toBeNull();

    // AND THE APPROXIMATION FR-016 REQUIRES BE STATED (T124): a deleted message still
    // counts as one unread, because a tombstone keeps its sequence and therefore its
    // place in the arithmetic. Counting rows instead would make a deleted message stop
    // being unread, at 10x the cost on the query a client runs to render its first
    // screen.
    expect(row.unread).toBe(2);
  });

  // ── T009 (chapter 3.23): THE READER, TESTED BEFORE THE WRITER EXISTS ────────
  //
  // FR-011 (3.23) and SC-003 (3.23). The history read must return a tombstone in its
  // original position so a client sees no gap in the ordering.
  //
  // **THIS PASSES AGAINST UNCHANGED CODE, AND THAT IS THE POINT.** `listMessages` has
  // never had a predicate on `messages.text` — its three `.where` clauses are the
  // channel-visibility predicate and the sequence bounds — and `messages.service`
  // maps the rows through unmodified. So the repair path chapter 3.23's resume
  // decision depends on already works, and nothing had ever said so.
  //
  // Chapter 3.15 wrote the same test for the channel LISTING and said why: *"so the
  // day FR-MSG-08's chapter ships, the count and the preview already agree."* History
  // never got one. A test written after the writer proves the writer; this one proves
  // the reader was already right.
  it("returns a tombstone in its original position, with the run unbroken (FR-011 (3.23), SC-003 (3.23))", async () => {
    const user = await repoA.createUser("hist-tomb", "History Tombstone");
    const channel = await repoA.createChannel("hist-tombstoned", "public");
    await repoA.addMember(channel.id, user.id);
    const first = await repoA.sendMessage(channel.id, { text: "one", userId: user.id });
    const middle = await repoA.sendMessage(channel.id, { text: "two", userId: user.id });
    const last = await repoA.sendMessage(channel.id, { text: "three", userId: user.id });

    // What FR-MSG-08's chapter will do when it exists — planted by hand because this
    // suite may hold raw SQL and nothing in the platform writes either column yet.
    await db.execute(
      sql`UPDATE messages SET text = NULL, deleted_at = now() WHERE id = ${middle.id}`,
    );

    // BOTH DIRECTIONS, AND THE FALSIFICATION IS WHY. `listMessages` is a ternary over
    // two entirely separate queries — one ordered `desc` for a backward page, one `asc`
    // for a forward one — and the first version of this test called it with no cursor,
    // which takes the backward branch alone. Adding `isNotNull(messages.text)` to the
    // FORWARD branch then left it green. **A test that covers one of two query branches
    // passes with half its subject applied**, which is chapter 3.17's T047c in a
    // different file.
    const backward = await repoA.listMessages(channel.id, { userId: user.id, limit: 10 });
    const forward = await repoA.listMessages(channel.id, {
      userId: user.id,
      limit: 10,
      afterSeq: 0,
    });

    for (const [label, page] of [
      ["backward", backward],
      ["forward", forward],
    ] as const) {
      const seqs = page.map((m) => m.seq).sort((a, b) => a - b);

      // THREE ROWS, NOT TWO. A read that filtered the tombstone would return two and
      // leave a hole at `middle.seq` that no client could explain.
      expect(seqs, label).toEqual([first.seq, middle.seq, last.seq]);

      const tomb = page.find((m) => m.seq === middle.seq)!;
      expect(tomb.text, label).toBeNull();
      // The author survives, which is half of what FR-MSG-08 asks the tombstone to keep.
      expect(tomb.user, label).not.toBeNull();

      // AND THE RUN IS CONTIGUOUS, asserted rather than eyeballed: consecutive sequence
      // numbers with no step, which is what "without gaps in ordering" means.
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]! - seqs[i - 1]!, label).toBe(1);
      }
    }
  });

  it("reports null for a channel that has never had a message", async () => {
    const user = await repoA.createUser("empty-reader", "Empty Reader");
    const channel = await repoA.createChannel("never-used", "public");
    await repoA.addMember(channel.id, user.id);
    const { rows } = await repoA.listChannelsForUser(user.id, { limit: 10 });
    const row = rows.find((r) => r.external_id === "never-used")!;
    // DISTINCT FROM A TOMBSTONE. `last_sequence` is 0, no row carries sequence 0, so the
    // subquery finds nothing — where a tombstone IS a row and reports itself with a null
    // text. A client can tell "no messages" from "the last one was deleted".
    expect(row.last_message).toBeNull();
    expect(row.unread).toBe(0);
  });

  // ── T127: the clamp's arm ───────────────────────────────────────────────────
  it("clamps a read position above the channel's end to zero rather than negative", async () => {
    const user = await repoA.createUser("clamp-reader", "Clamp Reader");
    const channel = await repoA.createChannel("clamped", "public");
    await repoA.addMember(channel.id, user.id);
    await repoA.sendMessage(channel.id, { text: "one", userId: user.id });

    // `setReadPosition` REFUSES THIS, which is why the arm needs planting. The clamp is
    // defence against a bug — a position past `last_sequence` cannot be written and
    // `last_sequence` never goes backwards — so this is the only way the branch is ever
    // covered. Chapter 3.12 found three instruments that had never produced output for
    // exactly this reason.
    expect(await repoA.setReadPosition(channel.id, user.id, 99)).toBeNull();
    await db.execute(
      sql`INSERT INTO read_positions (environment_id, channel_id, user_id, sequence)
          SELECT environment_id, ${channel.id}, ${user.id}, 99 FROM channels WHERE id = ${channel.id}
          ON CONFLICT (channel_id, user_id) DO UPDATE SET sequence = 99`,
    );

    const { rows } = await repoA.listChannelsForUser(user.id, { limit: 10 });
    expect(rows.find((r) => r.external_id === "clamped")!.unread).toBe(0);
  });
});

// ── THE ARMS THE ROUTES CANNOT REACH (chapter 3.15, T174a, T174b) ─────────────
//
// Every one of these is a repository function answering "no" to something its own route
// answers first. `deleteUser` on an id that does not exist, `updateUserProfile` on a
// deleted row, an upsert that creates without a display name — the service layer 404s or
// validates ahead of each, so the arm is unreachable THROUGH the API and perfectly
// reachable one layer down.
//
// IN-PROCESS ON PURPOSE (T174b). Five of this feature's tests drive new repository code
// through the gateway's api CHILD PROCESS, whose coverage is not attributable. Chapter 3.5
// added six operations to this file the same way and branches went 85.91% → 78.22% on the
// next run: the instrument was right and the code was untested.
describe("the repository's own refusals (chapter 3.15)", () => {
  it("returns false when deleting a user that does not exist", async () => {
    expect(await repoA.deleteUser("00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("returns null when patching a deleted user's profile", async () => {
    const doomed = await repoA.createUser("arm-patch-deleted", "Doomed");
    await repoA.deleteUser(doomed.id);
    // The route answers 404 before reaching this, because `requireUser` reads the marker.
    // One layer down, the `isNull(deletedAt)` in the WHERE is what refuses.
    expect(await repoA.updateUserProfile(doomed.id, { display_name: "nope" })).toBeNull();
    // And the same for an empty patch, which takes the other branch entirely — no UPDATE
    // is issued, so the refusal comes from the SELECT.
    expect(await repoA.updateUserProfile(doomed.id, {})).toBeNull();
  });

  it("returns null for an empty patch on a user that does not exist", async () => {
    expect(
      await repoA.updateUserProfile("00000000-0000-4000-8000-000000000001", {}),
    ).toBeNull();
  });

  it("creates through the upsert with no profile fields at all", async () => {
    const { user, status } = await repoA.upsertUser("arm-bare-upsert", {});
    expect(status).toBe("created");
    expect(user.display_name).toBeNull();
    expect(user.avatar_url).toBeNull();
    expect(user.metadata).toEqual({});
  });

  it("updates an avatar through the upsert", async () => {
    await repoA.upsertUser("arm-avatar", { display_name: "First" });
    const { user, status } = await repoA.upsertUser("arm-avatar", {
      avatar_url: "https://cdn.example.com/arm.png",
    });
    expect(status).toBe("updated");
    expect(user.avatar_url).toBe("https://cdn.example.com/arm.png");
    // The name the entry omitted is untouched, which is the other side of the same branch.
    expect(user.display_name).toBe("First");
  });

  it("reports a last message with no author as null", async () => {
    // AN UNATTRIBUTED MESSAGE, which is what a key-authenticated REST send writes — no
    // `userId`, by design since chapter 3.3. The listing's `last_message.user` is then
    // null, and that arm has no route that can reach it: every send through the public
    // channel route now carries a user, and the internal one resolves theirs.
    const reader = await repoA.createUser("arm-no-author", "Reader");
    const channel = await repoA.createChannel("arm-unattributed", "public");
    await repoA.addMember(channel.id, reader.id);
    // PLANTED, BECAUSE NOTHING CAN WRITE ONE ANY MORE (chapter 3.17, T014a, FR-014).
    //
    // The subject of this test IS a senderless row, so the repository can no longer
    // produce its own fixture: `sendMessage` requires a sender as of FR-MSG-15, which
    // is exactly the guarantee this arm exists to describe the other side of. The row
    // is inserted directly, the way chapter 3.12's read-position clamp is planted a few
    // hundred lines above — the only way a branch that no writer can reach is covered.
    //
    // THE ARM IS NOT DEAD, AND ITS SUBJECT HAS CHANGED (chapter 3.17, T055, FR-014).
    //
    // Chapter 3.16 wrote this arm for a state the public route produced on every
    // key-authenticated send. It now covers LEGACY ROWS ONLY: 121,250 of the 394,808
    // messages in this lane have no sender (T050), and any deployment older than this
    // chapter has them, but nothing can make another. R8 said re-examine rather than
    // delete, and re-examining is what changes here — the assertion is the same and the
    // reason for it is not.
    //
    // A test whose subject changed and whose comment did not is how a reader concludes
    // the behaviour is still reachable from the outside.
    await db.execute(
      sql`INSERT INTO messages (id, channel_id, sequence, text, created_at)
          VALUES (gen_random_uuid(), ${channel.id}, 1, 'from the tenant, not a user', now())`,
    );
    await db.execute(
      sql`UPDATE channels SET last_sequence = 1, last_activity_at = now()
          WHERE id = ${channel.id}`,
    );

    const { rows } = await repoA.listChannelsForUser(reader.id, { limit: 10 });
    const row = rows.find((r) => r.external_id === "arm-unattributed")!;
    expect(row.last_message?.text).toBe("from the tenant, not a user");
    expect(row.last_message?.user).toBeNull();
  });
});


// ══ EDITING A MESSAGE (chapter 3.23, US1) ═══════════════════════════════════
describe("editMessage (chapter 3.23)", () => {
  it("keeps the sequence, the channel, the author and the creation time (FR-002)", async () => {
    // A THING NOT DONE LEAVES NO TRACE TO ASSERT ON, so this asserts the VALUES rather
    // than the absence of an assignment. `editMessage`'s `SET` list is the guarantee —
    // `sequence`, `channelId`, `userId` and `createdAt` are not in it — and this is
    // what would notice if one arrived.
    const author = await repoA.createUser("t027-author", "Author");
    const channel = await repoA.createChannel("t027", "public");
    await repoA.addMember(channel.id, author.id);
    const before = await repoA.sendMessage(channel.id, {
      text: "frist",
      userId: author.id,
      userExternalId: "t027-author",
    });

    const after = await repoA.editMessage(channel.id, before.id, {
      text: "first",
      userId: author.id,
    });

    expect(after.text).toBe("first");
    expect(after.seq).toBe(before.seq);
    expect(after.channel_id).toBe(before.channel_id);
    expect(after.created_at).toBe(before.created_at);
    expect(after.prior_text).toBe("frist");
    // AND FROM THE DATABASE, not only from the return value. A method that returned
    // the right object while writing something else would pass everything above.
    const [row] = (
      await db.execute<{ sequence: string; user_id: string; created_at: Date }>(
        sql`SELECT sequence, user_id, created_at FROM messages WHERE id = ${before.id}`,
      )
    ).rows;
    expect(Number(row!.sequence)).toBe(before.seq);
    expect(row!.user_id).toBe(author.id);
    expect(new Date(row!.created_at).toISOString()).toBe(before.created_at);
  });

  it("records edited_at, and it was null before (FR-003)", async () => {
    const author = await repoA.createUser("t027b-author", "Author");
    const channel = await repoA.createChannel("t027b", "public");
    await repoA.addMember(channel.id, author.id);
    const sent = await repoA.sendMessage(channel.id, { text: "x", userId: author.id });

    const [pre] = (
      await db.execute<{ edited_at: Date | null }>(
        sql`SELECT edited_at FROM messages WHERE id = ${sent.id}`,
      )
    ).rows;
    expect(pre!.edited_at).toBeNull();

    const edited = await repoA.editMessage(channel.id, sent.id, {
      text: "y",
      userId: author.id,
    });
    expect(Date.parse(edited.edited_at)).toBeGreaterThan(0);
    // DISTINGUISHABLE FROM `created_at`, which is what FR-003 asks for. Two columns
    // holding one instant would satisfy "records when it happened" and answer nothing.
    expect(edited.edited_at).not.toBe(edited.created_at);
  });

  it("three edits leave three history rows, oldest first, none overwritten (FR-004)", async () => {
    const author = await repoA.createUser("t028-author", "Author");
    const channel = await repoA.createChannel("t028", "public");
    await repoA.addMember(channel.id, author.id);
    const sent = await repoA.sendMessage(channel.id, { text: "one", userId: author.id });

    for (const text of ["two", "three", "four"]) {
      await repoA.editMessage(channel.id, sent.id, { text, userId: author.id });
    }

    const edits = await repoA.listMessageEdits(channel.id, sent.id);
    // THE SUPERSEDED TEXTS, NOT THE CURRENT ONES. Three edits from "one" leave
    // "one", "two", "three" behind and the message says "four".
    expect(edits.map((e) => e.prior_text)).toEqual(["one", "two", "three"]);
    // OLDEST FIRST, asserted as monotonic timestamps rather than trusting the order
    // the array arrived in — `orderBy` is the claim under test.
    for (let i = 1; i < edits.length; i += 1) {
      expect(Date.parse(edits[i]!.edited_at)).toBeGreaterThanOrEqual(
        Date.parse(edits[i - 1]!.edited_at),
      );
    }
    const [{ text }] = (
      await db.execute<{ text: string }>(
        sql`SELECT text FROM messages WHERE id = ${sent.id}`,
      )
    ).rows as [{ text: string }];
    expect(text).toBe("four");
  });

  it("an edit does not move the channel in the activity ordering (FR-015)", async () => {
    // Two channels, one edited afterwards. The listing orders by most recent activity
    // and FR-014 (3.15) decided what that means: a message. Correcting a typo is not a
    // new message, so the order must not change.
    const user = await repoA.createUser("t034-user", "User");
    const older = await repoA.createChannel("t034-older", "public");
    const newer = await repoA.createChannel("t034-newer", "public");
    await repoA.addMember(older.id, user.id);
    await repoA.addMember(newer.id, user.id);
    const inOlder = await repoA.sendMessage(older.id, { text: "first", userId: user.id });
    await repoA.sendMessage(newer.id, { text: "second", userId: user.id });

    const listing = async () =>
      (await repoA.listChannelsForUser(user.id, { limit: 50 })).rows.map((c) => c.id);
    const orderBefore = await listing();
    expect(orderBefore.indexOf(newer.id)).toBeLessThan(orderBefore.indexOf(older.id));

    await repoA.editMessage(older.id, inOlder.id, { text: "corrected", userId: user.id });

    const orderAfter = await listing();
    expect(orderAfter).toEqual(orderBefore);
  });

  it("an edit on a row with no author is refused (FR-018)", async () => {
    // PLANTED WITH RAW SQL, because no write path can produce one any more — chapter
    // 3.17 made `userId` required — and 121,250 of them exist in the lane, written
    // before chapter 2.6 recorded a sender.
    const author = await repoA.createUser("t036-author", "Author");
    const channel = await repoA.createChannel("t036", "public");
    await repoA.addMember(channel.id, author.id);
    const sent = await repoA.sendMessage(channel.id, { text: "orphan", userId: author.id });
    await db.execute(sql`UPDATE messages SET user_id = NULL WHERE id = ${sent.id}`);

    await expect(
      repoA.editMessage(channel.id, sent.id, { text: "adopted", userId: author.id }),
    ).rejects.toThrow(NotMessageAuthorError);
    // NOBODY CAN EDIT IT, which is the requirement — not "the wrong person cannot".
    // There is no caller for whom the authorship comparison passes.
    const [{ text }] = (
      await db.execute<{ text: string }>(
        sql`SELECT text FROM messages WHERE id = ${sent.id}`,
      )
    ).rows as [{ text: string }];
    expect(text).toBe("orphan");
  });

  it("refuses a message id that belongs to another channel of the same tenant", async () => {
    const author = await repoA.createUser("t026-cross", "Author");
    const here = await repoA.createChannel("t026-here", "public");
    const there = await repoA.createChannel("t026-there", "public");
    const sent = await repoA.sendMessage(there.id, { text: "over there", userId: author.id });
    await expect(
      repoA.editMessage(here.id, sent.id, { text: "moved", userId: author.id }),
    ).rejects.toThrow(MessageNotFoundError);
  });

  it("refuses a message of another TENANT, through the same error", async () => {
    // Constitution I. The repository scopes by construction, so this is a
    // MessageNotFoundError and not a leak with a different name.
    const author = await repoA.createUser("t026-mine", "Author");
    const mine = await repoA.createChannel("t026-mine", "public");
    const sent = await repoA.sendMessage(mine.id, { text: "mine", userId: author.id });
    await expect(
      repoB.editMessage(mine.id, sent.id, { text: "theirs", userId: author.id }),
    ).rejects.toThrow(MessageNotFoundError);
  });

  it("refuses an edit on a tombstone (FR-010), and the guard is what stops a 500", async () => {
    // THE IMPLEMENTATION SHIPS IN PHASE 5 THOUGH T044 OWNS THE ROUTE TEST, because
    // `prior_text TEXT NOT NULL` makes the alternative a constraint violation: without
    // this check the insert writes a null and the caller gets a 500 it cannot act on.
    const author = await repoA.createUser("t026-tomb", "Author");
    const channel = await repoA.createChannel("t026-tomb", "public");
    const sent = await repoA.sendMessage(channel.id, { text: "gone", userId: author.id });
    await db.execute(
      sql`UPDATE messages SET text = NULL, deleted_at = now() WHERE id = ${sent.id}`,
    );
    await expect(
      repoA.editMessage(channel.id, sent.id, { text: "back", userId: author.id }),
    ).rejects.toThrow(MessageDeletedError);
    // AND NO HISTORY ROW WAS WRITTEN. A refusal that had already inserted would leave
    // the table holding an entry for an edit that never happened.
    expect(await repoA.listMessageEdits(channel.id, sent.id)).toEqual([]);
  });

  it("the history survives its channel being archived and its author deleted", async () => {
    const author = await repoA.createUser("t036b-author", "Author");
    const channel = await repoA.createChannel("t036b", "public");
    await repoA.addMember(channel.id, author.id);
    const sent = await repoA.sendMessage(channel.id, { text: "before", userId: author.id });
    await repoA.editMessage(channel.id, sent.id, { text: "after", userId: author.id });

    await repoA.archiveChannel(channel.id);
    await repoA.deleteUser(author.id);

    // `message_edits` references the MESSAGE, and both of those operations keep their
    // rows — the archive sets a timestamp (FR-020 (3.15)) and a user deletion is a
    // tombstone too (FR-USR-05). A cascade on either would take the history with it.
    const edits = await repoA.listMessageEdits(channel.id, sent.id);
    expect(edits.map((e) => e.prior_text)).toEqual(["before"]);
  });

  it("lists no edits for a message never edited, for one that does not exist, and for another tenant's", async () => {
    // TWO FACTS, ONE VALUE, which is why the route asks `messageExistsIn` separately.
    const author = await repoA.createUser("t033f-author", "Author");
    const channel = await repoA.createChannel("t033f", "public");
    const sent = await repoA.sendMessage(channel.id, { text: "untouched", userId: author.id });
    expect(await repoA.listMessageEdits(channel.id, sent.id)).toEqual([]);
    expect(await repoA.listMessageEdits(channel.id, randomUUID())).toEqual([]);
    expect(await repoA.messageExistsIn(channel.id, sent.id)).toBe(true);
    expect(await repoA.messageExistsIn(channel.id, randomUUID())).toBe(false);
    // AND THE TENANT SCOPE IS ON BOTH READS.
    expect(await repoB.messageExistsIn(channel.id, sent.id)).toBe(false);
    expect(await repoB.listMessageEdits(channel.id, sent.id)).toEqual([]);
  });
});


// ══ DELETING A MESSAGE (chapter 3.23, US2) ══════════════════════════════════
describe("deleteMessage (chapter 3.23)", () => {
  /** The columns as the database holds them, read raw. Every assertion below is about
   * what COMMITTED rather than what the method returned — a method that returned the
   * right object and wrote something else would pass a return-value test. */
  const rowOf = async (id: string) => {
    const res = (await db.execute<{
      text: string | null;
      attachments: unknown;
      deleted_at: Date | null;
      sequence: string;
      user_id: string | null;
      created_at: Date;
      metadata: Record<string, unknown>;
    }>(
      sql`SELECT text, attachments, deleted_at, sequence, user_id, created_at, metadata
            FROM messages WHERE id = ${id}`,
    )).rows;
    return res[0]!;
  };

  it("keeps the sequence, author and created_at; drops text and attachments (FR-006)", async () => {
    // THE COLUMNS ARE `docs/05-sad.md:342`'s, and this is the first tombstone the
    // PLATFORM writes. Chapter 3.15's suite plants one by hand a few describes above,
    // and the two agree column for column — which is what makes that chapter's reader
    // tests evidence about this chapter's writer.
    const author = await repoA.createUser("t040-author", "Author");
    const channel = await repoA.createChannel("t040", "public");
    await repoA.addMember(channel.id, author.id);
    const sent = await repoA.sendMessage(channel.id, {
      text: "regrettable",
      userId: author.id,
      userExternalId: "t040-author",
    });
    const before = await rowOf(sent.id);

    const { deleted, alreadyDeleted } = await repoA.deleteMessage(channel.id, sent.id, {
      userId: author.id,
      userExternalId: "t040-author",
    });
    expect(alreadyDeleted).toBe(false);
    expect(deleted.text).toBeNull();

    const after = await rowOf(sent.id);
    expect(after.text).toBeNull();
    expect(after.attachments).toBeNull();
    expect(after.deleted_at).not.toBeNull();
    // UNTOUCHED, and asserted as values rather than as the absence of an assignment.
    expect(after.sequence).toBe(before.sequence);
    expect(after.user_id).toBe(author.id);
    expect(new Date(after.created_at).toISOString()).toBe(
      new Date(before.created_at).toISOString(),
    );
  });

  it("records WHO deleted it, in two shapes, without erasing a key already in metadata (FR-006a)", async () => {
    // **THIS CHAPTER IS `messages.metadata`'S FIRST WRITER ANYWHERE.** Every row in the
    // platform carries the `'{}'` default today, which is why the merge below matters:
    // a later chapter's key must survive a deletion.
    const author = await repoA.createUser("t040b-author", "Author");
    const channel = await repoA.createChannel("t040b", "public");
    await repoA.addMember(channel.id, author.id);

    const byAuthor = await repoA.sendMessage(channel.id, {
      text: "mine to remove",
      userId: author.id,
      userExternalId: "t040b-author",
      metadata: { source: "a key a later chapter writes" },
    });
    await repoA.deleteMessage(channel.id, byAuthor.id, {
      userId: author.id,
      userExternalId: "t040b-author",
    });
    const asUser = await rowOf(byAuthor.id);
    expect(asUser.metadata["deleted_by"]).toEqual({
      kind: "user",
      user: "t040b-author",
    });
    // MERGED, NOT REPLACED. The pre-existing key is still there.
    expect(asUser.metadata["source"]).toBe("a key a later chapter writes");

    // A TENANT KEY: the kind is recorded and there is no user, because an application
    // principal has no user of its own. WHICH credential it presented is an audit log's
    // question — chapter 3.23's `gaps.md` item 2 draws that line.
    const byKey = await repoA.sendMessage(channel.id, {
      text: "moderated away",
      userId: author.id,
      userExternalId: "t040b-author",
    });
    await repoA.deleteMessage(channel.id, byKey.id, {});
    expect((await rowOf(byKey.id)).metadata["deleted_by"]).toEqual({
      kind: "application",
    });
  });

  it("a second deletion changes nothing and writes no second event (FR-009)", async () => {
    const author = await repoA.createUser("t042-author", "Author");
    const channel = await repoA.createChannel("t042", "public");
    await repoA.addMember(channel.id, author.id);
    const sent = await repoA.sendMessage(channel.id, {
      text: "twice",
      userId: author.id,
      userExternalId: "t042-author",
    });

    const first = await repoA.deleteMessage(channel.id, sent.id, {
      userId: author.id,
      userExternalId: "t042-author",
    });
    const afterFirst = await rowOf(sent.id);

    const second = await repoA.deleteMessage(channel.id, sent.id, {
      userId: author.id,
      userExternalId: "t042-author",
    });
    const afterSecond = await rowOf(sent.id);

    expect(first.alreadyDeleted).toBe(false);
    expect(second.alreadyDeleted).toBe(true);
    // THE TIMESTAMP IS THE COLUMN THAT WOULD MOVE, and a client that had already read
    // the tombstone would see it change for no reason.
    expect(afterSecond.deleted_at).toEqual(afterFirst.deleted_at);
    expect(second.deleted.deleted_at).toBe(first.deleted.deleted_at);

    // ONE EVENT. Two 204s prove nothing; this is the assertion that carries FR-009,
    // because a second row here fires every subscribed webhook a second time.
    const events = (await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbox
            WHERE payload->>'type' = 'message.deleted'
              AND payload->'data'->>'id' = ${sent.id}`,
    )).rows;
    expect(events[0]!.n).toBe(1);
  });

  it("a deletion of a row with no author is refused (FR-018)", async () => {
    // FR-018 says "an edit OR deletion" and the first draft of the task list tested only
    // the edit. **The deletion is the half a tenant API key can reach** — FR-012 lets a
    // key delete anybody's message — so it is the more exposed one, and it is checked
    // before the tenant shortcut rather than inside the user branch.
    const author = await repoA.createUser("t042a-author", "Author");
    const channel = await repoA.createChannel("t042a", "public");
    const sent = await repoA.sendMessage(channel.id, { text: "orphan", userId: author.id });
    await db.execute(sql`UPDATE messages SET user_id = NULL WHERE id = ${sent.id}`);

    // Neither principal can delete it: not the user…
    await expect(
      repoA.deleteMessage(channel.id, sent.id, {
        userId: author.id,
        userExternalId: "t042a-author",
      }),
    ).rejects.toThrow(NotMessageAuthorError);
    // …and not the tenant key, which is the half FR-012 would otherwise wave through.
    await expect(repoA.deleteMessage(channel.id, sent.id, {})).rejects.toThrow(
      NotMessageAuthorError,
    );
    expect((await rowOf(sent.id)).text).toBe("orphan");
  });

  it("a deleted message still counts as one unread", async () => {
    // Chapter 3.15 decided this against a planted tombstone and stated the
    // approximation: unread is `last_sequence - read_position`, so a tombstone keeps its
    // sequence and therefore its place in the arithmetic. Counting rows instead would
    // make a deleted message stop being unread, at 10x the cost on the query a client
    // runs to render its first screen. **Same assertion, real writer.**
    const user = await repoA.createUser("t048-user", "User");
    const channel = await repoA.createChannel("t048", "public");
    await repoA.addMember(channel.id, user.id);
    await repoA.sendMessage(channel.id, { text: "one", userId: user.id });
    const second = await repoA.sendMessage(channel.id, { text: "two", userId: user.id });
    await repoA.deleteMessage(channel.id, second.id, { userId: user.id });

    const { rows } = await repoA.listChannelsForUser(user.id, { limit: 50 });
    const row = rows.find((c) => c.id === channel.id)!;
    expect(row.unread).toBe(2);
  });

  it("deleting the NEWEST message leaves the preview at that sequence with a null text", async () => {
    // Not "the message before it". The listing's preview is the channel's last message
    // and a tombstone is still the last message — reporting the previous one would make
    // a deletion look like the conversation had rewound.
    const user = await repoA.createUser("t049-user", "User");
    const channel = await repoA.createChannel("t049", "public");
    await repoA.addMember(channel.id, user.id);
    await repoA.sendMessage(channel.id, { text: "older", userId: user.id });
    const newest = await repoA.sendMessage(channel.id, { text: "newest", userId: user.id });
    await repoA.deleteMessage(channel.id, newest.id, { userId: user.id });

    const { rows } = await repoA.listChannelsForUser(user.id, { limit: 50 });
    const row = rows.find((c) => c.id === channel.id)!;
    expect(row.last_message?.sequence).toBe(newest.seq);
    expect(row.last_message?.text).toBeNull();
    expect(row.last_message?.user).not.toBeNull();
  });

  it("history returns the tombstone in its original position, with a real writer behind it", async () => {
    // The twin of T009's test a few describes above, which proved the READER against a
    // hand-planted tombstone. This proves the reader and the WRITER agree — the thing
    // that would break is a writer whose columns differ from what that test planted.
    const user = await repoA.createUser("t047-user", "User");
    const channel = await repoA.createChannel("t047", "public");
    await repoA.addMember(channel.id, user.id);
    const first = await repoA.sendMessage(channel.id, { text: "one", userId: user.id });
    const middle = await repoA.sendMessage(channel.id, { text: "two", userId: user.id });
    const last = await repoA.sendMessage(channel.id, { text: "three", userId: user.id });
    await repoA.deleteMessage(channel.id, middle.id, { userId: user.id });

    for (const [label, page] of [
      ["backward", await repoA.listMessages(channel.id, { userId: user.id, limit: 10 })],
      [
        "forward",
        await repoA.listMessages(channel.id, { userId: user.id, limit: 10, afterSeq: 0 }),
      ],
    ] as const) {
      const seqs = page.map((m) => m.seq).sort((a, b) => a - b);
      expect(seqs, label).toEqual([first.seq, middle.seq, last.seq]);
      const tomb = page.find((m) => m.seq === middle.seq)!;
      expect(tomb.text, label).toBeNull();
      expect(tomb.user, label).not.toBeNull();
    }
  });

  it("refuses a message of another TENANT and one from another channel", async () => {
    const author = await repoA.createUser("t039-author", "Author");
    const here = await repoA.createChannel("t039-here", "public");
    const there = await repoA.createChannel("t039-there", "public");
    const sent = await repoA.sendMessage(there.id, { text: "over there", userId: author.id });
    await expect(
      repoA.deleteMessage(here.id, sent.id, { userId: author.id }),
    ).rejects.toThrow(MessageNotFoundError);
    await expect(
      repoB.deleteMessage(there.id, sent.id, { userId: author.id }),
    ).rejects.toThrow(MessageNotFoundError);
  });
});

// T004 (3.24) — THE READER TEST, RUN AGAINST UNCHANGED CODE.
//
// FR-019 (3.24) decides that an attachments-only message stores `text = ""` rather than
// a null, so chapter 3.23's tombstone predicate is untouched. That decision rests on a
// claim about code this chapter has not written yet: every read path already treats an
// empty string as a live message. **This test must pass today.** If it fails, the
// decision is wrong and the plan changes before a line of production code exists.
//
// Chapter 3.23 ran the equivalent and it paid twice: it proved the read path was already
// correct, and it stopped a later phase from "fixing" something that worked.
//
// The row is planted with raw SQL because no write path accepts an empty text yet — the
// send schema is `z.string().min(1)` at both doors until phase 4. `attachments` is left
// NULL, which is a VALID value (data-model.md: NULL and `[]` are different and NULL means
// no attachments): the read paths do not re-validate, so a malformed array planted here
// would surface as a 1011 socket close in some later phase rather than as a failure here.
describe("an empty text is a live message on every read path (T004, FR-019 (3.24))", () => {
  it("reads back as live through history both ways, the listing's preview, and the tombstone predicate", async () => {
    const user = await repoA.createUser("t004-reader", "Reader");
    const channel = await repoA.createChannel("t004", "public");
    await repoA.addMember(channel.id, user.id);
    const before = await repoA.sendMessage(channel.id, { text: "has words", userId: user.id });

    // The row this chapter's phase 4 will make sendable. `sequence` continues the
    // channel's series by hand, which is what makes this a reader test and not a
    // writer one: the writer is not involved and must not be.
    const plantedId = randomUUID();
    await db.execute(sql`
      INSERT INTO messages (id, channel_id, sequence, user_id, text, attachments, created_at)
      VALUES (${plantedId}, ${channel.id}, ${before.seq + 1}, ${user.id}, '', NULL, now())
    `);
    // The listing reads `channels.last_sequence`, not the messages table (chapter 3.15's
    // keyset), so a hand-planted row is invisible to the preview until this moves.
    await db.execute(
      sql`UPDATE channels SET last_sequence = ${before.seq + 1}, last_activity_at = now()
          WHERE id = ${channel.id}`,
    );

    // 1 and 2 — history, both directions. `afterSeq: 0` is the forward page; its absence
    // is the backward one. Both, because they are two queries in `listMessages` and a
    // single-direction test cannot tell which one it proved.
    for (const [label, page] of [
      ["backward", await repoA.listMessages(channel.id, { userId: user.id, limit: 10 })],
      [
        "forward",
        await repoA.listMessages(channel.id, { userId: user.id, limit: 10, afterSeq: 0 }),
      ],
    ] as const) {
      const planted = page.find((m) => m.id === plantedId);
      expect(planted, label).toBeDefined();
      // `toBe("")` and not a falsy check. `expect(planted!.text).toBeFalsy()` would pass
      // on a null too, which is the exact distinction this test exists to make.
      expect(planted!.text, label).toBe("");
      expect(planted!.text, label).not.toBeNull();
    }

    // 3 — the channel listing's preview. It shows what was said, and what was said here
    // is nothing; the point is that it is not read as a deletion.
    const { rows } = await repoA.listChannelsForUser(user.id, { limit: 10 });
    const row = rows.find((r) => r.external_id === "t004")!;
    expect(row.last_message?.sequence).toBe(before.seq + 1);
    expect(row.last_message?.text).toBe("");
    expect(row.last_message?.text).not.toBeNull();

    // 4 — the tombstone predicate does not fire. `editMessage` and `deleteMessage` both
    // read the row and throw `MessageDeletedError` on `text === null`; an empty string
    // must reach neither. The edit is the sharper of the two because it PROVES the row
    // was writable, not merely that a refusal was skipped.
    const edited = await repoA.editMessage(channel.id, plantedId, {
      userId: user.id,
      text: "words now",
    });
    expect(edited.text).toBe("words now");

    // And the same row, deleted, still becomes a tombstone the normal way — so the
    // empty string is not a state the delete path mishandles either.
    await repoA.deleteMessage(channel.id, plantedId, { userId: user.id });
    const after = await repoA.listMessages(channel.id, { userId: user.id, limit: 10 });
    expect(after.find((m) => m.id === plantedId)!.text).toBeNull();
  });
});

// T023 and T024 (chapter 3.24). THE WRITER, AND THE EMPTY TEXT IT NOW ACCEPTS.
//
// T004 above proved the READ paths already treat `text = ''` as live, against a row
// planted by hand. These two prove the WRITE path produces such a row and that the
// round trip keeps what it was given, in the order it was given.
describe("sendMessage writes attachments (T023, FR-001 (3.24), FR-006 (3.24))", () => {
  const url = (name: string) => ({
    type: "url" as const,
    kind: "image" as const,
    url: `https://example.test/${name}.png`,
  });

  it("keeps two attachments in the order they were sent, through the round trip", async () => {
    const user = await repoA.createUser("t023-sender", "Sender");
    const channel = await repoA.createChannel("t023", "public");
    await repoA.addMember(channel.id, user.id);

    // TWO, AND IN A DELIBERATE ORDER. One attachment cannot show an order at all, and
    // FR-006 says order holds on every path that returns a message — so a
    // single-attachment test would assert the easy half of the requirement.
    const sent = await repoA.sendMessage(channel.id, {
      text: "two pictures",
      userId: user.id,
      attachments: [url("first"), url("second")],
    });

    // THE COLUMN, BECAUSE THE READ PATH IS NOT WIDENED UNTIL PHASE 5. `listMessages`
    // returns `attachments: []` from phase 3's placeholder until T028 adds the column to
    // its select, so asserting through it here would assert the next phase's work and
    // fail for a reason that has nothing to do with the writer.
    const { rows } = await db.execute(
      sql`SELECT attachments FROM messages WHERE id = ${sent.id}`,
    );
    const stored = rows[0]!["attachments"] as Array<{ url: string }>;
    expect(stored.map((a) => a.url)).toEqual([
      "https://example.test/first.png",
      "https://example.test/second.png",
    ]);
  });

  it("stores NULL rather than an empty array when there are none", async () => {
    const user = await repoA.createUser("t023-none", "None");
    const channel = await repoA.createChannel("t023-none", "public");
    await repoA.addMember(channel.id, user.id);
    const sent = await repoA.sendMessage(channel.id, { text: "no pictures", userId: user.id });

    // THE COLUMN, NOT THE READ. `data-model.md` decides that NULL and `[]` are different
    // values and that a message with no attachments stores NULL; every read converts to
    // `[]` on the way out (FR-007), so a read-side assertion cannot tell them apart.
    const { rows } = await db.execute(
      sql`SELECT attachments FROM messages WHERE id = ${sent.id}`,
    );
    expect(rows[0]!["attachments"]).toBeNull();

    // And the read is `[]` — which in this phase proves nothing, because phase 3's
    // placeholder returns `[]` for every message. T029 in phase 5 is where that
    // assertion starts meaning something.
    const page = await repoA.listMessages(channel.id, { userId: user.id, limit: 10 });
    expect(page.find((m) => m.id === sent.id)!.attachments).toEqual([]);
  });

  it("stores the same url twice as two attachments (FR-021 (3.24))", async () => {
    const user = await repoA.createUser("t023-dup", "Dup");
    const channel = await repoA.createChannel("t023-dup", "public");
    await repoA.addMember(channel.id, user.id);
    const sent = await repoA.sendMessage(channel.id, {
      text: "the same link twice",
      userId: user.id,
      attachments: [url("same"), url("same")],
    });
    const { rows } = await db.execute(
      sql`SELECT attachments FROM messages WHERE id = ${sent.id}`,
    );
    expect(rows[0]!["attachments"]).toHaveLength(2);
  });
});

describe("an attachments-only message is written and is not a tombstone (T024, FR-019 (3.24))", () => {
  it("stores text = '' and reads back live, with the deletion path still available", async () => {
    const user = await repoA.createUser("t024-sender", "Sender");
    const channel = await repoA.createChannel("t024", "public");
    await repoA.addMember(channel.id, user.id);

    const sent = await repoA.sendMessage(channel.id, {
      text: "",
      userId: user.id,
      attachments: [{ type: "url", kind: "image", url: "https://example.test/only.png" }],
    });

    // THE COLUMN IS `''` AND NOT NULL, which is the whole of FR-019a. A null here would
    // make chapter 3.23's tombstone predicate fire on a message somebody just sent.
    const { rows } = await db.execute(sql`SELECT text FROM messages WHERE id = ${sent.id}`);
    expect(rows[0]!["text"]).toBe("");
    expect(rows[0]!["text"]).not.toBeNull();

    // Live on the read paths, and its attachment is in the column. The read path's own
    // list is phase 5's (T028); what this phase can assert is that the row exists, is
    // live, and holds what it was given.
    const page = await repoA.listMessages(channel.id, { userId: user.id, limit: 10 });
    expect(page.find((m) => m.id === sent.id)!.text).toBe("");
    const { rows: stored } = await db.execute(
      sql`SELECT attachments FROM messages WHERE id = ${sent.id}`,
    );
    expect(stored[0]!["attachments"]).toHaveLength(1);

    // AND THE TOMBSTONE PREDICATE DOES NOT FIRE. `editMessage` and `deleteMessage` both
    // throw `MessageDeletedError` on `text === null`; an edit succeeding is the stronger
    // of the two, because it proves the row was writable rather than that a refusal was
    // skipped.
    const edited = await repoA.editMessage(channel.id, sent.id, {
      userId: user.id,
      text: "a caption after all",
    });
    expect(edited.text).toBe("a caption after all");

    await repoA.deleteMessage(channel.id, sent.id, { userId: user.id });
    const after = await repoA.listMessages(channel.id, { userId: user.id, limit: 10 });
    const tomb = after.find((m) => m.id === sent.id)!;
    expect(tomb.text).toBeNull();
    // FR-012: deletion unlinks them, asserted at the column for the same reason as above.
    const { rows: gone } = await db.execute(
      sql`SELECT attachments FROM messages WHERE id = ${sent.id}`,
    );
    expect(gone[0]!["attachments"]).toBeNull();
  });
});

// T030a (chapter 3.24). BOTH BRANCHES OF `listMessages`, WHICH IS A TERNARY.
//
// `listMessages` is not one query with a direction flag — it is a conditional over two
// separate builder chains, one ordered `desc` for a backward page and one `asc` for a
// forward one, and `attachments` had to be added to the column list they share. A
// single-direction test covers one branch and reports on both.
describe("listMessages returns attachments on BOTH branches (T030a, FR-009 (3.24))", () => {
  it("carries them in order through the backward page and the forward one", async () => {
    const user = await repoA.createUser("t030a-user", "User");
    const channel = await repoA.createChannel("t030a", "public");
    await repoA.addMember(channel.id, user.id);
    const sent = await repoA.sendMessage(channel.id, {
      text: "two pictures",
      userId: user.id,
      attachments: [
        { type: "url", kind: "image", url: "https://example.test/a.png" },
        { type: "url", kind: "audio", url: "https://example.test/b.mp3" },
      ],
    });

    for (const [label, page] of [
      ["backward", await repoA.listMessages(channel.id, { userId: user.id, limit: 10 })],
      [
        "forward",
        await repoA.listMessages(channel.id, { userId: user.id, limit: 10, afterSeq: 0 }),
      ],
    ] as const) {
      const read = page.find((m) => m.id === sent.id)!;
      expect(
        read.attachments.map((a) => (a.type === "url" ? a.url : "media")),
        label,
      ).toEqual(["https://example.test/a.png", "https://example.test/b.mp3"]);
    }
  });

  it("returns [] and not null on both branches for a message with none (FR-007 (3.24))", async () => {
    const user = await repoA.createUser("t030a-none", "None");
    const channel = await repoA.createChannel("t030a-none", "public");
    await repoA.addMember(channel.id, user.id);
    const sent = await repoA.sendMessage(channel.id, { text: "no pictures", userId: user.id });
    for (const [label, page] of [
      ["backward", await repoA.listMessages(channel.id, { userId: user.id, limit: 10 })],
      [
        "forward",
        await repoA.listMessages(channel.id, { userId: user.id, limit: 10, afterSeq: 0 }),
      ],
    ] as const) {
      const read = page.find((m) => m.id === sent.id)!;
      // `toHaveProperty` rather than `toEqual([])`: an absent key satisfies the latter
      // when the value is undefined, which is how a control test passes before its field
      // exists.
      expect(read, label).toHaveProperty("attachments", []);
    }
  });
});

// T053 (chapter 3.24). THE READ SHAPES THAT DO NOT CHANGE, ASSERTED.
//
// `data-model.md` names six read shapes and two of them gained the column. The plan said
// four would not change; it is THREE, because `editMessage`'s internal read gained it at
// phase 7 for FR-015 — the edit event must carry the attachments the message already has,
// and that read is the only thing that holds them. Phase 3 predicted this at the site and
// T053 says to re-check against the tree rather than copy the list forward.
//
// A RECORD SAYS "DECIDED"; ONLY AN ASSERTION TELLS THE NEXT READER THAT FROM "FORGOTTEN".
// Chapter 3.23 left four sentences that had stopped being true because nothing compared
// them with the code.
describe("the read shapes that do NOT carry attachments (T053, FR-009 (3.24))", () => {
  it("the channel listing's preview has no attachments field", async () => {
    const user = await repoA.createUser("t053-user", "User");
    const channel = await repoA.createChannel("t053", "public");
    await repoA.addMember(channel.id, user.id);
    await repoA.sendMessage(channel.id, {
      text: "with a picture",
      userId: user.id,
      attachments: [{ type: "url", kind: "image", url: "https://example.test/preview.png" }],
    });

    const { rows } = await repoA.listChannelsForUser(user.id, { limit: 10 });
    const row = rows.find((r) => r.external_id === "t053")!;
    // A PREVIEW SHOWS WHAT WAS SAID. FR-CHN-09 asks for the most recent message rather
    // than its contents, and a listing that carried every message's attachment list would
    // pay for them on a query a client runs to render its first screen.
    expect(row.last_message).not.toBeNull();
    expect(row.last_message).not.toHaveProperty("attachments");
  });

  it("listMessagesRaw returns three columns and none of them is attachments", async () => {
    const user = await repoA.createUser("t053-raw", "Raw");
    const channel = await repoA.createChannel("t053-raw", "public");
    await repoA.addMember(channel.id, user.id);
    await repoA.sendMessage(channel.id, {
      text: "with a picture",
      userId: user.id,
      attachments: [{ type: "url", kind: "image", url: "https://example.test/raw.png" }],
    });

    const rows = await repoA.listMessagesRaw(channel.id);
    // A TEST-ONLY HELPER WITH FIVE CALL SITES, all in `idempotency.itest.ts`, which count
    // rows and read text. An exact key set rather than a negative check: this is what
    // stops the helper growing a column nobody asked for.
    expect(Object.keys(rows[0]!).sort()).toEqual(["id", "seq", "text"]);
  });
});
