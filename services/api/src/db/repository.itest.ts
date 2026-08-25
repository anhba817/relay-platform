import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDb, createPool, DEFAULT_DATABASE_URL, type Db } from "./client";
import { migrate } from "./migrate";
import { createEnvironment, Repository, type Environment } from "./repository";

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
// BOTH STATES ARE UNREACHABLE THROUGH THE API, for different reasons, and both are
// constructed here because this suite may hold raw SQL.
//
// FR-MSG-08 — "deleting a message shall replace its content with a tombstone retaining
// sequence number, author, timestamps" — IS NOT IMPLEMENTED. `messages.deleted_at` and a
// null `text` are in the schema, `backfill.controller` passes `text` straight through so
// a null already reaches the wire, and NOTHING IN THE PLATFORM WRITES EITHER. The
// tombstone is a live reader with no writer, which is the reverse of the dead columns
// this feature is otherwise about. The listing's rule for it is implemented and tested
// now so the day FR-MSG-08's chapter ships, the count and the preview already agree.
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
