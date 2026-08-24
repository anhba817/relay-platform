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
    // what chapter 3.12 changed here: the endpoint over this call has to be
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

describe("sequence assignment is serialised per channel (ADR-03)", () => {
  it("two concurrent sends never interleave", async () => {
    const channel = await repoA.createChannel("ordering", "public");
    const [a, b] = await Promise.all([
      repoA.sendMessage(channel.id, { text: "first writer" }),
      repoA.sendMessage(channel.id, { text: "second writer" }),
    ]);
    // Two sends, two DISTINCT consecutive sequence numbers — always.
    expect(new Set([a.seq, b.seq]).size).toBe(2);
    expect(Math.abs(a.seq - b.seq)).toBe(1);
  });
});

describe("idempotency must not disarm DR-01 (chapter 2.3)", () => {
  it("a keyless send still fails loudly on a sequence collision", async () => {
    const channel = await repoA.createChannel("dr01-guard", "public");
    await repoA.sendMessage(channel.id, { text: "first" });
    // Rewind the counter so the next keyless send reuses seq 1. The
    // conflict clause must NOT swallow this: DR-01's unique constraint is
    // 2.2's safety net, and idempotency has no business disarming it.
    await db.execute(
      sql`UPDATE channels SET last_sequence = 0 WHERE id = ${channel.id}`,
    );
    await expect(
      repoA.sendMessage(channel.id, { text: "collides" }),
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
    const sent = await repoA.sendMessage(channel.id, { text: "from the tenant" });
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
