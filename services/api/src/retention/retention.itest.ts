import "reflect-metadata";

import { beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import {
  createEnvironment,
  recordMediaVerdict,
  Repository,
  setRetentionPolicy,
} from "../db/repository";
import { expiringFlag } from "../db/retention-reads";
import { sweepRetention } from "./sweep";

// CHAPTER 4.20 — the messages that expire.
//
// THIS FILE OPENED AS A RED PROBE AND WAS INVERTED IN THE SAME CHAPTER. Before `0024`
// and `0025` the first test asserted that a hard deletion is REFUSED and it passed:
// `message_edits_message_id_fkey` refused the parent and `message_edits_append_only`
// refused the children. The migrations landed, the probe went red with *"the delete was
// not refused at all"*, and the assertion below is its inverse. A probe that was never
// green proves nothing about the fix.
//
// NOTHING HERE IS THIRTY DAYS OLD. The oldest message on this lane is 2026-09-14 and
// FR-MOD-06's shortest policy is thirty days, so every fixture below is backdated —
// **each to its own instant**, because chapter 4.13's sweep fixture stepped by a second
// and piled 3,235 rows onto one, which turned twelve tests red in milliseconds on a
// developer host and never once in CI.
describe("retention", () => {
  let db: Db;
  let environmentId: string;
  let repo: Repository;
  let channelId: string;
  let authorId: string;

  beforeAll(async () => {
    const pool = createPool();
    await migrate(pool);
    db = createDb(pool);

    const env = await createEnvironment(db, { name: "retention" });
    environmentId = env.id;
    repo = new Repository(db, environmentId, {
      kind: "application",
      id: "retention-suite",
      requestId: crypto.randomUUID(),
    });
    authorId = (await repo.createUser("retention-author", "Author")).id;
    channelId = (await repo.createChannel("retention", "public")).id;
    await repo.addMember(channelId, authorId);
  });

  /** A message, optionally edited so it owns a version row, backdated to its own
   * instant so no two fixtures share one. */
  const aged = async (
    text: string,
    daysOld: number,
    { edited = false }: { edited?: boolean } = {},
  ): Promise<string> => {
    const { id } = await repo.sendMessage(channelId, { text, userId: authorId });
    if (edited) {
      await repo.editMessage(channelId, id, { text: `${text} (edited)`, userId: authorId });
    }
    await repo.backdateMessageRaw(id, daysOld);
    return id;
  };

  const survives = async (id: string): Promise<boolean> =>
    (await repo.listMessagesRaw(channelId)).some((m) => m.id === id);

  it("destroys an expired message AND the version rows it owns (FR-001, FR-002)", async () => {
    // THE INVERSE OF THE PROBE THIS FILE OPENED WITH. The same call, the same shape of
    // message — one that owns a `message_edits` row — and before `0025` it threw.
    const id = await aged("expired, and edited once", 91, { edited: true });

    expect(await repo.versionRowCountRaw(id)).toBe(1);
    expect(await repo.destroyMessages([id])).toBe(1);

    expect(await survives(id)).toBe(false);
    // THE CASCADE, WHICH IS THE HALF THE FOREIGN KEY ALONE COULD NOT DO. A version row
    // must not outlive its message, and after `0025` the schema is what enforces that
    // rather than an ordered two-step delete in application code.
    expect(await repo.versionRowCountRaw(id)).toBe(0);
  });

  it("the trigger still refuses everything it refused before (ADR-36)", async () => {
    // THE EXCEPTION IS ONE VERB ON ONE TABLE AND THIS IS WHAT SAYS SO. Reading the new
    // condition is not testing it: 4.18's rule is that a mechanism that fits the tool
    // is not a mechanism that works, and the second has to be attempted.
    const id = await aged("edited, and its history is still immutable", 91, {
      edited: true,
    });

    // An UPDATE, with the flag irrelevant — `TG_OP = 'DELETE'` is part of the
    // condition precisely so that expiry destroys rows and never rewrites one.
    await expect(repo.tamperVersionRowRaw(id)).rejects.toThrow();
    // And a DELETE of the child with no flag set.
    await expect(repo.deleteVersionRowsRaw(id)).rejects.toThrow();
  });

  it("destroys one day past the policy and spares one day inside it (FR-005)", async () => {
    // BOTH SIDES, because a sweep that destroys everything passes a one-sided test.
    await setRetentionPolicy(db, environmentId, 30);
    const past = await aged("31 days old", 31);
    const inside = await aged("29 days old", 29);

    await sweepRetention(db, new Date(), { environmentId });

    expect(await survives(past)).toBe(false);
    expect(await survives(inside)).toBe(true);
  });

  it("an environment with NO policy loses nothing at any age (FR-004)", async () => {
    const other = await createEnvironment(db, { name: "retention-no-policy" });
    const otherRepo = new Repository(db, other.id, {
      kind: "application",
      id: "retention-suite",
      requestId: crypto.randomUUID(),
    });
    const user = await otherRepo.createUser("no-policy-author", "Author");
    const otherChannel = await otherRepo.createChannel("no-policy", "public");
    await otherRepo.addMember(otherChannel.id, user.id);
    const { id } = await otherRepo.sendMessage(otherChannel.id, {
      text: "a year old and indefinite",
      userId: user.id,
    });
    await otherRepo.backdateMessageRaw(id, 400);

    // COUNTED ABSOLUTELY, BEFORE AND AFTER, rather than as a delta. 0 -> 0 is satisfied
    // by the sweep not running at all, which is the thing this test must not accept.
    const before = (await otherRepo.listMessagesRaw(otherChannel.id)).length;
    expect(before).toBeGreaterThan(0);

    await sweepRetention(db, new Date());

    expect((await otherRepo.listMessagesRaw(otherChannel.id)).length).toBe(before);
  });

  it("holds `relay.expiring` for one transaction and leaves nothing on the pool", async () => {
    // THE WHOLE GUARANTEE IS THE WORD `LOCAL`, AND BOTH WAYS OF GETTING IT WRONG ARE
    // SILENT. Without it the flag outlives its transaction on a pooled connection and
    // every later request can delete version rows. With it but outside a transaction
    // block, Postgres emits a WARNING, the flag is never set, and every cascade is
    // refused in a way indistinguishable from the trigger working.
    //
    // So this asserts the VALUE rather than the statement, on both sides of a real
    // destroy. The destroy itself proves the flag reached the trigger — a message that
    // owns a version row cannot be deleted otherwise — and the reads prove it did not
    // escape the transaction that set it.
    expect(await expiringFlag(db)).not.toBe("on");

    const id = await aged("the flag must not outlive this", 91, { edited: true });
    expect(await repo.destroyMessages([id])).toBe(1);

    expect(await expiringFlag(db)).not.toBe("on");
  });

  /** A reserved, ready media object owned by this environment. */
  const anObject = async (
    name: string,
    { withRendition = false }: { withRendition?: boolean } = {},
  ): Promise<string> => {
    const id = crypto.randomUUID();
    await repo.reserveMediaSlot({
      id,
      userId: authorId,
      filename: `${name}.png`,
      mimeType: "image/png",
      declaredBytes: 1024,
      objectKey: `${environmentId}/${id}`,
    });
    await recordMediaVerdict(db, {
      id,
      verdict: "ready",
      verifiedBytes: 1024,
      verifiedType: "image/png",
      width: 640,
      height: 480,
      ...(withRendition
        ? {
            rendition: {
              id: crypto.randomUUID(),
              kind: "thumbnail",
              objectKey: `${environmentId}/${id}/thumb`,
              bytes: 2048,
              width: 320,
              height: 240,
            },
          }
        : {}),
    });
    return id;
  };

  const attach = async (
    text: string,
    mediaId: string,
    daysOld: number,
  ): Promise<string> => {
    const { id } = await repo.sendMessage(channelId, {
      text,
      userId: authorId,
      attachments: [{ type: "media", media_id: mediaId }],
    });
    await repo.backdateMessageRaw(id, daysOld);
    return id;
  };

  it("destroys a sole-referenced object and SPARES a shared one (FR-006, FR-MED-11)", async () => {
    await setRetentionPolicy(db, environmentId, 30);
    const sole = await anObject("sole");
    const shared = await anObject("shared");
    await attach("expired, sole attachment", sole, 40);
    await attach("expired, shared attachment", shared, 41);
    // THE SURVIVOR IS WHAT MAKES THIS TWO-SIDED. FR-MSG-11 has allowed the same
    // `media_id` in two messages since chapter 3.24, so *unless shared* is a real case
    // rather than a defensive one — and a sweep that destroyed this object would take
    // an attachment out of a message nobody asked to expire.
    await attach("still inside the policy, same object", shared, 5);

    const [counts] = await sweepRetention(db, new Date(), { environmentId });

    expect(await repo.mediaObjectExistsRaw(sole)).toBe(false);
    expect(await repo.mediaObjectExistsRaw(shared)).toBe(true);
    expect(counts?.objectsDestroyed).toBe(1);
    expect(counts?.objectsKeptAsShared).toBe(1);
  });

  it("a rendition goes with its parent, and the schema is what does it (FR-007)", async () => {
    await setRetentionPolicy(db, environmentId, 30);
    const parent = await anObject("with-thumb", { withRendition: true });
    await attach("expired, and it has a thumbnail", parent, 50);

    // CHAPTER 4.15 GAVE A RENDITION'S REACHABILITY TO `media_objects_parent_fk` WITH
    // `ON DELETE CASCADE`, so this should need no code at all — which is a thing to RUN
    // rather than to reason about. If the cascade were ever changed, the only symptom
    // would be an orphaned thumbnail nobody can reach and nobody is billed for.
    expect(await repo.renditionCountRaw(parent)).toBe(1);

    await sweepRetention(db, new Date(), { environmentId });

    expect(await repo.mediaObjectExistsRaw(parent)).toBe(false);
    expect(await repo.renditionCountRaw(parent)).toBe(0);
  });

  it("is re-runnable: the second run finds nothing the first left (FR-008)", async () => {
    await setRetentionPolicy(db, environmentId, 30);
    await aged("idempotence a", 40);
    await aged("idempotence b", 41);

    const first = await sweepRetention(db, new Date(), { environmentId });
    const firstDestroyed = first[0]?.messagesDestroyed ?? 0;
    // PIN WHAT THE FIRST RUN LEFT, not that the second changed nothing. Two zeroes
    // prove nothing: idempotence is a claim about what the second call DID.
    expect(firstDestroyed).toBeGreaterThanOrEqual(2);

    const second = await sweepRetention(db, new Date(), { environmentId });
    expect(second[0]?.messagesDestroyed ?? 0).toBe(0);

    // AND THE PREDICATE IS WHY, rather than a ledger: a destroyed message cannot match
    // the next pass, so an interrupted run needs no resume state and no lease.
    const remaining = await repo.expiredMessageIds(
      new Date(Date.now() - 30 * 86_400_000),
      10,
    );
    expect(remaining).toEqual([]);
  });
});
